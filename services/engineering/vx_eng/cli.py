"""Command line used by the orchestrator. Prints one JSON document on stdout."""
from __future__ import annotations

import argparse
import json
import shutil
import sys
import zipfile
from pathlib import Path

from . import __version__, kicad
from .circuit import Circuit, validate
from .library import Library
from .schematic import build


def _zip(project_dir: Path, name: str, files: list[str]) -> str:
    """Deterministic zip (fixed timestamps) of the editable KiCad project."""
    out = f"{name}-kicad-project.zip"
    with zipfile.ZipFile(project_dir / out, "w", zipfile.ZIP_DEFLATED) as z:
        for f in sorted(files):
            info = zipfile.ZipInfo(f"{name}/{f}", date_time=(2026, 1, 1, 0, 0, 0))
            info.external_attr = 0o644 << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, (project_dir / f).read_bytes())
    return out


def cmd_validate(spec: dict) -> dict:
    return validate(Circuit.from_json(spec), Library())


def cmd_build(spec: dict, out: Path) -> dict:
    lib = Library()
    circuit = Circuit.from_json(spec)
    v = validate(circuit, lib)
    result: dict = {"ok": False, "validation": v, "generator_version": __version__, "kicad_version": kicad.version()}
    if not v["ok"]:
        result["stage"] = "validation"
        return result
    if out.exists():
        shutil.rmtree(out)
    layout = build(circuit, lib, out)
    name = layout["project"]
    sch = f"{name}.kicad_sch"
    project_files = [f"{name}.kicad_pro", sch, "sym-lib-table", "fp-lib-table"]
    erc = kicad.erc(out, sch)
    got = kicad.netlist(out, sch)
    want = {frozenset(n) for n in circuit.connectivity()}
    missing = sorted(sorted(f"{r}.{p}" for r, p in n) for n in want - got)
    unexpected = sorted(sorted(f"{r}.{p}" for r, p in n) for n in got - want)
    exported = kicad.exports(out, sch)
    zip_name = _zip(out, name, project_files)
    (out / "erc-report.json").write_text(json.dumps(erc["report"], indent=2))
    (out / "erc.json").unlink(missing_ok=True)
    result.update({
        "stage": "built",
        "ok": erc["errors"] == 0 and not missing and not unexpected,
        "project": name,
        "sheet": layout["sheet"],
        "erc": {k: erc[k] for k in ("errors", "warnings", "violations")},
        "netlist": {"match": not missing and not unexpected, "nets": len(want), "missing": missing, "unexpected": unexpected},
        "files": {
            "project_zip": zip_name, "schematic": sch, "erc_report": "erc-report.json", "netlist": "netlist.net",
            **{k: f for k, f in (("pdf", "schematic.pdf"), ("svg", "schematic.svg"), ("bom", "bom.csv")) if f in exported},
        },
    })
    return result


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="vx_eng")
    sub = ap.add_subparsers(dest="cmd", required=True)
    v = sub.add_parser("validate", help="check a circuit design against the KiCad libraries")
    v.add_argument("--spec", required=True, help="circuit JSON file, or - for stdin")
    b = sub.add_parser("build", help="generate the KiCad project, run ERC and export drawings")
    b.add_argument("--spec", required=True)
    b.add_argument("--out", required=True)
    sub.add_parser("version")
    args = ap.parse_args(argv)
    if args.cmd == "version":
        print(json.dumps({"vx_eng": __version__, "kicad": kicad.version()}))
        return 0
    spec = json.load(sys.stdin if args.spec == "-" else open(args.spec))
    try:
        result = cmd_validate(spec) if args.cmd == "validate" else cmd_build(spec, Path(args.out))
    except kicad.KicadError as e:
        result = {"ok": False, "stage": "kicad", "error": str(e)}
    print(json.dumps(result))
    return 0
