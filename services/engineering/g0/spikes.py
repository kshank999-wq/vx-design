"""G0 capability spikes (spec §4).

Each spike exercises one tool operation on the fixture circuit, checks a
concrete acceptance condition, and records evidence. Spikes share a context
dict so later steps (routing, DRC, fab outputs) build on earlier artifacts,
mirroring the real schematic -> PCB -> manufacturing flow.
"""
from __future__ import annotations

import csv
import importlib.metadata as md
import json
import os
import re
import shutil
import urllib.parse
import urllib.request
from pathlib import Path

from . import fab_profiles, fixture, kicad_sch
from .common import Result, SpikeFailure, copy_evidence, run
from .sexpr import child, children, parse

SYMBOL_DIR = Path(os.environ.get("KICAD10_SYMBOL_DIR", "/usr/share/kicad/symbols"))
FOOTPRINT_DIR = Path(os.environ.get("KICAD10_FOOTPRINT_DIR", "/usr/share/kicad/footprints"))
BOARD_ORIGIN_MM = (100.0, 100.0)
SCH = f"{fixture.PROJECT}.kicad_sch"
FAB = fab_profiles.JLCPCB_2L_STANDARD
PCB = f"{fixture.PROJECT}.kicad_pcb"


def _version(pkg: str) -> str | None:
    try:
        return md.version(pkg)
    except md.PackageNotFoundError:
        return None


def kicad_version() -> str:
    return run(["kicad-cli", "version"]).stdout.strip()


def _erc(work: Path, sch: str) -> list[dict]:
    run(["kicad-cli", "sch", "erc", "--format", "json", "--severity-all", "-o", "erc.json", sch], cwd=work)
    data = json.loads((work / "erc.json").read_text())
    return [v for s in data["sheets"] for v in s["violations"]]


def _netlist_connectivity(path: Path) -> set[frozenset[tuple[str, str]]]:
    doc = parse(path.read_text())
    nets = set()
    for net in children(child(doc, "nets"), "net"):
        nodes = frozenset((child(n, "ref")[1], child(n, "pin")[1]) for n in children(net, "node"))
        nodes = frozenset(x for x in nodes if not x[0].startswith("#"))
        if len(nodes) > 1:
            nets.add(nodes)
    return nets


def _describe_diff(got: set, want: set) -> str:
    return f"missing nets {sorted(map(sorted, want - got))}; unexpected nets {sorted(map(sorted, got - want))}"


# --- KiCad: schematic generation + ERC ------------------------------------------

def schematic_generation(ctx: dict) -> Result:
    r = Result("kicad", "schematic_generation", tool_version=kicad_version(),
               license="GPL-3.0 (run as separate process)", commercial_ok=True)
    work: Path = ctx["work"]
    text, _ = kicad_sch.build_schematic(SYMBOL_DIR)
    (work / SCH).write_text(text)
    kicad_sch.write_lib_tables(work)
    run(["kicad-cli", "sch", "export", "netlist", "--format", "kicadsexpr", "-o", "netlist.net", SCH], cwd=work)
    got = _netlist_connectivity(work / "netlist.net")
    want = fixture.expected_connectivity()
    if got != want:
        raise SpikeFailure("KiCad-derived netlist does not match the design intent: " + _describe_diff(got, want))
    ctx["schematic"] = work / SCH
    ctx["netlist"] = work / "netlist.net"
    r.status = "verified"
    r.notes = ("Generated a native .kicad_sch from code (symbols copied from installed libraries, "
               "`extends` flattened, nets joined by labels on pin endpoints). KiCad's own netlist export "
               f"reproduces all {len(want)} intended nets exactly.")
    r.fallback = "atopile / SKiDL netlist generation (no schematic drawing)"
    r.evidence = [copy_evidence(work / SCH, ctx["out"], "kicad"), copy_evidence(work / "netlist.net", ctx["out"], "kicad")]
    return r


def headless_erc(ctx: dict) -> Result:
    r = Result("kicad", "headless_erc", tool_version=kicad_version(), license="GPL-3.0", commercial_ok=True)
    work: Path = ctx["work"]
    violations = _erc(work, SCH)
    if violations:
        raise SpikeFailure("clean schematic has ERC violations: " + "; ".join(v["description"] for v in violations))
    shutil.copy(work / "erc.json", work / "erc_clean.json")

    # Negative control: drop the power flags; ERC must report undriven power inputs.
    broken = re.sub(r'\(lib_id "power:PWR_FLAG"\)', '(lib_id "power:REMOVED")', (work / SCH).read_text())
    broken = re.sub(r'\(symbol\s+\(lib_id "power:REMOVED"\).*?\n\t\)\n', "", broken, flags=re.S)
    (work / "broken.kicad_sch").write_text(broken)
    neg = _erc(work, "broken.kicad_sch")
    if not any(v["severity"] == "error" for v in neg):
        raise SpikeFailure("negative control: ERC did not report errors for a schematic missing power flags")
    r.status = "verified"
    r.notes = (f"`kicad-cli sch erc` JSON report: generated schematic has 0 violations; negative control "
               f"(power flags removed) reports {sum(v['severity'] == 'error' for v in neg)} error(s): "
               + "; ".join(sorted({v['type'] for v in neg})))
    r.evidence = [copy_evidence(work / "erc_clean.json", ctx["out"], "kicad")]
    return r


# --- KiCad: PCB generation from netlist (pcbnew Python API) ---------------------

def pcb_generation(ctx: dict) -> Result:
    import pcbnew  # provided by the KiCad image

    r = Result("kicad", "pcb_generation", tool_version=pcbnew.Version(), license="GPL-3.0", commercial_ok=True)
    work: Path = ctx["work"]
    doc = parse(ctx["netlist"].read_text())
    pin_net: dict[tuple[str, str], str] = {}
    for net in children(child(doc, "nets"), "net"):
        name = child(net, "name")[1]
        for node in children(net, "node"):
            pin_net[(child(node, "ref")[1], child(node, "pin")[1])] = name
    comp_uuid = {}
    for comp in children(child(doc, "components"), "comp"):
        ts = child(comp, "tstamps") or child(comp, "tstamp")
        comp_uuid[child(comp, "ref")[1]] = ts[1] if ts else None

    mm = pcbnew.FromMM
    ox, oy = BOARD_ORIGIN_MM
    board = pcbnew.CreateEmptyBoard()
    fab_profiles.apply_to_board(board, FAB)
    nets: dict[str, object] = {}
    for name in sorted(set(pin_net.values())):
        item = pcbnew.NETINFO_ITEM(board, name)
        board.Add(item)
        nets[name] = item

    for part in fixture.PARTS:
        lib, name = part.footprint.split(":")
        fp = pcbnew.FootprintLoad(str(FOOTPRINT_DIR / f"{lib}.pretty"), name)
        if fp is None:
            raise SpikeFailure(f"footprint {part.footprint} not found")
        fp.SetFPID(pcbnew.LIB_ID(lib, name))
        fp.SetReference(part.ref)
        fp.SetValue(part.value)
        if comp_uuid.get(part.ref):
            fp.SetPath(pcbnew.KIID_PATH(f"/{comp_uuid[part.ref]}"))
        fp.SetPosition(pcbnew.VECTOR2I(mm(ox + part.pcb_at[0]), mm(oy + part.pcb_at[1])))
        fp.SetOrientationDegrees(part.pcb_rot)
        board.Add(fp)
        for pad in fp.Pads():
            net = pin_net.get((part.ref, pad.GetNumber()))
            if net:
                pad.SetNet(nets[net])

    w, h = fixture.BOARD_SIZE_MM
    outline = pcbnew.PCB_SHAPE(board)
    outline.SetShape(pcbnew.SHAPE_T_RECT)
    outline.SetStart(pcbnew.VECTOR2I(mm(ox), mm(oy)))
    outline.SetEnd(pcbnew.VECTOR2I(mm(ox + w), mm(oy + h)))
    outline.SetLayer(pcbnew.Edge_Cuts)
    outline.SetWidth(mm(0.1))
    board.Add(outline)
    board.SetFileName(str(work / PCB))
    pcbnew.SaveBoard(str(work / PCB), board)
    fab_profiles.write_project_file(work / PCB, FAB)

    # Pre-route DRC doubles as a negative control for the DRC spike: every net is unrouted.
    drc = _drc(work, PCB, "drc_unrouted.json")
    ctx["pcb"] = work / PCB
    ctx["unrouted_count"] = len(drc["unconnected_items"])
    if ctx["unrouted_count"] == 0:
        raise SpikeFailure("unrouted board reports no unconnected items; nets were not assigned to pads")
    r.status = "verified"
    r.notes = (f"Created a .kicad_pcb from the KiCad netlist with the pcbnew Python API: {len(fixture.PARTS)} library "
               f"footprints placed, nets assigned to pads, {w}x{h} mm outline. Pre-route DRC shows "
               f"{ctx['unrouted_count']} unconnected items as expected. Design rules from fab profile `{FAB.name}`. Placement is scripted, not automatic. "
               "Note: KiCad's SWIG Python bindings are deprecated in favour of the IPC API; plan to migrate.")
    r.evidence = [copy_evidence(work / PCB, ctx["out"], "kicad/unrouted")]
    return r


def _drc(work: Path, pcb: str, out_name: str) -> dict:
    run(["kicad-cli", "pcb", "drc", "--format", "json", "--severity-all", "-o", out_name, pcb], cwd=work)
    return json.loads((work / out_name).read_text())


# --- Freerouting: autoroute via Specctra DSN/SES ---------------------------------

def autoroute(ctx: dict) -> Result:
    import pcbnew

    jar = os.environ.get("FREEROUTING_JAR", "/opt/vx/freerouting.jar")
    r = Result("freerouting", "autoroute", license="GPL-3.0 (run as separate process)", commercial_ok=True)
    r.tool_version = _jar_version(jar)
    work: Path = ctx["work"]
    board = pcbnew.LoadBoard(str(ctx["pcb"]))
    fab_profiles.apply_to_board(board, FAB)
    if not pcbnew.ExportSpecctraDSN(board, str(work / "board.dsn")):
        raise SpikeFailure("pcbnew.ExportSpecctraDSN failed")
    fr = run(["java", "-jar", jar, "-de", "board.dsn", "-do", "board.ses", "-mp", "20",
              "--gui.enabled=false", "--usage_and_diagnostic_data.disable_analytics=true"], cwd=work, timeout=900)
    log = fr.stdout + fr.stderr
    (work / "freerouting.log").write_text(log)
    # Design data must not leave the worker: fail if Freerouting attempted to send analytics.
    if re.search(r"analytics", log, re.I) and not re.search(r"analytics (is |are )?disabled", log, re.I):
        raise SpikeFailure("Freerouting attempted analytics despite disable flag: "
                           + " | ".join(l for l in log.splitlines() if re.search("analytics", l, re.I))[:600])
    if not (work / "board.ses").exists():
        raise SpikeFailure("Freerouting produced no session file")
    if not pcbnew.ImportSpecctraSES(board, str(work / "board.ses")):
        raise SpikeFailure("pcbnew.ImportSpecctraSES failed")
    routed = work / f"{fixture.PROJECT}_routed.kicad_pcb"
    pcbnew.SaveBoard(str(routed), board)
    fab_profiles.write_project_file(routed, FAB)
    tracks = [t for t in board.GetTracks() if t.GetClass() == "PCB_TRACK"]
    vias = [t for t in board.GetTracks() if t.GetClass() == "PCB_VIA"]
    widths = sorted({round(pcbnew.ToMM(t.GetWidth()), 3) for t in tracks})
    ctx["routed"] = routed
    r.status = "verified"
    r.notes = (f"DSN export -> Freerouting (headless) -> SES import: {len(tracks)} track segments, {len(vias)} vias "
               f"on a 2-layer board; track widths {widths} mm (narrower segments neck down between fine-pitch pads). Suitable for simple low-speed boards; not for impedance-controlled or "
               "high-speed nets.")
    r.evidence = [copy_evidence(routed, ctx["out"], "kicad/routed"), copy_evidence(work / "board.ses", ctx["out"], "freerouting"),
                  copy_evidence(work / "freerouting.log", ctx["out"], "freerouting")]
    return r


def _jar_version(jar: str) -> str | None:
    import zipfile
    try:
        with zipfile.ZipFile(jar) as z:
            manifest = z.read("META-INF/MANIFEST.MF").decode()
        m = re.search(r"Implementation-Version:\s*(\S+)", manifest)
        if m and m.group(1) != "unspecified":
            return m.group(1)
    except (OSError, KeyError, zipfile.BadZipFile):
        pass
    return os.environ.get("FREEROUTING_VERSION")


def headless_drc(ctx: dict) -> Result:
    r = Result("kicad", "headless_drc", tool_version=kicad_version(), license="GPL-3.0", commercial_ok=True)
    work: Path = ctx["work"]
    drc = _drc(work, ctx["routed"].name, "drc_routed.json")
    r.evidence = [copy_evidence(work / "drc_routed.json", ctx["out"], "kicad"),
                  copy_evidence(work / "drc_unrouted.json", ctx["out"], "kicad")]
    errors = [v for v in drc["violations"] if v["severity"] == "error"]
    warnings = [v for v in drc["violations"] if v["severity"] == "warning"]
    unconnected = drc["unconnected_items"]
    if errors or unconnected:
        raise SpikeFailure(f"routed board: {len(errors)} DRC errors ({sorted({v['type'] for v in errors})}), "
                           f"{len(unconnected)} unconnected items")
    r.status = "verified"
    r.notes = (f"`kicad-cli pcb drc` JSON report on the routed board: 0 errors, 0 unconnected items, "
               f"{len(warnings)} warning(s){' (' + ', '.join(sorted({v['type'] for v in warnings})) + ')' if warnings else ''}. "
               f"Rules: `{FAB.name}` (min track {FAB.min_track_mm} mm, min clearance {FAB.min_clearance_mm} mm), "
               f"read from the .kicad_pro. Negative control: the same board before routing reported "
               f"{ctx['unrouted_count']} unconnected items.")
    return r


# --- KiCad: manufacturing outputs ------------------------------------------------

FAB_LAYERS = "F.Cu,B.Cu,F.Paste,B.Paste,F.Silkscreen,B.Silkscreen,F.Mask,B.Mask,Edge.Cuts"


def fab_outputs(ctx: dict) -> Result:
    r = Result("kicad", "fab_outputs", tool_version=kicad_version(), license="GPL-3.0", commercial_ok=True)
    work: Path = ctx["work"]
    fab = work / "fab"
    fab.mkdir(exist_ok=True)
    pcb = ctx["routed"].name
    run(["kicad-cli", "pcb", "export", "gerbers", "--layers", FAB_LAYERS, "-o", "fab/", pcb], cwd=work)
    run(["kicad-cli", "pcb", "export", "drill", "--format", "excellon", "-o", "fab/", pcb], cwd=work)
    run(["kicad-cli", "pcb", "export", "pos", "--format", "csv", "--units", "mm", "--side", "both",
         "-o", "fab/positions.csv", pcb], cwd=work)
    run(["kicad-cli", "sch", "export", "bom", "-o", "fab/bom.csv", SCH], cwd=work)

    gerbers = sorted(p.name for p in fab.iterdir() if p.suffix.lower().startswith(".g") and p.suffix != ".gbrjob")
    drills = sorted(p.name for p in fab.iterdir() if p.suffix.lower() == ".drl")
    if len(gerbers) < 9 or not drills:
        raise SpikeFailure(f"expected 9 Gerber layers and a drill file, got {gerbers} {drills}")
    empty = [g for g in gerbers if (fab / g).stat().st_size < 200]
    if empty:
        raise SpikeFailure(f"suspiciously small Gerber files: {empty}")
    with open(fab / "positions.csv") as f:
        pos_refs = {row["Ref"] for row in csv.DictReader(f)}
    smd_refs = {p.ref for p in fixture.PARTS if p.ref != "J1"}  # J1 is through-hole
    if not smd_refs <= pos_refs:
        raise SpikeFailure(f"placement file missing {sorted(smd_refs - pos_refs)}")
    bom_text = (fab / "bom.csv").read_text()
    missing_bom = [p.ref for p in fixture.PARTS if p.ref not in bom_text]
    if missing_bom:
        raise SpikeFailure(f"BOM missing {missing_bom}")
    ctx["fab"] = fab
    r.status = "verified"
    r.notes = (f"Headless exports: {len(gerbers)} Gerber layers, Excellon drill, pick-and-place CSV "
               f"({len(pos_refs)} parts), BOM CSV. Content checked for all references. Not yet checked: "
               "fab-house DFM rules, stackup/impedance notes, assembly drawings.")
    r.evidence = [copy_evidence(fab, ctx["out"], "kicad")]
    return r


def step_export(ctx: dict) -> Result:
    r = Result("kicad", "step_export", tool_version=kicad_version(), license="GPL-3.0", commercial_ok=True)
    work: Path = ctx["work"]
    cmd = run(["kicad-cli", "pcb", "export", "step", "--subst-models", "-f", "-o", "board.step", ctx["routed"].name],
              cwd=work, check=False)
    if not (work / "board.step").exists():
        raise SpikeFailure("STEP export failed: " + (cmd.stderr or cmd.stdout)[-400:])
    ctx["step"] = work / "board.step"
    models_dir = Path("/usr/share/kicad/3dmodels")
    has_models = models_dir.exists() and any(models_dir.iterdir())
    r.status = "verified" if has_models else "partial"
    r.notes = ("Board STEP exported headlessly. "
               + ("Component 3D models included." if has_models else
                  "This image has no KiCad 3D model library (use the kicad/kicad:*-full image or fetch manufacturer "
                  "STEP files per part), so the STEP contains the bare board only."))
    r.evidence = [copy_evidence(work / "board.step", ctx["out"], "kicad")]
    return r


# --- KiKit: panelization and fab-house packages ----------------------------------

def panelization(ctx: dict) -> Result:
    r = Result("kikit", "panelization", tool_version=_version("kikit"), license="MIT", commercial_ok=True)
    work: Path = ctx["work"]
    run(["kikit", "panelize",
         "--layout", "grid; rows: 2; cols: 2; space: 2mm",
         "--tabs", "fixed; width: 3mm",
         "--cuts", "mousebites; drill: 0.5mm; spacing: 1mm; offset: 0.2mm",
         "--framing", "railstb; width: 5mm; space: 3mm",
         ctx["routed"].name, "panel.kicad_pcb"], cwd=work, timeout=600)
    import pcbnew
    panel = pcbnew.LoadBoard(str(work / "panel.kicad_pcb"))
    refs = [fp.GetReference() for fp in panel.GetFootprints()]
    bbox = panel.GetBoardEdgesBoundingBox()
    pw, ph = pcbnew.ToMM(bbox.GetWidth()), pcbnew.ToMM(bbox.GetHeight())
    if len(refs) < 4 * len(fixture.PARTS):
        raise SpikeFailure(f"panel has {len(refs)} footprints, expected {4 * len(fixture.PARTS)}")
    w, h = fixture.BOARD_SIZE_MM
    if pw < 2 * w or ph < 2 * h:
        raise SpikeFailure(f"panel outline {pw:.1f}x{ph:.1f} mm is smaller than a 2x2 grid")

    jlc = run(["kikit", "fab", "jlcpcb", "--no-drc", "--assembly", "--schematic", SCH,
               ctx["routed"].name, "fab_jlcpcb"], cwd=work, timeout=600, check=False)
    jlc_files = sorted(p.name for p in (work / "fab_jlcpcb").glob("*")) if (work / "fab_jlcpcb").exists() else []
    lcsc_filled = 0
    if (work / "fab_jlcpcb" / "bom.csv").exists():
        with open(work / "fab_jlcpcb" / "bom.csv") as f:
            lcsc_filled = sum(1 for row in csv.DictReader(f) if row.get("LCSC"))
    r.status = "verified"
    r.notes = (f"`kikit panelize` produced a 2x2 panel ({pw:.1f}x{ph:.1f} mm, {len(refs)} footprints) with "
               f"mousebites and rails. `kikit fab jlcpcb --assembly`: "
               + (f"produced {', '.join(jlc_files)}; LCSC part numbers filled for {lcsc_filled} BOM line(s) - JLCPCB assembly "
                  "needs one per line (sourcing agent work), and its rotation offsets are not yet verified." if jlc.returncode == 0 else
                  f"failed ({(jlc.stderr or jlc.stdout).strip().splitlines()[-1:]}) - parts need LCSC part numbers."))
    r.evidence = [copy_evidence(work / "panel.kicad_pcb", ctx["out"], "kikit")]
    if jlc_files:
        r.evidence.append(copy_evidence(work / "fab_jlcpcb", ctx["out"], "kikit"))
    return r


# --- ngspice: transient simulation with an analytic check ------------------------

def transient_simulation(ctx: dict) -> Result:
    ver = run(["ngspice", "-v"], check=False).stdout
    m = re.search(r"ngspice-(\S+)", ver)
    r = Result("ngspice", "transient_simulation", tool_version=m.group(1) if m else None,
               license="BSD-3-Clause (modified)", commercial_ok=True)
    work: Path = ctx["work"]
    (work / "rc.cir").write_text("""* RC step response, tau = R*C = 1 ms
V1 in 0 PULSE(0 1 0 1n 1n 10m 20m)
R1 in out 1k
C1 out 0 1u
.control
tran 5u 6m
meas tran tau WHEN v(out)=0.6321 RISE=1
wrdata rc_out.txt v(out)
quit
.endc
.end
""")
    out = run(["ngspice", "-b", "rc.cir"], cwd=work, timeout=120)
    m = re.search(r"tau\s*=\s*([0-9.eE+-]+)", out.stdout)
    if not m:
        raise SpikeFailure("ngspice did not report the measured time constant")
    tau = float(m.group(1))
    if abs(tau - 1e-3) / 1e-3 > 0.01:
        raise SpikeFailure(f"measured tau {tau:.4e}s differs from analytic 1.000e-03s by >1%")
    r.status = "verified"
    r.notes = (f"Batch-mode transient run; measured RC time constant {tau * 1e3:.4f} ms vs analytic 1.0000 ms "
               "(within 1%). Waveform saved. Vendor regulator models still need per-part checks.")
    r.evidence = [copy_evidence(work / "rc.cir", ctx["out"], "ngspice"), copy_evidence(work / "rc_out.txt", ctx["out"], "ngspice")]
    return r


# --- CadQuery / OCCT: STEP import, enclosure, interference ----------------------

def step_import_export(ctx: dict) -> Result:
    import cadquery as cq

    r = Result("cadquery", "step_import_export", tool_version=cq.__version__,
               license="Apache-2.0 (OCCT: LGPL-2.1 with exception)", commercial_ok=True)
    board = cq.importers.importStep(str(ctx["step"]))
    bb = board.val().BoundingBox()
    w, h = fixture.BOARD_SIZE_MM
    dims = (bb.xlen, bb.ylen, bb.zlen)
    if abs(bb.xlen - w) > 0.05 or abs(bb.ylen - h) > 0.05 or not 1.0 < bb.zlen < 2.0:
        raise SpikeFailure(f"imported board is {dims}, expected {w}x{h}x~1.6 mm")
    ctx["board_shape"] = board
    ctx["board_bb"] = bb
    work: Path = ctx["work"]
    cq.exporters.export(board, str(work / "board_roundtrip.step"))
    again = cq.importers.importStep(str(work / "board_roundtrip.step")).val()
    if abs(again.Volume() - board.val().Volume()) > 1e-3 * board.val().Volume():
        raise SpikeFailure("STEP round trip changed the solid volume")
    r.status = "verified"
    r.notes = (f"Imported KiCad's board STEP: {bb.xlen:.2f} x {bb.ylen:.2f} x {bb.zlen:.2f} mm, matching the "
               f"{w}x{h} mm outline; export/re-import preserves volume. Manufacturer component STEP files "
               "still to be tested once real part models are sourced.")
    return r


def _enclosure(cq, bb, clearance: float, wall: float = 2.0, headroom: float = 8.0, floor_gap: float = 3.0):
    inner_w, inner_h = bb.xlen + 2 * clearance, bb.ylen + 2 * clearance
    inner_z = bb.zlen + headroom + floor_gap
    cx, cy = bb.center.x, bb.center.y
    z0 = bb.zmin - floor_gap - wall
    outer = cq.Workplane("XY").box(inner_w + 2 * wall, inner_h + 2 * wall, inner_z + wall, centered=(True, True, False))
    cavity = cq.Workplane("XY").workplane(offset=wall).box(inner_w, inner_h, inner_z, centered=(True, True, False))
    shell = outer.cut(cavity)
    # Standoffs under the board, 2.5 mm from each corner.
    posts = (cq.Workplane("XY").workplane(offset=wall)
             .rect(bb.xlen - 5, bb.ylen - 5, forConstruction=True).vertices()
             .circle(1.5).extrude(floor_gap))
    return shell.union(posts).translate((cx, cy, z0))


def enclosure_generation(ctx: dict) -> Result:
    import cadquery as cq

    r = Result("cadquery", "enclosure_generation", tool_version=cq.__version__, license="Apache-2.0", commercial_ok=True)
    work: Path = ctx["work"]
    enc = _enclosure(cq, ctx["board_bb"], clearance=1.0)
    if not enc.val().isValid():
        raise SpikeFailure("generated enclosure solid is invalid")
    cq.exporters.export(enc, str(work / "enclosure.step"))
    cq.exporters.export(enc, str(work / "enclosure.stl"))
    ctx["enclosure"] = enc
    r.status = "partial"
    r.notes = ("Parametric open-top shell with corner standoffs generated from the board STEP bounding box; "
               "valid solid exported as STEP and STL. Not yet: lid, connector cutouts from footprint positions, "
               "process DFM (wall thickness, draft angles).")
    r.evidence = [copy_evidence(work / "enclosure.step", ctx["out"], "cadquery"),
                  copy_evidence(work / "enclosure.stl", ctx["out"], "cadquery")]
    return r


def interference_check(ctx: dict) -> Result:
    import cadquery as cq

    r = Result("cadquery", "interference_check", tool_version=cq.__version__, license="Apache-2.0", commercial_ok=True)
    board = ctx["board_shape"].val()
    fit = ctx["enclosure"].val().intersect(board).Volume()
    tight = _enclosure(cq, ctx["board_bb"], clearance=-1.0).val().intersect(board).Volume()
    if fit > 1e-6:
        raise SpikeFailure(f"board intersects the generated enclosure ({fit:.3f} mm^3)")
    if tight <= 1e-3:
        raise SpikeFailure("negative control: undersized enclosure showed no interference")
    r.status = "verified"
    r.notes = (f"Boolean intersection: board vs generated enclosure = {fit:.4f} mm^3 (fits). Negative control with "
               f"walls 1 mm inside the board edge = {tight:.2f} mm^3 (collision detected).")
    return r


# --- Code-to-netlist tools -------------------------------------------------------

def skidl_netlist(ctx: dict) -> Result:
    r = Result("skidl", "netlist_compile", tool_version=_version("skidl"), license="MIT", commercial_ok=True)
    work: Path = ctx["work"]
    script = work / "skidl_circuit.py"
    script.write_text(_SKIDL_SCRIPT.format(symdir=str(SYMBOL_DIR), parts=repr([(p.ref, p.lib_id, p.value, p.footprint) for p in fixture.PARTS]),
                                           nets=repr(fixture.NETS)))
    out = run(["python", script.name], cwd=work, timeout=300, check=False)
    net_file = work / "skidl.net"
    if out.returncode != 0 or not net_file.exists():
        r.status = "blocked"
        r.errors_seen = (out.stderr or out.stdout).strip()[-600:]
        r.notes = "SKiDL could not build the fixture circuit against the KiCad 10 libraries."
        r.fallback = "Direct .kicad_sch generation (verified)"
        return r
    got = _netlist_connectivity(net_file)
    want = fixture.expected_connectivity()
    if got != want:
        raise SpikeFailure("SKiDL netlist differs from design intent: " + _describe_diff(got, want))
    r.status = "verified"
    r.notes = "Python circuit description compiled to a KiCad netlist whose connectivity matches the fixture exactly."
    r.evidence = [copy_evidence(net_file, ctx["out"], "skidl")]
    return r


_SKIDL_SCRIPT = '''
import os
from skidl import Net, Part, generate_netlist, lib_search_paths, set_default_tool
import skidl
tool = next((getattr(skidl, t) for t in ("KICAD10", "KICAD9", "KICAD8") if hasattr(skidl, t)), None)
set_default_tool(tool)
lib_search_paths[tool].append({symdir!r})
parts = {{}}
for ref, lib_id, value, footprint in {parts}:
    lib, name = lib_id.split(":")
    parts[ref] = Part(lib, name, ref=ref, value=value, footprint=footprint)
for net_name, pins in {nets}.items():
    net = Net(net_name)
    for ref, pin in pins:
        net += parts[ref][pin]
generate_netlist(file_="skidl.net")
'''


def atopile_check(ctx: dict) -> Result:
    out = run(["ato", "--version"], check=False)
    version = (out.stdout or out.stderr).strip().splitlines()[-1:] if out.returncode == 0 else []
    r = Result("atopile", "netlist_compile", tool_version=version[0] if version else None, license="MIT", commercial_ok=True)
    if out.returncode != 0:
        r.status = "blocked"
        r.errors_seen = (out.stderr or out.stdout)[-400:]
        return r
    r.status = "partial"
    r.notes = ("CLI installs and runs. A full build was not exercised: atopile projects pull part packages "
               "from its registry and need a project scaffold. Evaluate in a follow-up spike alongside SKiDL.")
    return r


# --- KiCad IPC API ----------------------------------------------------------------

def ipc_api(ctx: dict) -> Result:
    r = Result("kicad", "ipc_api", tool_version=_version("kicad-python"), license="MIT (kicad-python)", commercial_ok=True)
    try:
        from kipy import KiCad
        kicad = KiCad(timeout_ms=2000)
        r.notes = f"Connected to KiCad {kicad.get_version()}"
        r.status = "verified"
    except Exception as exc:  # noqa: BLE001 — any failure here is the finding
        r.status = "blocked"
        r.errors_seen = f"{type(exc).__name__}: {exc}"[:400]
        r.notes = ("kicad-python needs a running KiCad GUI instance with the API server enabled; none exists in a "
                   "headless worker. Follow-up: run KiCad under a virtual display (Xvfb) or wait for a headless API host.")
        r.fallback = "kicad-cli + pcbnew Python bindings (verified) and direct file generation"
    return r


# --- Hosted part-data APIs (credential-gated) -------------------------------------

TEST_MPN = "AP2112K-3.3TRG1"


def _http_json(url: str, data: dict | None = None, headers: dict | None = None, form: bool = False) -> dict:
    body = None
    hdrs = {"Accept": "application/json", **(headers or {})}
    if data is not None:
        if form:
            body = urllib.parse.urlencode(data).encode()
            hdrs["Content-Type"] = "application/x-www-form-urlencoded"
        else:
            body = json.dumps(data).encode()
            hdrs["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=body, headers=hdrs, method="POST" if body else "GET")
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())


def _missing_creds(tool: str, operation: str, env: list[str]) -> Result | None:
    if all(os.environ.get(e) for e in env):
        return None
    return Result(tool, operation, status="untested", deployment_mode="hosted API",
                  notes=f"Not run: set {', '.join(env)} to test a live lookup of {TEST_MPN}.")


def digikey_search(ctx: dict) -> Result:
    env = ["DIGIKEY_CLIENT_ID", "DIGIKEY_CLIENT_SECRET"]
    if (skip := _missing_creds("digikey", "product_search", env)):
        return skip
    token = _http_json("https://api.digikey.com/v1/oauth2/token", {
        "client_id": os.environ[env[0]], "client_secret": os.environ[env[1]], "grant_type": "client_credentials"}, form=True)
    res = _http_json("https://api.digikey.com/products/v4/search/keyword", {"Keywords": TEST_MPN, "Limit": 5},
                     headers={"Authorization": f"Bearer {token['access_token']}", "X-DIGIKEY-Client-Id": os.environ[env[0]]})
    products = res.get("Products", [])
    return _api_result("digikey", "product_search", products, "ManufacturerProductNumber", ctx, res)


def mouser_search(ctx: dict) -> Result:
    env = ["MOUSER_API_KEY"]
    if (skip := _missing_creds("mouser", "product_search", env)):
        return skip
    res = _http_json(f"https://api.mouser.com/api/v1/search/partnumber?apiKey={os.environ[env[0]]}",
                     {"SearchByPartRequest": {"mouserPartNumber": TEST_MPN, "partSearchOptions": "Exact"}})
    products = res.get("SearchResults", {}).get("Parts", [])
    return _api_result("mouser", "product_search", products, "ManufacturerPartNumber", ctx, res)


def nexar_lookup(ctx: dict) -> Result:
    env = ["NEXAR_CLIENT_ID", "NEXAR_CLIENT_SECRET"]
    if (skip := _missing_creds("nexar", "part_lookup", env)):
        return skip
    token = _http_json("https://identity.nexar.com/connect/token", {
        "client_id": os.environ[env[0]], "client_secret": os.environ[env[1]], "grant_type": "client_credentials"}, form=True)
    query = 'query { supSearchMpn(q: "%s", limit: 3) { results { part { mpn manufacturer { name } ' \
            'sellers { company { name } offers { inventoryLevel } } } } } }' % TEST_MPN
    res = _http_json("https://api.nexar.com/graphql", {"query": query},
                     headers={"Authorization": f"Bearer {token['access_token']}"})
    results = (res.get("data") or {}).get("supSearchMpn", {}).get("results") or []
    return _api_result("nexar", "part_lookup", [x["part"] for x in results], "mpn", ctx, res)


def _api_result(tool: str, op: str, items: list, mpn_key: str, ctx: dict, raw: dict) -> Result:
    r = Result(tool, op, deployment_mode="hosted API")
    sample = ctx["work"] / f"{tool}_sample.json"
    sample.write_text(json.dumps(raw, indent=2)[:200_000])
    r.evidence = [copy_evidence(sample, ctx["out"], "apis")]
    if not any(TEST_MPN.split("-")[0] in str(i.get(mpn_key, "")) for i in items):
        raise SpikeFailure(f"{tool} returned {len(items)} results but none for {TEST_MPN}")
    r.status = "partial"
    r.notes = (f"Authenticated lookup of {TEST_MPN} returned {len(items)} result(s). Still to record: quotas, "
               "caching/redistribution terms, field mapping.")
    return r
