"""Runs kicad-cli on a generated project: ERC, netlist, drawings, BOM."""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

from .sexpr import child, children, parse


class KicadError(RuntimeError):
    pass


def run(args: list[str], cwd: Path, timeout: int = 300) -> subprocess.CompletedProcess:
    p = subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=timeout)
    if p.returncode != 0:
        raise KicadError(f"{' '.join(args[:3])} failed ({p.returncode}): {(p.stderr or p.stdout).strip()[:2000]}")
    return p


def version() -> str:
    return subprocess.run(["kicad-cli", "version"], capture_output=True, text=True).stdout.strip()


def erc(project_dir: Path, sch: str) -> dict:
    """KiCad's ERC JSON report plus counts. Exit code is ignored: violations are data."""
    subprocess.run(["kicad-cli", "sch", "erc", "--format", "json", "--severity-all", "--units", "mm",
                    "-o", "erc.json", sch], cwd=project_dir, capture_output=True, text=True, timeout=300)
    path = project_dir / "erc.json"
    if not path.exists():
        raise KicadError("kicad-cli did not write an ERC report (the schematic may not load)")
    report = json.loads(path.read_text())
    violations = [v for s in report.get("sheets", []) for v in s.get("violations", [])]
    return {
        "report": report,
        "errors": sum(v.get("severity") == "error" for v in violations),
        "warnings": sum(v.get("severity") == "warning" for v in violations),
        "violations": [{
            "severity": v.get("severity"), "type": v.get("type"), "description": v.get("description"),
            "items": [i.get("description") for i in v.get("items", [])],
        } for v in violations],
    }


def netlist(project_dir: Path, sch: str) -> set[frozenset[tuple[str, str]]]:
    run(["kicad-cli", "sch", "export", "netlist", "--format", "kicadsexpr", "-o", "netlist.net", sch], cwd=project_dir)
    doc = parse((project_dir / "netlist.net").read_text())
    nets = set()
    for net in children(child(doc, "nets"), "net"):
        pins = frozenset((str(child(n, "ref")[1]), str(child(n, "pin")[1])) for n in children(net, "node"))
        if pins and not all(r.startswith("#") for r, _ in pins):
            nets.add(frozenset(p for p in pins if not p[0].startswith("#")))
    return {n for n in nets if len(n) > 1}   # KiCad also lists single-pin nets for unconnected pins


def exports(project_dir: Path, sch: str) -> list[str]:
    """PDF and SVG drawings and a BOM CSV. Returns the files written."""
    run(["kicad-cli", "sch", "export", "pdf", "-o", "schematic.pdf", sch], cwd=project_dir)
    svg_dir = project_dir / "svg"
    run(["kicad-cli", "sch", "export", "svg", "-o", "svg", sch], cwd=project_dir)
    svgs = sorted(svg_dir.glob("*.svg"))
    if svgs:
        svgs[0].replace(project_dir / "schematic.svg")
    for leftover in svg_dir.glob("*"):
        leftover.unlink()
    svg_dir.rmdir()
    run(["kicad-cli", "sch", "export", "bom", "--fields", "Reference,Value,Footprint,MPN,Manufacturer,${QUANTITY}",
         "--labels", "Refs,Value,Footprint,MPN,Manufacturer,Qty", "--group-by", "Value,Footprint,MPN",
         "-o", "bom.csv", sch], cwd=project_dir)
    return [f for f in ("schematic.pdf", "schematic.svg", "bom.csv") if (project_dir / f).exists()]
