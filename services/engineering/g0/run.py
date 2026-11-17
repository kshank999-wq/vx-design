"""Runs all G0 spikes and writes results.json + report.md to the output folder.

Usage (inside the engineering image):  python3 /opt/vx/g0/run.py --out /out
Optionally syncs results to Supabase when SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import traceback
import urllib.request
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from g0 import spikes  # noqa: E402
from g0.common import Result, SpikeFailure, Timer  # noqa: E402

# (spike, prerequisite context keys)
PLAN = [
    (spikes.schematic_generation, []),
    (spikes.headless_erc, ["schematic"]),
    (spikes.pcb_generation, ["netlist"]),
    (spikes.autoroute, ["pcb"]),
    (spikes.headless_drc, ["routed"]),
    (spikes.fab_outputs, ["routed", "schematic"]),
    (spikes.step_export, ["routed"]),
    (spikes.panelization, ["routed", "schematic"]),
    (spikes.step_import_export, ["step"]),
    (spikes.enclosure_generation, ["board_bb"]),
    (spikes.interference_check, ["enclosure"]),
    (spikes.transient_simulation, []),
    (spikes.skidl_netlist, []),
    (spikes.atopile_check, []),
    (spikes.ipc_api, []),
    (spikes.digikey_search, []),
    (spikes.mouser_search, []),
    (spikes.nexar_lookup, []),
]

NOT_COVERED = [
    ("lcsc_jlc", "parts_catalog", "Catalog download and basic/extended part mapping (P1 sourcing work)."),
    ("kicanvas", "browser_view", "Browser-side; verify in apps/web."),
    ("threejs", "step_render", "Browser-side; verify in apps/web."),
    ("flux", "project_export", "Manual: export from the Flux account and inventory the archive."),
]


def _name(fn) -> tuple[str, str]:
    probe = {
        "schematic_generation": ("kicad", "schematic_generation"), "headless_erc": ("kicad", "headless_erc"),
        "pcb_generation": ("kicad", "pcb_generation"), "autoroute": ("freerouting", "autoroute"),
        "headless_drc": ("kicad", "headless_drc"), "fab_outputs": ("kicad", "fab_outputs"),
        "step_export": ("kicad", "step_export"), "panelization": ("kikit", "panelization"),
        "step_import_export": ("cadquery", "step_import_export"),
        "enclosure_generation": ("cadquery", "enclosure_generation"),
        "interference_check": ("cadquery", "interference_check"),
        "transient_simulation": ("ngspice", "transient_simulation"), "skidl_netlist": ("skidl", "netlist_compile"),
        "atopile_check": ("atopile", "netlist_compile"), "ipc_api": ("kicad", "ipc_api"),
        "digikey_search": ("digikey", "product_search"), "mouser_search": ("mouser", "product_search"),
        "nexar_lookup": ("nexar", "part_lookup"),
    }
    return probe[fn.__name__]


def run_all(out: Path) -> list[Result]:
    out.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix="g0-"))
    ctx: dict = {"work": work, "out": out}
    results: list[Result] = []
    for fn, needs in PLAN:
        tool, op = _name(fn)
        missing = [k for k in needs if k not in ctx]
        print(f"[g0] {tool}.{op} ...", flush=True)
        if missing:
            r = Result(tool, op, status="untested", notes=f"Skipped: prerequisite output missing ({', '.join(missing)}).")
        else:
            with Timer() as t:
                try:
                    r = fn(ctx)
                except SpikeFailure as exc:
                    r = Result(tool, op, status="blocked", errors_seen=str(exc)[:1500],
                               notes="Ran but did not meet its acceptance check.")
                except Exception as exc:  # noqa: BLE001
                    r = Result(tool, op, status="blocked",
                               errors_seen=f"{type(exc).__name__}: {exc}\n{traceback.format_exc(limit=3)}"[:1500],
                               notes="Spike raised an unexpected error.")
            r.duration_s = round(t.elapsed, 2)
        print(f"[g0]   -> {r.status}", flush=True)
        results.append(r)
    return results


STATUS_ICON = {"verified": "verified", "partial": "partial", "blocked": "BLOCKED", "untested": "untested"}


def write_report(results: list[Result], out: Path, generated_at: str) -> None:
    lines = [
        "# G0 capability matrix",
        "",
        f"Generated {generated_at} by `services/engineering/g0/run.py` in the `vx-engineering:g0` image.",
        "Each row ran a real operation on the fixture circuit (2-pin input, AP2112K-3.3 LDO, LED) and checked a",
        "concrete acceptance condition; checks marked with a negative control were also shown to fail on bad input.",
        "",
        "| Tool | Operation | Status | Version | License |",
        "|---|---|---|---|---|",
    ]
    for r in results:
        lines.append(f"| {r.tool_name} | {r.operation} | {STATUS_ICON[r.status]} | {r.tool_version or '-'} | {r.license or '-'} |")
    for tool, op, note in NOT_COVERED:
        lines.append(f"| {tool} | {op} | not in container | - | - |")
    lines += ["", "## Details", ""]
    for r in results:
        lines.append(f"### {r.tool_name} · {r.operation} — {r.status}")
        lines.append("")
        if r.notes:
            lines.append(r.notes)
            lines.append("")
        if r.errors_seen:
            lines += ["```", r.errors_seen.strip(), "```", ""]
        if r.fallback:
            lines.append(f"Fallback: {r.fallback}")
            lines.append("")
        if r.evidence:
            lines.append("Evidence: " + ", ".join(f"`{e}`" for e in r.evidence))
            lines.append("")
    lines += ["## Not covered by this container", ""]
    lines += [f"- **{t} · {o}**: {n}" for t, o, n in NOT_COVERED]
    (out / "report.md").write_text("\n".join(lines) + "\n")


def sync_supabase(results: list[Result], generated_at: str) -> None:
    url, key = os.environ.get("SUPABASE_URL"), os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not (url and key):
        return
    rows = [{
        "tool_name": r.tool_name, "operation": r.operation, "status": r.status, "tool_version": r.tool_version,
        "deployment_mode": r.deployment_mode, "license": r.license, "commercial_ok": r.commercial_ok,
        "errors_seen": r.errors_seen, "fallback": r.fallback, "notes": r.notes,
        "sample_io_path": ", ".join(r.evidence) or None, "test_owner": "g0/run.py",
        "verified_at": generated_at if r.status in ("verified", "partial") else None,
    } for r in results]
    req = urllib.request.Request(
        f"{url.rstrip('/')}/rest/v1/tool_capabilities?on_conflict=tool_name,operation",
        data=json.dumps(rows).encode(), method="POST",
        headers={"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json",
                 "Prefer": "resolution=merge-duplicates,return=minimal"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        print(f"[g0] synced {len(rows)} rows to Supabase (HTTP {resp.status})")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, default=Path("/out"))
    args = parser.parse_args()
    generated_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    results = run_all(args.out)
    (args.out / "results.json").write_text(json.dumps(
        {"generated_at": generated_at, "results": [asdict(r) for r in results]}, indent=2))
    write_report(results, args.out, generated_at)
    sync_supabase(results, generated_at)
    counts = {s: sum(r.status == s for r in results) for s in STATUS_ICON}
    print(f"[g0] done: {counts}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
