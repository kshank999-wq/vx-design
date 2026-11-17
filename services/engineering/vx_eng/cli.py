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
from .fab import PROFILES
from .library import Library
from .pcb import HOLE_FOOTPRINTS
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


def cmd_footprints(spec: dict) -> dict:
    from .pcb import footprint_facts
    return {"ok": True, "footprints": footprint_facts(Circuit.from_json(spec)),
            "fab_profiles": {k: v.as_dict() for k, v in PROFILES.items()}, "hole_sizes": sorted(HOLE_FOOTPRINTS)}


def cmd_layout_check(spec: dict, layout_spec: dict) -> dict:
    from .pcb import Layout, check_placement
    return check_placement(Circuit.from_json(spec), Layout.from_json(layout_spec))


def cmd_layout_build(spec: dict, layout_spec: dict, out: Path, models: dict | None = None) -> dict:
    """Schematic (deterministic rebuild) + board: placement, routing, pours, DRC with parity, 3D models, exports."""
    from . import pcb
    circuit = Circuit.from_json(spec)
    layout = pcb.Layout.from_json(layout_spec)
    placement = pcb.check_placement(circuit, layout)
    result: dict = {"ok": False, "generator_version": __version__, "kicad_version": kicad.version(), "placement": placement}
    if not placement["ok"]:
        result["stage"] = "placement"
        return result
    sch = cmd_build(spec, out)
    if not sch["ok"]:
        result.update({"stage": "schematic", "schematic": {k: sch.get(k) for k in ("stage", "validation", "erc", "netlist")}})
        return result
    name = sch["project"]
    built = pcb.build_board(circuit, layout, out, name, circuit.title, models=models)
    pcb_file = f"{name}.kicad_pcb"
    report = pcb.drc(out, pcb_file)
    solid = pcb.fix_starved_thermals(out, pcb_file, report)
    if solid:
        report = pcb.drc(out, pcb_file)
    built["routing"]["solid_zone_connections"] = solid
    (out / "drc-report.json").write_text(json.dumps(report["report"], indent=2))
    (out / "drc.json").unlink(missing_ok=True)
    import pcbnew  # reload the saved board (zones filled by DRC) for facts and models
    board = pcbnew.LoadBoard(str(out / pcb_file))
    models = pcb.fetch_models(board)
    exported = pcb.exports(out, pcb_file)
    export_errors = exported.pop("_errors", None)
    project_files = [f"{name}.kicad_pro", f"{name}.kicad_sch", pcb_file, "sym-lib-table", "fp-lib-table"]
    project_files += sorted(f"3dmodels/{p.name}" for p in (out / "3dmodels").glob("*.step")) if (out / "3dmodels").exists() else []
    zip_name = _zip(out, name, project_files)
    (out / "models.json").write_text(json.dumps(models, indent=2))
    parts = [m for m in models if not m["ref"].startswith("H") or m["status"] != "none"]
    missing = [m for m in parts if m["status"] != "found"]
    problems = []
    if report["unconnected"]:
        nets = sorted({i["description"] for v in report["unconnected_items"] for i in v["items"]})[:20]
        problems.append({"code": "routing_incomplete",
                         "message": f"the autorouter left {report['unconnected']} connection(s) unrouted. Give parts more room "
                                    "(spread them out or enlarge the board) and keep connected parts close together",
                         "items": nets})
    other = [v for v in report["violations"] if v["severity"] == "error" and not v["excluded"]]
    if other:
        problems.append({"code": "drc_errors", "message": f"KiCad DRC reports {len(other)} error(s) after routing",
                         "violations": [{"type": v["type"], "description": v["description"],
                                         "items": [i["description"] for i in v["items"]]} for v in other[:30]]})
    if report["parity"]:
        problems.append({"code": "schematic_parity", "message": "the board does not match the schematic",
                         "violations": [v["description"] for v in report["schematic_parity"][:30]]})
    result.update({
        "stage": "built",
        "ok": report["errors"] == 0 and report["unconnected"] == 0 and report["parity"] == 0,
        "problems": problems,
        "project": name,
        "erc": sch["erc"], "netlist": sch["netlist"],
        "board": {**pcb.board_facts(board), "width_mm": layout.width, "height_mm": layout.height,
                  "fab_profile": built["profile"].as_dict()},
        "routing": built["routing"],
        "drc": {k: report[k] for k in ("errors", "warnings", "unconnected", "parity", "waived")} | {
            "violations": [v for v in report["violations"] if not v["excluded"]][:100]},
        "models": {"found": len(parts) - len(missing), "total": len(parts), "missing": missing, "tag": pcb._model_tag()},
        "export_errors": export_errors,
        "files": {
            "project_zip": zip_name, "drc_report": "drc-report.json", "models": "models.json",
            **{k: f for k, f in sch["files"].items() if k in ("svg", "pdf", "bom", "erc_report", "netlist")},
            **{f"pcb_{k}" if not k.startswith(("render", "step", "glb")) else k: f for k, f in exported.items()},
        },
    })
    return result


def cmd_fab_package(project: Path, out: Path, panel: bool, profile: str | None, lcsc: dict | None = None) -> dict:
    """Fab package from a G4 project (zip or directory): DRC gate, KiKit fab files, independent checks, drawings, panel."""
    import tempfile
    from . import release
    if project.is_file():
        tmp = Path(tempfile.mkdtemp(prefix="vx-fab-"))
        project = release.unzip_project(project, tmp)
    return release.build_package(project, out, panel=panel, profile_name=profile, lcsc=lcsc)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="vx_eng")
    sub = ap.add_subparsers(dest="cmd", required=True)
    v = sub.add_parser("validate", help="check a circuit design against the KiCad libraries")
    v.add_argument("--spec", required=True, help="circuit JSON file, or - for stdin")
    b = sub.add_parser("build", help="generate the KiCad project, run ERC and export drawings")
    b.add_argument("--spec", required=True)
    b.add_argument("--out", required=True)
    f = sub.add_parser("footprints", help="courtyard sizes of a circuit's footprints, fab profiles")
    f.add_argument("--spec", required=True)
    lc = sub.add_parser("layout-check", help="check a proposed board layout geometrically")
    lc.add_argument("--spec", required=True)
    lc.add_argument("--layout", required=True)
    lb = sub.add_parser("layout-build", help="build, route and check the board, export 3D and drawings")
    lb.add_argument("--spec", required=True)
    lb.add_argument("--layout", required=True)
    lb.add_argument("--out", required=True)
    lb.add_argument("--models", help="JSON file: ref -> {path, name} of verified manufacturer models (aligned STEP)")
    fp = sub.add_parser("fab-package", help="board house package from a routed KiCad project, with independent checks")
    fp.add_argument("--project", required=True, help="KiCad project zip from layout-build, or its directory")
    fp.add_argument("--out", required=True)
    fp.add_argument("--profile", choices=sorted(PROFILES), help="override the project's fab profile")
    fp.add_argument("--no-panel", action="store_true")
    fp.add_argument("--lcsc", help="JSON file mapping references to LCSC part numbers (from sourcing)")
    mc = sub.add_parser("model-check", help="align a manufacturer STEP model to a KiCad footprint and check it")
    mc.add_argument("--step", required=True, help="STEP file, or ZIP containing one")
    mc.add_argument("--footprint", required=True, help="KiCad footprint Library:Name")
    mc.add_argument("--out", required=True)
    mc.add_argument("--mechanical", help="JSON with datasheet mechanical data, e.g. {\"height_mm\": 1.1}")
    sub.add_parser("version")
    args = ap.parse_args(argv)
    if args.cmd == "version":
        print(json.dumps({"vx_eng": __version__, "kicad": kicad.version()}))
        return 0
    if args.cmd == "model-check":
        from . import modelcheck
        try:
            mech = json.loads(args.mechanical) if args.mechanical else None
            result = modelcheck.check(Path(args.step), args.footprint, Path(args.out), mech)
        except (ValueError, kicad.KicadError) as e:
            result = {"status": "check_failed", "problems": [str(e)], "warnings": []}
        except Exception as e:  # noqa: BLE001 - unreadable STEP files raise OCCT errors of many kinds
            result = {"status": "check_failed", "problems": [f"could not read the model: {type(e).__name__}: {e}"], "warnings": []}
        print(json.dumps(result))
        return 0
    if args.cmd == "fab-package":
        try:
            lcsc = json.load(open(args.lcsc)) if args.lcsc else None
            result = cmd_fab_package(Path(args.project), Path(args.out), not args.no_panel, args.profile, lcsc)
        except kicad.KicadError as e:
            result = {"ok": False, "stage": "kicad", "error": str(e)}
        print(json.dumps(result))
        return 0
    spec = json.load(sys.stdin if args.spec == "-" else open(args.spec))
    try:
        if args.cmd == "validate":
            result = cmd_validate(spec)
        elif args.cmd == "build":
            result = cmd_build(spec, Path(args.out))
        elif args.cmd == "footprints":
            result = cmd_footprints(spec)
        else:
            layout_spec = json.load(open(args.layout))
            models = json.load(open(args.models)) if getattr(args, "models", None) else None
            result = (cmd_layout_check(spec, layout_spec) if args.cmd == "layout-check"
                      else cmd_layout_build(spec, layout_spec, Path(args.out), models))
    except kicad.KicadError as e:
        result = {"ok": False, "stage": "kicad", "error": str(e)}
    print(json.dumps(result))
    return 0
