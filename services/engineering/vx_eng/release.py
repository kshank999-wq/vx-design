"""Fab package (G4.5): turns a checked KiCad board into files a board house accepts, and checks them.

  1. Gate: KiCad DRC with schematic parity must be clean on the board being released.
  2. KiKit writes the house's package: Gerbers + Excellon drill (zipped as the house expects) and,
     for houses with SMT assembly, the assembly BOM and pick-and-place (CPL) with KiKit's rotation
     corrections.
  3. The Gerbers and drill files are re-read with gerbonara, independently of KiCad: required
     layers, outline size, copper-to-edge clearance, silkscreen inside the board, hole count and
     smallest drill. The CPL is compared with the board's footprint positions; the BOM with its
     components.
  4. Assembly and drill drawings, fab notes (board spec for the order form), a 2x2 KiKit panel,
     and one package zip with a sha256 manifest.
"""
from __future__ import annotations

import csv
import hashlib
import io
import json
import subprocess
import sys
import warnings
import zipfile
from pathlib import Path
from typing import Any

from . import __version__, kicad
from .fab import PROFILES, FabProfile
from .pcb import drc

STAMP = (2026, 1, 1, 0, 0, 0)
PANEL = {
    "layout": "grid; rows: 2; cols: 2; space: 2mm",
    "tabs": "fixed; width: 3mm",
    "cuts": "mousebites; drill: 0.5mm; spacing: 1mm; offset: 0.2mm",
    "framing": "railstb; width: 5mm; space: 3mm",
    "tooling": "3hole; hoffset: 2.5mm; voffset: 2.5mm; size: 1.5mm",
    "fiducials": "3fid; hoffset: 5mm; voffset: 2.5mm; coppersize: 1mm; opening: 2mm",
}


def _run(args: list[str], cwd: Path, timeout: int = 600) -> subprocess.CompletedProcess:
    p = subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=timeout)
    if p.returncode != 0:
        raise kicad.KicadError(f"{' '.join(args[:3])} failed ({p.returncode}): {(p.stderr or p.stdout).strip()[-1500:]}")
    return p


def _problem(code: str, message: str, **extra: Any) -> dict[str, Any]:
    return {"code": code, "message": message, **extra}


def project_files(project_dir: Path) -> tuple[str, str, FabProfile]:
    """The board, schematic and fab profile (from the .kicad_pro written in G4) of a project directory."""
    pcbs = sorted(project_dir.glob("*.kicad_pcb"))
    if len(pcbs) != 1:
        raise kicad.KicadError(f"expected one .kicad_pcb in the project, found {len(pcbs)}")
    pcb = pcbs[0]
    sch = pcb.with_suffix(".kicad_sch")
    pro = pcb.with_suffix(".kicad_pro")
    name = None
    if pro.exists():
        name = (json.loads(pro.read_text()).get("vx_design") or {}).get("fab_profile")
    return pcb.name, sch.name if sch.exists() else "", PROFILES.get(name or "", PROFILES["jlcpcb-2layer-standard"])


# --- Board facts (what the files must reproduce) ---------------------------------------

def board_facts(project_dir: Path, pcb: str) -> dict[str, Any]:
    import pcbnew
    board = pcbnew.LoadBoard(str(project_dir / pcb))
    origin = board.GetDesignSettings().GetAuxOrigin()
    bb = board.GetBoardEdgesBoundingBox()
    holes = {"plated": 0, "nonplated": 0, "vias": 0}
    min_drill = None
    for fp in board.GetFootprints():
        for pad in fp.Pads():
            d = pad.GetDrillSize()
            if d.x > 0:
                holes["plated" if pad.GetAttribute() == pcbnew.PAD_ATTRIB_PTH else "nonplated"] += 1
                size = pcbnew.ToMM(min(d.x, d.y))
                min_drill = size if min_drill is None else min(min_drill, size)
    for t in board.GetTracks():
        if t.GetClass() == "PCB_VIA":
            holes["vias"] += 1
            size = pcbnew.ToMM(t.GetDrillValue())
            min_drill = size if min_drill is None else min(min_drill, size)
    parts = []
    for fp in board.GetFootprints():
        if fp.IsBoardOnly():
            continue
        pos = fp.GetPosition()
        parts.append({
            "ref": fp.GetReference(), "value": fp.GetValue(), "footprint": str(fp.GetFPID().GetUniStringLibId()),
            "x": round(pcbnew.ToMM(pos.x - origin.x), 3), "y": round(-pcbnew.ToMM(pos.y - origin.y), 3),
            "rotation": round(fp.GetOrientationDegrees() % 360, 2), "side": "bottom" if fp.IsFlipped() else "top",
            "smd": not any(p.GetAttribute() in (pcbnew.PAD_ATTRIB_PTH, pcbnew.PAD_ATTRIB_NPTH) for p in fp.Pads()),
            "dnp": fp.IsDNP(), "exclude_from_bom": fp.IsExcludedFromBOM(), "exclude_from_pos": fp.IsExcludedFromPosFiles(),
            "lcsc": next((fp.GetFieldText(f) for f in ("LCSC", "LCSC Part", "JLCPCB Part") if fp.HasField(f) and fp.GetFieldText(f)), ""),
            "mpn": fp.GetFieldText("MPN") if fp.HasField("MPN") else "",
        })
    tracks = [t for t in board.GetTracks() if t.GetClass() == "PCB_TRACK"]
    return {
        "width_mm": round(pcbnew.ToMM(bb.GetWidth()) - 0.1, 3), "height_mm": round(pcbnew.ToMM(bb.GetHeight()) - 0.1, 3),
        "copper_layers": board.GetCopperLayerCount(), "holes": holes, "min_drill_mm": min_drill,
        "min_track_mm": round(min(pcbnew.ToMM(t.GetWidth()) for t in tracks), 3) if tracks else None,
        "parts": sorted(parts, key=lambda p: p["ref"]),
    }


# --- Independent checks ------------------------------------------------------------------

def check_gerbers(gerber_zip: Path, facts: dict[str, Any], profile: FabProfile) -> dict[str, Any]:
    """Re-reads the Gerbers and drill files with gerbonara (no KiCad involved)."""
    from gerbonara import LayerStack
    from gerbonara.utils import MM

    problems: list[dict] = []
    warns: list[dict] = []
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        stack = LayerStack.open(str(gerber_zip))
    found = sorted(f"{side} {use}" for (side, use) in stack.graphic_layers)
    need = [("top", "copper"), ("bottom", "copper"), ("top", "mask"), ("bottom", "mask"), ("top", "silk")]
    for side, use in need:
        if (side, use) not in stack.graphic_layers:
            problems.append(_problem("missing_layer", f"no {side} {use} Gerber in the package"))
    inner = sorted(side for (side, use) in stack.graphic_layers if use == "copper" and side.startswith("inner"))
    if len(inner) != max(profile.layers - 2, 0):
        problems.append(_problem("inner_layers", f"the package has {len(inner)} inner copper layer(s); a {profile.layers}-layer board needs "
                                                 f"{max(profile.layers - 2, 0)}"))
    if stack.outline is None:
        problems.append(_problem("missing_layer", "no board outline (Edge.Cuts) Gerber in the package"))
        return {"ok": False, "problems": problems, "warnings": warns, "layers": found}

    (ox0, oy0), (ox1, oy1) = stack.outline.bounding_box(MM)
    w, h = round(ox1 - ox0 - 0.1, 3), round(oy1 - oy0 - 0.1, 3)    # outline drawn with a 0.1 mm line
    if abs(w - facts["width_mm"]) > 0.05 or abs(h - facts["height_mm"]) > 0.05:
        problems.append(_problem("outline_size", f"outline in the Gerbers is {w} x {h} mm; the board is "
                                                 f"{facts['width_mm']} x {facts['height_mm']} mm"))
    if min(w, h) < profile.min_board_mm or max(w, h) > profile.max_board_mm:
        problems.append(_problem("board_size", f"{w} x {h} mm is outside {profile.name}'s accepted range "
                                               f"({profile.min_board_mm}-{profile.max_board_mm} mm per side)"))
    inner = (ox0 + 0.05, oy0 + 0.05, ox1 - 0.05, oy1 - 0.05)     # inside edge of the outline line
    edge = profile.copper_edge_clearance_mm - 0.01
    for side in ("top", "bottom"):
        layer = stack.graphic_layers.get((side, "copper"))
        if layer is None or not layer.objects:
            continue
        (cx0, cy0), (cx1, cy1) = layer.bounding_box(MM)
        gap = min(cx0 - inner[0], cy0 - inner[1], inner[2] - cx1, inner[3] - cy1)
        if gap < edge:
            problems.append(_problem("copper_to_edge", f"{side} copper comes {round(gap, 3)} mm from the board edge; "
                                                       f"{profile.name} needs {profile.copper_edge_clearance_mm} mm"))
    for side in ("top", "bottom"):
        layer = stack.graphic_layers.get((side, "silk"))
        if layer is None or not layer.objects:
            continue
        (sx0, sy0), (sx1, sy1) = layer.bounding_box(MM)
        if sx0 < inner[0] - 0.01 or sy0 < inner[1] - 0.01 or sx1 > inner[2] + 0.01 or sy1 > inner[3] + 0.01:
            warns.append(_problem("silk_outside_board", f"{side} silkscreen extends past the board edge; the fab will clip it"))

    hits = {"plated": 0, "nonplated": 0}
    diameters: list[float] = []
    for d in stack.drill_layers:
        name = Path(str(d.original_path or "")).name.upper()
        kind = "nonplated" if "NPTH" in name or d.is_nonplated else "plated"
        for o in d.objects:
            hits[kind] += 1
            dia = getattr(o.aperture, "diameter", None)
            if dia is not None:
                diameters.append(MM(dia, o.unit) if o.unit != MM else dia)
    want_plated = facts["holes"]["plated"] + facts["holes"]["vias"]
    if hits["plated"] != want_plated or hits["nonplated"] != facts["holes"]["nonplated"]:
        problems.append(_problem("drill_count", f"drill files have {hits['plated']} plated and {hits['nonplated']} non-plated "
                                                f"holes; the board has {want_plated} plated (incl. {facts['holes']['vias']} vias) "
                                                f"and {facts['holes']['nonplated']} non-plated"))
    min_dia = round(min(diameters), 3) if diameters else None
    if min_dia is not None and min_dia < min(profile.min_hole_mm, profile.min_via_drill_mm) - 0.001:
        problems.append(_problem("min_drill", f"smallest drill is {min_dia} mm; {profile.name} needs at least "
                                              f"{min(profile.min_hole_mm, profile.min_via_drill_mm)} mm"))
    return {"ok": not problems, "problems": problems, "warnings": warns, "layers": found,
            "outline_mm": [w, h], "drill_hits": hits, "min_drill_mm": min_dia}


def check_assembly(bom_csv: Path | None, cpl_csv: Path | None, facts: dict[str, Any]) -> dict[str, Any]:
    """CPL positions against the board, BOM designators against the parts list."""
    problems: list[dict] = []
    warns: list[dict] = []
    parts = {p["ref"]: p for p in facts["parts"] if not p["dnp"]}
    out: dict[str, Any] = {"cpl_rows": 0, "bom_lines": 0, "rotation_corrections": [], "lcsc_missing": []}
    if cpl_csv and cpl_csv.exists():
        rows = list(csv.DictReader(io.StringIO(cpl_csv.read_text())))
        out["cpl_rows"] = len(rows)
        seen = set()
        for r in rows:
            ref = r.get("Designator", "")
            seen.add(ref)
            p = parts.get(ref)
            if not p:
                problems.append(_problem("cpl_unknown", f"CPL row {ref} is not a component on the board"))
                continue
            x, y = float(r["Mid X"]), float(r["Mid Y"])
            if abs(x - p["x"]) > 0.02 or abs(y - p["y"]) > 0.02:
                problems.append(_problem("cpl_position", f"{ref}: CPL says ({x}, {y}) mm, board has ({p['x']}, {p['y']}) mm"))
            side = "top" if r.get("Layer", "T")[:1].upper() == "T" else "bottom"
            if side != p["side"]:
                problems.append(_problem("cpl_side", f"{ref}: CPL side {side}, board side {p['side']}"))
            rot = float(r.get("Rotation") or 0) % 360
            if abs(rot - p["rotation"]) > 0.01:
                out["rotation_corrections"].append({"ref": ref, "footprint": p["footprint"], "board": p["rotation"], "cpl": rot})
        missing = sorted(r for r, p in parts.items() if p["smd"] and not p["exclude_from_pos"] and r not in seen)
        if missing:
            problems.append(_problem("cpl_missing", f"SMD parts missing from the CPL: {', '.join(missing)}"))
    if bom_csv and bom_csv.exists():
        rows = list(csv.DictReader(io.StringIO(bom_csv.read_text())))
        out["bom_lines"] = len(rows)
        refs: list[str] = []
        for r in rows:
            line = [x.strip() for x in (r.get("Designator") or "").split(",") if x.strip()]
            refs += line
            if not (r.get("LCSC") or "").strip():
                out["lcsc_missing"] += line
        dup = sorted({x for x in refs if refs.count(x) > 1})
        if dup:
            problems.append(_problem("bom_duplicate", f"designators listed twice in the BOM: {', '.join(dup)}"))
        absent = sorted(r for r, p in parts.items() if not p["exclude_from_bom"] and r not in refs)
        if absent:
            problems.append(_problem("bom_missing", f"components missing from the BOM: {', '.join(absent)}"))
        if out["lcsc_missing"]:
            warns.append(_problem("lcsc_missing", f"{len(out['lcsc_missing'])} part(s) have no LCSC part number "
                                                  f"({', '.join(sorted(out['lcsc_missing']))}); JLCPCB assembly needs one "
                                                  "per line. Bare boards can be ordered as they are."))
    if out["rotation_corrections"]:
        warns.append(_problem("rotation_corrections", "KiKit applied the board house's rotation corrections to "
                              + ", ".join(f"{c['ref']} ({c['board']}° -> {c['cpl']}°)" for c in out["rotation_corrections"])
                              + "; confirm orientation in the house's assembly preview"))
    return {"ok": not problems, "problems": problems, "warnings": warns, **out}


# --- Drawings, notes, panel ---------------------------------------------------------------

def drawings(work: Path, pcb: str, has_bottom: bool) -> dict[str, str]:
    out: dict[str, str] = {}
    _run(["kicad-cli", "pcb", "export", "pdf", "--layers", "Edge.Cuts,F.Fab,F.Silkscreen,F.Courtyard", "--mode-single",
          "--include-border-title", "-o", "assembly-top.pdf", pcb], work)
    out["assembly_top"] = "assembly-top.pdf"
    if has_bottom:
        _run(["kicad-cli", "pcb", "export", "pdf", "--layers", "Edge.Cuts,B.Fab,B.Silkscreen,B.Courtyard", "--mode-single",
              "--mirror", "--include-border-title", "-o", "assembly-bottom.pdf", pcb], work)
        out["assembly_bottom"] = "assembly-bottom.pdf"
    maps = work / "drillmap"
    maps.mkdir(exist_ok=True)
    _run(["kicad-cli", "pcb", "export", "drill", "--format", "excellon", "--excellon-separate-th", "--generate-map",
          "--map-format", "pdf", "-o", "drillmap/", pcb], work)
    pdfs = sorted(maps.glob("*-drl_map.pdf"), key=lambda p: ("-NPTH-" in p.name, p.name))   # plated holes first
    if pdfs:
        pdfs[0].replace(work / "drill-map.pdf")
        out["drill_map"] = "drill-map.pdf"
    return out


def fab_notes(name: str, revision: str, profile: FabProfile, facts: dict[str, Any], gerbers: dict, assembly: dict,
              panel: dict | None) -> str:
    w, h = facts["width_mm"], facts["height_mm"]
    smd = [p for p in facts["parts"] if p["smd"] and not p["dnp"]]
    tht = [p for p in facts["parts"] if not p["smd"] and not p["dnp"]]
    lines = [
        f"FAB NOTES — {name}  (revision {revision})",
        "Generated by VX Design. AI-assisted design: review before ordering. Not certified.",
        "",
        "BOARD (enter these on the order form)",
        f"  Fab profile ........ {profile.name} ({profile.description})",
        f"  Dimensions ......... {w} x {h} mm",
        f"  Layers ............. {facts['copper_layers']}",
        f"  Material ........... FR-4, {profile.thickness_mm} mm",
        f"  Copper ............. {profile.copper_oz:g} oz outer" + (", 0.5 oz inner" if facts["copper_layers"] > 2 else ""),
        *([f"  Stackup ............ F.Cu signal / In1.Cu ground plane / In2.Cu power plane / B.Cu signal "
           f"(JLC04161H-7628 or the house's standard 4-layer stackup)"] if facts["copper_layers"] == 4 else []),
        f"  Surface finish ..... {profile.finish}",
        f"  Solder mask ........ {profile.mask}; silkscreen {profile.silkscreen}",
        f"  Min track / space .. {facts['min_track_mm']} mm / {profile.clearance_mm} mm (rules: {profile.min_track_mm} / {profile.min_clearance_mm} mm)",
        f"  Smallest drill ..... {gerbers.get('min_drill_mm')} mm",
        f"  Holes .............. {facts['holes']['plated']} plated, {facts['holes']['vias']} vias, {facts['holes']['nonplated']} non-plated",
        "  Castellations, impedance control, blind/buried vias: none",
        "",
        "FILES",
        "  gerbers.zip ........ upload this to the board house (Gerber X2 + Excellon, plated and non-plated separate)",
    ]
    if profile.assembly:
        lines += [
            "  bom.csv ............ assembly BOM in the house's format",
            "  cpl.csv ............ pick-and-place (mm, same origin as the Gerbers: the board's top-left corner; house rotation corrections applied)",
        ]
    lines += [
        "  assembly-*.pdf ..... assembly drawings (fab layer: outlines, references, values)",
        "  drill-map.pdf ...... drill drawing",
        "  panel/ ............. optional 2x2 panel (mousebites, rails, tooling holes, fiducials)" if panel else "",
        "  manifest.json ...... sha256 of every file in this package",
        "",
        "ASSEMBLY",
        f"  SMD parts .......... {len(smd)} ({sum(1 for p in smd if p['side'] == 'top')} top, {sum(1 for p in smd if p['side'] == 'bottom')} bottom)",
        f"  Through-hole ....... {len(tht)}: {', '.join(p['ref'] for p in tht) or 'none'} (hand-solder or select THT assembly)",
    ]
    if assembly.get("lcsc_missing"):
        lines.append(f"  LCSC part numbers .. MISSING for {', '.join(sorted(assembly['lcsc_missing']))}. "
                     "Assembly orders need them (sourcing milestone); bare boards can be ordered now.")
    if assembly.get("rotation_corrections"):
        lines.append("  Rotations .......... house corrections applied to "
                     + ", ".join(c["ref"] for c in assembly["rotation_corrections"]) + "; check the assembly preview.")
    if not profile.assembly:
        lines.append(f"  {profile.house} does not assemble; order parts separately (BOM in the KiCad project).")
    return "\n".join(l for l in lines if l is not None) + "\n"


def _kikit(work: Path, pcb: str) -> list[str]:
    """KiKit, with KiCad's UUID generator seeded from the board file so panels and fab outputs repeat exactly (G6)."""
    seed = int(hashlib.sha256((work / pcb).read_bytes()).hexdigest()[:8], 16)
    return [sys.executable, "-c", "import sys, pcbnew; pcbnew.KIID.SeedGenerator(int(sys.argv.pop(1))); "
            "from kikit.ui import cli; sys.argv[0] = 'kikit'; sys.exit(cli())", str(seed)]


def panelize(work: Path, pcb: str, profile: FabProfile, sch: str) -> dict[str, Any]:
    args = _kikit(work, pcb) + ["panelize"]
    for k, v in PANEL.items():
        args += [f"--{k}", v]
    _run(args + [pcb, "panel.kicad_pcb"], work, timeout=900)
    import pcbnew
    panel = pcbnew.LoadBoard(str(work / "panel.kicad_pcb"))
    bb = panel.GetBoardEdgesBoundingBox()
    fab_args = _kikit(work, "panel.kicad_pcb") + ["fab", profile.house, "--no-drc", "--no-autoname"]
    _run(fab_args + ["panel.kicad_pcb", "panel-fab"], work)
    render = subprocess.run(["kicad-cli", "pcb", "render", "--width", "1600", "--height", "1000", "--quality", "basic",
                             "--background", "opaque", "--side", "top", "-o", "panel-render.png", "panel.kicad_pcb"],
                            cwd=work, capture_output=True, text=True, timeout=600)
    return {"size_mm": [round(pcbnew.ToMM(bb.GetWidth()), 1), round(pcbnew.ToMM(bb.GetHeight()), 1)], "boards": 4,
            "options": PANEL, "gerbers": "panel-fab/gerbers.zip",
            "render": "panel-render.png" if (work / "panel-render.png").exists() and render.returncode == 0 else None}


def _zip(files: dict[str, Path], dest: Path) -> dict[str, str]:
    """Deterministic zip (fixed timestamps, sorted) plus a sha256 manifest inside it."""
    manifest = {arc: hashlib.sha256(p.read_bytes()).hexdigest() for arc, p in sorted(files.items())}
    with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as z:
        for arc, p in sorted(files.items()):
            info = zipfile.ZipInfo(arc, date_time=STAMP)
            info.external_attr = 0o644 << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, p.read_bytes())
        info = zipfile.ZipInfo("manifest.json", date_time=STAMP)
        info.external_attr = 0o644 << 16
        z.writestr(info, json.dumps(manifest, indent=2))
    return manifest


# --- Entry point ---------------------------------------------------------------------------

def apply_lcsc(project_dir: Path, pcb: str, lcsc: dict[str, str], sch: str = "") -> list[str]:
    """Writes LCSC part numbers from sourcing into the schematic symbols (KiKit's assembly BOM reads them there)
    and the matching board footprints (so schematic parity still holds)."""
    import pcbnew
    from .pcb import _set_field
    from .schematic import _prop
    from .sexpr import Sym, child, children, dumps, parse
    if sch and (project_dir / sch).exists():
        doc = parse((project_dir / sch).read_text())
        for sym in children(doc, "symbol"):
            props = {str(p[1]): p for p in children(sym, "property")}
            ref = props.get("Reference")
            code = lcsc.get(str(ref[2])) if ref else None
            if not code:
                continue
            if "LCSC" in props:
                props["LCSC"][2] = code
            else:
                at = child(sym, "at") or [Sym("at"), 0, 0, 0]
                sym.insert(sym.index(ref) + 1, _prop("LCSC", code, (at[1], at[2]), hidden=True))
        (project_dir / sch).write_text(dumps(doc) + "\n")
    board = pcbnew.LoadBoard(str(project_dir / pcb))
    applied = []
    for fp in board.GetFootprints():
        code = lcsc.get(fp.GetReference())
        if code:
            _set_field(fp, "LCSC", code)
            applied.append(fp.GetReference())
    pcbnew.SaveBoard(str(project_dir / pcb), board)
    return sorted(applied)


def build_package(project_dir: Path, out: Path, panel: bool = True, profile_name: str | None = None,
                  lcsc: dict[str, str] | None = None) -> dict[str, Any]:
    pcb, sch, profile = project_files(project_dir)
    if profile_name:
        profile = PROFILES[profile_name]
    name = Path(pcb).stem
    revision = hashlib.sha256((project_dir / pcb).read_bytes()).hexdigest()[:8]
    result: dict[str, Any] = {"ok": False, "generator_version": __version__, "kicad_version": kicad.version(),
                              "project": name, "revision": revision, "profile": profile.as_dict()}

    # 1. Gate: the board being released passes DRC with schematic parity.
    report = drc(project_dir, pcb, refill=True)
    result["drc"] = {k: report[k] for k in ("errors", "warnings", "unconnected", "parity", "waived")}
    if report["errors"] or report["unconnected"] or report["parity"]:
        result["stage"] = "drc"
        result["problems"] = [_problem("drc", f"the board does not pass DRC ({report['errors']} errors, {report['unconnected']} "
                                              f"unrouted, {report['parity']} schematic differences); fix the layout first")]
        return result

    lcsc_applied = apply_lcsc(project_dir, pcb, lcsc, sch) if lcsc else []
    facts = board_facts(project_dir, pcb)
    out.mkdir(parents=True, exist_ok=True)
    fab_dir = out / "fab"
    args = _kikit(project_dir, pcb) + ["fab", profile.house, "--no-drc", "--no-autoname"]
    if profile.assembly and sch:
        args += ["--assembly", "--schematic", sch, "--field", "LCSC,LCSC Part,JLCPCB Part", "--missingWarn"]
    _run(args + [pcb, str(fab_dir)], project_dir)
    gerber_zip = fab_dir / "gerbers.zip"
    if not gerber_zip.exists():
        raise kicad.KicadError("KiKit wrote no gerbers.zip")
    bom = fab_dir / "bom.csv" if (fab_dir / "bom.csv").exists() else None
    cpl = fab_dir / "pos.csv" if (fab_dir / "pos.csv").exists() else None

    gerbers = check_gerbers(gerber_zip, facts, profile)
    assembly = check_assembly(bom, cpl, facts) if profile.assembly else {"ok": True, "problems": [], "warnings": [],
                                                                         "cpl_rows": 0, "bom_lines": 0,
                                                                         "rotation_corrections": [], "lcsc_missing": []}
    draw = drawings(project_dir, pcb, any(p["side"] == "bottom" for p in facts["parts"]))
    pan = panelize(project_dir, pcb, profile, sch) if panel else None
    from .exports import FORMATS, LABELS, export_formats
    alt = export_formats(project_dir, pcb, out / "formats", FORMATS)
    notes = fab_notes(name, revision, profile, facts, gerbers, assembly, pan)
    notes += ("\nEXCHANGE FORMATS (formats/, each read back and checked against the board)\n"
              + "".join(f"  {LABELS[f]}: formats/{fn}\n" for f, fn in alt["files"].items())
              + "  Board houses: Gerber X2 + Excellon (gerbers.zip) is the primary set; IPC-2581 or ODB++ where the house prefers one.\n"
              + "  Bare-board electrical test: the IPC-D-356 netlist.\n"
              + "  Mechanical and enclosure suppliers: the DXF outline (mm) with the board STEP.\n"
              + "  Dates inside IPC-2581 and ODB++ are fixed (2000-01-01) so the same board gives identical files.\n")
    (out / "FAB-NOTES.txt").write_text(notes)

    files: dict[str, Path] = {"gerbers.zip": gerber_zip, "FAB-NOTES.txt": out / "FAB-NOTES.txt"}
    if bom:
        files["bom.csv"] = bom
    if cpl:
        files["cpl.csv"] = cpl
    for f in draw.values():
        files[f] = project_dir / f
    for fn in alt["files"].values():
        files[f"formats/{fn}"] = out / "formats" / fn
    if pan:
        files["panel/panel-gerbers.zip"] = project_dir / pan["gerbers"]
        if pan["render"]:
            files["panel/panel-render.png"] = project_dir / pan["render"]
    package = out / f"{name}-fab-{profile.house}-{revision}.zip"
    manifest = _zip(files, package)

    # Loose copies for viewers and direct upload.
    exported = {"package": package.name, "notes": "FAB-NOTES.txt"}
    for key, arc in (("gerbers", "gerbers.zip"), ("bom", "bom.csv"), ("cpl", "cpl.csv"), ("assembly_top", "assembly-top.pdf"),
                     ("assembly_bottom", "assembly-bottom.pdf"), ("drill_map", "drill-map.pdf"),
                     ("panel_gerbers", "panel/panel-gerbers.zip"), ("panel_render", "panel/panel-render.png")):
        if arc in files:
            target = out / Path(arc).name
            if files[arc].resolve() != target.resolve():
                target.write_bytes(files[arc].read_bytes())
            exported[key] = target.name
    for f, fn in alt["files"].items():
        exported[f] = f"formats/{fn}"
    check = {"version": 1, "project": name, "revision": revision, "profile": profile.name, "drc": result["drc"],
             "gerbers": gerbers, "assembly": assembly, "board": {k: v for k, v in facts.items() if k != "parts"},
             "parts": facts["parts"], "panel": pan, "manifest": manifest,
             "exports": {"ok": alt["ok"], "files": alt["files"], "labels": alt["labels"], "summary": alt["summary"], "problems": alt["problems"]}}
    (out / "fab-check.json").write_text(json.dumps(check, indent=2))
    exported["check"] = "fab-check.json"
    problems = gerbers["problems"] + assembly["problems"] + alt["problems"]
    result.update({
        "stage": "built", "ok": not problems, "problems": problems,
        "warnings": gerbers["warnings"] + assembly["warnings"],
        "board": check["board"], "gerbers": {k: v for k, v in gerbers.items() if k not in ("problems", "warnings")},
        "assembly": {k: v for k, v in assembly.items() if k not in ("problems", "warnings")},
        "panel": pan, "files": exported, "manifest": manifest, "lcsc_applied": lcsc_applied,
        "exports": {"files": {f: f"formats/{fn}" for f, fn in alt["files"].items()}, "labels": alt["labels"], "ok": alt["ok"]},
    })
    return result


def unzip_project(zip_path: Path, dest: Path) -> Path:
    """Extracts a G4 project zip (one top-level folder) and returns the project directory."""
    with zipfile.ZipFile(zip_path) as z:
        for n in z.namelist():
            if n.startswith("/") or ".." in Path(n).parts:
                raise kicad.KicadError(f"unsafe path in project zip: {n}")
        z.extractall(dest)
    dirs = [p for p in dest.iterdir() if p.is_dir()]
    return dirs[0] if len(dirs) == 1 and not list(dest.glob("*.kicad_pcb")) else dest

