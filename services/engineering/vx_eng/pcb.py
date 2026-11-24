"""Board layout: placement checks, PCB generation, autorouting, DRC, 3D models and exports.

A layout lists the board outline, mounting holes and a position for every component. It is
the contract between the model, which proposes it, and this module, which:
  1. checks it geometrically with KiCad's own footprints (courtyards inside the outline and
     not overlapping), reporting allowed position ranges so the model can repair it;
  2. builds a native .kicad_pcb linked to the generated schematic (footprints carry the
     schematic symbol UUIDs, so KiCad's schematic parity check applies);
  3. routes it with Freerouting, adds ground pours, and runs KiCad DRC with schematic parity;
  4. fetches the KiCad library 3D model of every footprint and exports STEP, GLB, renders
     and layer drawings.

Needs KiCad's pcbnew Python module (the engineering image).
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import ssl
import subprocess
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import kicad
from .circuit import Circuit
from .fab import DEFAULT_PROFILE, PROFILES, FabProfile, apply_to_board, project_settings
from .library import FOOTPRINT_DIR
from .sexpr import child, children, parse

ORIGIN_MM = (100.0, 100.0)          # board top-left corner on the KiCad page; layout coordinates are relative to it
HOLE_FOOTPRINTS = {
    "M2": "MountingHole:MountingHole_2.2mm_M2",
    "M2.5": "MountingHole:MountingHole_2.7mm_M2.5",
    "M3": "MountingHole:MountingHole_3.2mm_M3",
}
ROTATIONS = (0, 90, 180, 270)
POWER_NET = re.compile(r"^(GND\w*|[+-]?\d+V\d*\w*|V(CC|DD|IN|BAT|BUS|SYS|MOT)\w*|PWR\w*)$", re.I)
FREEROUTING_JAR = os.environ.get("FREEROUTING_JAR", "/opt/vx/freerouting.jar")
MODEL_CACHE = Path(os.environ.get("VX_3DMODEL_CACHE", str(Path.home() / ".cache" / "vx-3dmodels")))
MODEL_URL = os.environ.get("VX_3DMODEL_URL", "https://gitlab.com/kicad/libraries/kicad-packages3D/-/raw/{tag}/{path}")
MODEL_VAR = "KICAD10_3DMODEL_DIR"


# --- Layout description ---------------------------------------------------------------

@dataclass
class Placement:
    ref: str
    x: float
    y: float
    rotation: float = 0
    side: str = "top"


@dataclass
class Hole:
    x: float
    y: float
    size: str = "M3"


@dataclass
class Layout:
    width: float
    height: float
    placements: list[Placement]
    holes: list[Hole] = field(default_factory=list)
    corner_radius: float = 0.0
    fab_profile: str = DEFAULT_PROFILE
    ground_pour: str | None = "GND"
    # 4-layer boards: the nets of the inner planes (In1, In2). Empty: ground on In1, the busiest supply on In2.
    inner_planes: list[str] = field(default_factory=list)

    @staticmethod
    def from_json(d: dict[str, Any]) -> "Layout":
        b = d.get("board") or {}
        return Layout(
            width=float(b.get("width_mm") or 0), height=float(b.get("height_mm") or 0),
            corner_radius=float(b.get("corner_radius_mm") or 0),
            holes=[Hole(float(h["x_mm"]), float(h["y_mm"]), str(h.get("size") or "M3")) for h in b.get("mounting_holes") or []],
            placements=[Placement(str(p["ref"]), float(p["x_mm"]), float(p["y_mm"]), float(p.get("rotation_deg") or 0),
                                  str(p.get("side") or "top")) for p in d.get("placements") or []],
            fab_profile=str(d.get("fab_profile") or DEFAULT_PROFILE),
            ground_pour=d.get("ground_pour", "GND") or None,
            inner_planes=[str(n) for n in (d.get("inner_planes") or []) if n][:2],
        )


def _problem(code: str, message: str, **extra: Any) -> dict[str, Any]:
    return {"code": code, "message": message, **extra}


def _r(v: float) -> float:
    return round(v, 2)


# --- Footprints ------------------------------------------------------------------------

def _pcbnew():
    import pcbnew  # provided by the KiCad image
    return pcbnew


def load_footprint(fp_id: str):
    pcbnew = _pcbnew()
    lib, name = fp_id.split(":", 1)
    fp = pcbnew.FootprintLoad(str(FOOTPRINT_DIR / f"{lib}.pretty"), name)
    if fp is None:
        raise ValueError(f"footprint {fp_id} not found")
    fp.SetFPID(pcbnew.LIB_ID(lib, name))
    return fp


def _is_tht(fp) -> bool:
    pcbnew = _pcbnew()
    return any(p.GetAttribute() in (pcbnew.PAD_ATTRIB_PTH, pcbnew.PAD_ATTRIB_NPTH) for p in fp.Pads())


def _courtyard(fp) -> tuple[float, float, float, float]:
    """Courtyard bounding box (mm, absolute) on the footprint's side; pads + graphics if it has none."""
    pcbnew = _pcbnew()
    fp.BuildCourtyardCaches()
    poly = fp.GetCourtyard(pcbnew.B_CrtYd if fp.IsFlipped() else pcbnew.F_CrtYd)
    bb = poly.BBox() if poly.OutlineCount() else fp.GetBoundingBox(False)
    return (pcbnew.ToMM(bb.GetLeft()), pcbnew.ToMM(bb.GetTop()), pcbnew.ToMM(bb.GetRight()), pcbnew.ToMM(bb.GetBottom()))


def footprint_facts(circuit: Circuit) -> list[dict[str, Any]]:
    """Size facts the model needs to place parts: courtyard extents at rotation 0, pad count, THT or SMD."""
    pcbnew = _pcbnew()
    out = []
    board = pcbnew.CreateEmptyBoard()
    for c in circuit.components:
        try:
            fp = load_footprint(c.footprint)
        except ValueError as e:
            out.append({"ref": c.ref, "footprint": c.footprint, "error": str(e)})
            continue
        board.Add(fp)
        fp.SetPosition(pcbnew.VECTOR2I(0, 0))
        x0, y0, x1, y1 = _courtyard(fp)
        out.append({
            "ref": c.ref, "footprint": c.footprint, "value": c.value,
            "courtyard_mm": {"width": _r(x1 - x0), "height": _r(y1 - y0),
                             "left": _r(x0), "top": _r(y0), "right": _r(x1), "bottom": _r(y1)},
            "pads": len(list(fp.Pads())), "mount": "through_hole" if _is_tht(fp) else "smd",
            "models": [m.m_Filename for m in fp.Models()],
        })
    return out


# --- Placement --------------------------------------------------------------------------

def _set_field(fp, name: str, value: str) -> None:
    pcbnew = _pcbnew()
    builtin = {"Datasheet": pcbnew.FIELD_T_DATASHEET, "Description": pcbnew.FIELD_T_DESCRIPTION}
    if name in builtin:
        fp.GetField(builtin[name]).SetText(value)
    elif name in ("Reference", "Value", "Footprint"):
        return
    elif fp.HasField(name):
        fp.GetField(name).SetText(value)
    else:
        f = pcbnew.PCB_FIELD(fp, pcbnew.FIELD_T_USER, name)
        f.SetText(value)
        f.SetVisible(False)
        f.SetLayer(pcbnew.B_Fab if fp.IsFlipped() else pcbnew.F_Fab)
        fp.Add(f)


def _place_reference(fp, layout: Layout) -> None:
    """Upright reference text just outside the courtyard (above it, or below near the top edge)."""
    pcbnew = _pcbnew()
    mm = pcbnew.FromMM
    ref = fp.Reference()
    ref.SetTextSize(pcbnew.VECTOR2I(mm(0.8), mm(0.8)))
    ref.SetTextThickness(mm(0.12))
    ref.SetTextAngleDegrees(0)
    x0, y0, x1, y1 = _courtyard(fp)
    ox, oy = ORIGIN_MM
    y = y0 - 0.65 if y0 - oy > 1.6 else y1 + 0.65
    ref.SetPosition(pcbnew.VECTOR2I(mm((x0 + x1) / 2), mm(y)))
    ref.SetKeepUpright(True)


def _place(board, circuit: Circuit, layout: Layout, paths: dict[str, str] | None = None,
           pin_nets: dict[tuple[str, str], Any] | None = None,
           fields: dict[str, dict[str, str]] | None = None,
           models: dict[str, str] | None = None) -> dict[str, Any]:
    """Adds every placed component and mounting hole to the board. Returns ref -> footprint."""
    pcbnew = _pcbnew()
    mm = pcbnew.FromMM
    ox, oy = ORIGIN_MM
    comps = {c.ref: c for c in circuit.components}
    fps: dict[str, Any] = {}
    for p in layout.placements:
        c = comps.get(p.ref)
        if not c or p.ref in fps:
            continue
        fp = load_footprint(c.footprint)
        fp.SetReference(c.ref)
        fp.SetValue(c.value)
        if models and c.ref in models:
            # A verified manufacturer model, already aligned to this footprint (no extra transform).
            m = pcbnew.FP_3DMODEL()
            m.m_Filename = models[c.ref]
            fp.Models().clear()
            fp.Models().push_back(m)
        for name, val in (fields or {}).get(c.ref, {}).items():
            _set_field(fp, name, val)
        if paths and c.ref in paths:
            fp.SetPath(pcbnew.KIID_PATH(f"/{paths[c.ref]}"))
        board.Add(fp)
        pos = pcbnew.VECTOR2I(mm(ox + p.x), mm(oy + p.y))
        fp.SetPosition(pos)
        if p.side == "bottom":
            fp.Flip(pos, pcbnew.FLIP_DIRECTION_LEFT_RIGHT)
        fp.SetOrientationDegrees(p.rotation)
        _place_reference(fp, layout)
        if pin_nets is not None:
            for pad in fp.Pads():
                net = pin_nets.get((c.ref, pad.GetNumber()))
                if net is not None:
                    pad.SetNet(net)
        fps[c.ref] = fp
    for i, h in enumerate(layout.holes, start=1):
        fp = load_footprint(HOLE_FOOTPRINTS[h.size])
        fp.SetReference(f"H{i}")
        fp.SetValue(h.size)
        fp.Reference().SetVisible(False)
        fp.SetAttributes(fp.GetAttributes() | pcbnew.FP_BOARD_ONLY | pcbnew.FP_EXCLUDE_FROM_BOM | pcbnew.FP_EXCLUDE_FROM_POS_FILES)
        board.Add(fp)
        fp.SetPosition(pcbnew.VECTOR2I(mm(ox + h.x), mm(oy + h.y)))
        fps[f"H{i}"] = fp
    return fps


def _outline(board, layout: Layout) -> None:
    pcbnew = _pcbnew()
    mm = pcbnew.FromMM
    ox, oy = ORIGIN_MM
    w, h, r = layout.width, layout.height, min(layout.corner_radius, layout.width / 2, layout.height / 2)

    def add(shape, *pts):
        s = pcbnew.PCB_SHAPE(board)
        s.SetShape(shape)
        s.SetLayer(pcbnew.Edge_Cuts)
        s.SetWidth(mm(0.1))
        v = [pcbnew.VECTOR2I(mm(ox + x), mm(oy + y)) for x, y in pts]
        if shape == pcbnew.SHAPE_T_ARC:
            s.SetArcGeometry(v[0], v[1], v[2])
        else:
            s.SetStart(v[0])
            s.SetEnd(v[1])
        board.Add(s)

    if r <= 0:
        add(pcbnew.SHAPE_T_RECT, (0, 0), (w, h))
        return
    k = r * (1 - 0.5 ** 0.5)   # arc midpoint inset
    add(pcbnew.SHAPE_T_SEGMENT, (r, 0), (w - r, 0))
    add(pcbnew.SHAPE_T_SEGMENT, (w, r), (w, h - r))
    add(pcbnew.SHAPE_T_SEGMENT, (w - r, h), (r, h))
    add(pcbnew.SHAPE_T_SEGMENT, (0, h - r), (0, r))
    add(pcbnew.SHAPE_T_ARC, (0, r), (k, k), (r, 0))
    add(pcbnew.SHAPE_T_ARC, (w - r, 0), (w - k, k), (w, r))
    add(pcbnew.SHAPE_T_ARC, (w, h - r), (w - k, h - k), (w - r, h))
    add(pcbnew.SHAPE_T_ARC, (r, h), (k, h - k), (0, h - r))


def check_placement(circuit: Circuit, layout: Layout) -> dict[str, Any]:
    """Geometric checks of a proposed layout. Every problem says how to fix it."""
    pcbnew = _pcbnew()
    problems: list[dict] = []
    warnings: list[dict] = []
    refs = [c.ref for c in circuit.components]
    placed = [p.ref for p in layout.placements]

    if layout.fab_profile not in PROFILES:
        problems.append(_problem("unknown_fab_profile", f"fab_profile {layout.fab_profile!r} is not known",
                                 suggestions=sorted(PROFILES)))
    if not (5 <= layout.width <= 400 and 5 <= layout.height <= 400):
        problems.append(_problem("board_size", f"board is {layout.width} x {layout.height} mm; each side must be 5-400 mm"))
    for ref in sorted(set(refs) - set(placed)):
        problems.append(_problem("missing_placement", f"{ref} has no placement; every component needs one", ref=ref))
    for ref in sorted(set(placed) - set(refs)):
        problems.append(_problem("unknown_ref", f"placement for {ref}, which is not a component of the circuit", ref=ref))
    for ref in sorted({r for r in placed if placed.count(r) > 1}):
        problems.append(_problem("duplicate_placement", f"{ref} is placed more than once", ref=ref))
    for p in layout.placements:
        if p.side not in ("top", "bottom"):
            problems.append(_problem("bad_side", f"{p.ref}: side must be 'top' or 'bottom', not {p.side!r}", ref=p.ref))
        if p.rotation % 360 not in ROTATIONS:
            problems.append(_problem("bad_rotation", f"{p.ref}: rotation_deg must be 0, 90, 180 or 270, not {p.rotation}", ref=p.ref))
    for i, h in enumerate(layout.holes, start=1):
        if h.size not in HOLE_FOOTPRINTS:
            problems.append(_problem("bad_hole", f"mounting hole {i}: size must be one of {sorted(HOLE_FOOTPRINTS)}"))
    if problems:
        return {"ok": False, "stage": "placement", "problems": problems, "warnings": warnings}

    board = pcbnew.CreateEmptyBoard()
    fps = _place(board, circuit, layout)
    ox, oy = ORIGIN_MM
    boxes: dict[str, tuple[float, float, float, float]] = {}
    sides: dict[str, set[str]] = {}
    pmap = {p.ref: p for p in layout.placements}
    for ref, fp in fps.items():
        x0, y0, x1, y1 = _courtyard(fp)
        boxes[ref] = (x0 - ox, y0 - oy, x1 - ox, y1 - oy)
        # Through-hole parts and holes occupy both sides.
        sides[ref] = {"top", "bottom"} if (ref.startswith("H") and ref not in pmap) or _is_tht(fp) else {pmap[ref].side}

    for ref, (x0, y0, x1, y1) in boxes.items():
        if x0 < -0.001 or y0 < -0.001 or x1 > layout.width + 0.001 or y1 > layout.height + 0.001:
            if ref in pmap:
                p = pmap[ref]
                rx0, ry0, rx1, ry1 = x0 - p.x, y0 - p.y, x1 - p.x, y1 - p.y
                problems.append(_problem(
                    "outside_board",
                    f"{ref} courtyard spans x {_r(x0)}..{_r(x1)}, y {_r(y0)}..{_r(y1)} mm, outside the "
                    f"{layout.width} x {layout.height} mm board. At rotation {int(p.rotation)} its centre must be within "
                    f"x {_r(-rx0)}..{_r(layout.width - rx1)}, y {_r(-ry0)}..{_r(layout.height - ry1)} mm",
                    ref=ref, allowed={"x": [_r(-rx0), _r(layout.width - rx1)], "y": [_r(-ry0), _r(layout.height - ry1)]}))
            else:
                problems.append(_problem("outside_board", f"mounting hole {ref} keep-out spans x {_r(x0)}..{_r(x1)}, "
                                         f"y {_r(y0)}..{_r(y1)} mm, outside the board", ref=ref))
    names = sorted(boxes)
    for i, a in enumerate(names):
        for b in names[i + 1:]:
            if not sides[a] & sides[b]:
                continue
            ax0, ay0, ax1, ay1 = boxes[a]
            bx0, by0, bx1, by1 = boxes[b]
            dx, dy = min(ax1, bx1) - max(ax0, bx0), min(ay1, by1) - max(ay0, by0)
            if dx > 0.001 and dy > 0.001:
                side = "both sides" if len(sides[a] & sides[b]) == 2 else f"the {next(iter(sides[a] & sides[b]))} side"
                problems.append(_problem(
                    "courtyard_overlap",
                    f"{a} and {b} courtyards overlap by {_r(dx)} x {_r(dy)} mm on {side} "
                    f"({a}: x {_r(ax0)}..{_r(ax1)}, y {_r(ay0)}..{_r(ay1)}; {b}: x {_r(bx0)}..{_r(bx1)}, y {_r(by0)}..{_r(by1)}). "
                    f"Move one of them at least {_r(min(dx, dy) + 0.25)} mm apart",
                    refs=[a, b]))
    area = sum((x1 - x0) * (y1 - y0) for r, (x0, y0, x1, y1) in boxes.items())
    density = area / (layout.width * layout.height)
    if density > 0.55 and not problems:
        warnings.append(_problem("dense", f"courtyards cover {round(density * 100)}% of the board; routing may not complete"))
    placements = {r: {"x0": _r(b[0]), "y0": _r(b[1]), "x1": _r(b[2]), "y1": _r(b[3]), "sides": sorted(sides[r])}
                  for r, b in boxes.items()}
    return {"ok": not problems, "stage": "placement", "problems": problems, "warnings": warnings,
            "courtyards": placements, "density": round(density, 3)}


# --- Netlist --------------------------------------------------------------------------

def _read_netlist(path: Path) -> tuple[dict[str, str], dict[tuple[str, str], str], dict[str, dict[str, str]]]:
    """Symbol UUIDs, pin -> net name (KiCad's full names, e.g. /VIN) and symbol fields, from the netlist of
    the generated schematic. Unconnected pins keep KiCad's own single-pin net names, as parity expects."""
    doc = parse(path.read_text())
    paths: dict[str, str] = {}
    fields: dict[str, dict[str, str]] = {}
    for comp in children(child(doc, "components"), "comp"):
        ref = str(child(comp, "ref")[1])
        ts = child(comp, "tstamps") or child(comp, "tstamp")
        if ts:
            paths[ref] = str(ts[1]).split()[0]
        fields[ref] = {}
        for f in children(child(comp, "fields") or [], "field"):
            name = str(child(f, "name")[1])
            value = next((str(x) for x in f[1:] if not isinstance(x, list)), "")
            fields[ref][name] = value
    pin_net: dict[tuple[str, str], str] = {}
    for net in children(child(doc, "nets"), "net"):
        name = str(child(net, "name")[1])
        for node in children(net, "node"):
            ref = str(child(node, "ref")[1])
            if not ref.startswith("#"):
                pin_net[(ref, str(child(node, "pin")[1]))] = name
    return paths, pin_net, fields


def short_net(name: str) -> str:
    return name.rsplit("/", 1)[-1]


# --- Routing ----------------------------------------------------------------------------

def _route(board, work: Path, skip_nets: list[str] | None = None) -> dict[str, Any]:
    pcbnew = _pcbnew()
    dsn, ses = work / "board.dsn", work / "board.ses"
    if not pcbnew.ExportSpecctraDSN(board, str(dsn)):
        raise kicad.KicadError("Specctra DSN export failed")
    if skip_nets:
        _drop_nets_from_dsn(dsn, skip_nets)
    # Dense boards (150 parts, fine-pitch connectors) need many more passes than small ones. The time goes into
    # connecting everything: the route optimizer (shortening finished tracks) is off, since it took most of the time
    # and an unfinished board fails anyway. Both can be tuned per worker with VX_ROUTER_PASSES / VX_ROUTER_TIMEOUT_S.
    passes = int(os.environ.get("VX_ROUTER_PASSES", "100"))
    limit = int(os.environ.get("VX_ROUTER_TIMEOUT_S", "2700"))
    cmd = ["java", "-jar", FREEROUTING_JAR, "-de", dsn.name, "-do", ses.name, "-mp", str(passes),
           "-mt", str(max(1, (os.cpu_count() or 2) - 1)),
           "--gui.enabled=false", "--usage_and_diagnostic_data.disable_analytics=true",
           "--feature_flags.save_jobs=false", "--router.optimizer.enabled=false"]
    try:
        p = subprocess.run(cmd, cwd=work, capture_output=True, text=True, timeout=limit)
    except subprocess.TimeoutExpired as e:
        log = ((e.stdout or b"").decode(errors="replace") if isinstance(e.stdout, bytes) else (e.stdout or "")) + \
              ((e.stderr or b"").decode(errors="replace") if isinstance(e.stderr, bytes) else (e.stderr or ""))
        (work / "freerouting.log").write_text(log)
        raise kicad.KicadError(f"Freerouting did not finish within {limit // 60} minutes ({passes} passes allowed): "
                               "the placement leaves too little room to connect everything")
    log = (p.stdout or "") + (p.stderr or "")
    (work / "freerouting.log").write_text(log)
    if not ses.exists():
        raise kicad.KicadError(f"Freerouting produced no session file: {log.strip()[-800:]}")
    if not pcbnew.ImportSpecctraSES(board, str(ses)):
        raise kicad.KicadError("Specctra SES import failed")
    tracks = [t for t in board.GetTracks() if t.GetClass() == "PCB_TRACK"]
    vias = [t for t in board.GetTracks() if t.GetClass() == "PCB_VIA"]
    return {
        "router": "freerouting", "segments": len(tracks), "vias": len(vias),
        "length_mm": round(sum(pcbnew.ToMM(t.GetLength()) for t in tracks), 1),
        "widths_mm": sorted({round(pcbnew.ToMM(t.GetWidth()), 3) for t in tracks}),
    }


def _ground_pour(board, layout: Layout, profile: FabProfile, net) -> list[str]:
    pcbnew = _pcbnew()
    mm = pcbnew.FromMM
    ox, oy = ORIGIN_MM
    layers = []
    for layer, name in ((pcbnew.F_Cu, "F.Cu"), (pcbnew.B_Cu, "B.Cu")):
        z = pcbnew.ZONE(board)
        z.SetLayer(layer)
        z.SetNet(net)
        z.SetIsRuleArea(False)
        z.SetLocalClearance(mm(max(profile.clearance_mm, 0.3)))
        z.SetMinThickness(mm(max(profile.min_track_mm, 0.2)))
        z.SetPadConnection(pcbnew.ZONE_CONNECTION_THT_THERMAL)
        z.SetThermalReliefGap(mm(0.3))
        z.SetThermalReliefSpokeWidth(mm(max(profile.track_mm, 0.3)))
        z.SetIslandRemovalMode(pcbnew.ISLAND_REMOVAL_MODE_ALWAYS)
        z.SetAssignedPriority(0)
        outline = z.Outline()
        outline.NewOutline()
        for x, y in ((0, 0), (layout.width, 0), (layout.width, layout.height), (0, layout.height)):
            outline.Append(mm(ox + x), mm(oy + y))
        board.Add(z)
        layers.append(name)
    return layers


def _plane_nets(layout: Layout, nets: dict[str, Any], power: list[str], pin_net_names: dict) -> list[str]:
    """Full net names for In1 and In2: the layout's choice, else ground then the supply with the most pins."""
    by_short = {short_net(n): n for n in nets}
    chosen = [by_short[short_net(n)] for n in layout.inner_planes if short_net(n) in by_short]
    if len(chosen) == 2:
        return chosen
    ground = by_short.get(layout.ground_pour or "GND") or next((n for n in nets if short_net(n).upper() in ("GND", "GNDD", "VSS")), None)
    pins: dict[str, int] = {}
    for n in pin_net_names.values():
        pins[n] = pins.get(n, 0) + 1
    supply = max((n for n in power if n != ground), key=lambda n: pins.get(n, 0), default=None)
    out = chosen[:1] or ([ground] if ground else [])
    for n in (ground, supply):
        if n and n not in out and len(out) < 2:
            out.append(n)
    return out


def _inner_planes(board, layout: Layout, profile: FabProfile, plane_nets: list[str], nets: dict[str, Any]) -> list[dict[str, str]]:
    """Solid planes on the inner layers, added before routing: the router then reaches them with vias instead of
    routing those nets, which frees the outer layers for signals."""
    pcbnew = _pcbnew()
    mm = pcbnew.FromMM
    ox, oy = ORIGIN_MM
    inset = profile.copper_edge_clearance_mm
    out = []
    for layer, lname, net in zip((pcbnew.In1_Cu, pcbnew.In2_Cu), ("In1.Cu", "In2.Cu"), plane_nets):
        board.SetLayerType(layer, pcbnew.LT_POWER)
        z = pcbnew.ZONE(board)
        z.SetLayer(layer)
        z.SetNet(nets[net])
        z.SetIsRuleArea(False)
        z.SetLocalClearance(mm(max(profile.clearance_mm, 0.25)))
        z.SetMinThickness(mm(max(profile.min_track_mm, 0.2)))
        z.SetPadConnection(pcbnew.ZONE_CONNECTION_THT_THERMAL)
        z.SetThermalReliefGap(mm(0.3))
        z.SetThermalReliefSpokeWidth(mm(max(profile.track_mm, 0.3)))
        z.SetIslandRemovalMode(pcbnew.ISLAND_REMOVAL_MODE_ALWAYS)
        z.SetAssignedPriority(1)
        outline = z.Outline()
        outline.NewOutline()
        for x, y in ((inset, inset), (layout.width - inset, inset), (layout.width - inset, layout.height - inset), (inset, layout.height - inset)):
            outline.Append(mm(ox + x), mm(oy + y))
        board.Add(z)
        out.append({"layer": lname, "net": short_net(net)})
    return out


def _fanout_planes(board, plane_nets: list[str], profile: FabProfile) -> dict[str, Any]:
    """Connect every surface-mount pin of the inner-plane nets to its plane before routing: a short stub from the pad
    to a via placed clear of other pins. Freerouting does not drop vias to planes on its own (it left every plane pin
    unrouted), so the router is then given only the signal nets."""
    pcbnew = _pcbnew()
    mm, to_mm = pcbnew.FromMM, pcbnew.ToMM
    via_d, drill = profile.via_diameter_mm, profile.via_drill_mm
    clear = max(profile.clearance_mm, 0.15)
    # Stubs out of fine-pitch pins (0.5 mm LQFP) run between their neighbours: thinner, at the fab's minimum rules.
    # Plane nets are in the Power net class, whose clearance is the profile's normal clearance (not the minimum).
    stub_clear = max(profile.clearance_mm, profile.min_clearance_mm, 0.1)
    track_w = max(profile.min_track_mm, min(profile.track_mm, 0.25))
    # The board outline's extent, from the Edge.Cuts drawings.
    xs: list[float] = []
    ys: list[float] = []
    for d in board.GetDrawings():
        if d.GetLayer() == pcbnew.Edge_Cuts:
            bb = d.GetBoundingBox()
            xs += [to_mm(bb.GetX()), to_mm(bb.GetX() + bb.GetWidth())]
            ys += [to_mm(bb.GetY()), to_mm(bb.GetY() + bb.GetHeight())]
    ex0, ey0, ex1, ey1 = (min(xs), min(ys), max(xs), max(ys)) if xs else (-1e9, -1e9, 1e9, 1e9)
    margin = max(profile.copper_edge_clearance_mm, 0.3) + via_d / 2
    wanted = set(plane_nets)
    pads = list(board.GetPads())

    def box(p):
        bb = p.GetBoundingBox()
        x, y = to_mm(bb.GetX()), to_mm(bb.GetY())
        return (x, y, x + to_mm(bb.GetWidth()), y + to_mm(bb.GetHeight()))

    # Obstacles: every pad (with its net), and the vias placed so far.
    obstacles = [(box(p), p.GetNetname(), p.IsOnLayer(pcbnew.F_Cu), p.IsOnLayer(pcbnew.B_Cu)) for p in pads]
    placed: list[tuple[float, float, str]] = []

    def dist_to_box(x: float, y: float, b) -> float:
        dx = max(b[0] - x, 0.0, x - b[2])
        dy = max(b[1] - y, 0.0, y - b[3])
        return (dx * dx + dy * dy) ** 0.5

    def via_ok(x: float, y: float, net: str) -> bool:
        if not (ex0 + margin <= x <= ex1 - margin and ey0 + margin <= y <= ey1 - margin):
            return False
        for b, n, _f, _b in obstacles:
            # A through via touches every layer: keep it clear of all pads but its own net's.
            if n != net and dist_to_box(x, y, b) < via_d / 2 + clear:
                return False
        return all(((x - vx) ** 2 + (y - vy) ** 2) ** 0.5 >= via_d + clear for vx, vy, _n in placed)

    def stub_ok(x0: float, y0: float, x1: float, y1: float, net: str, top: bool, width: float) -> bool:
        steps = max(12, int(((x1 - x0) ** 2 + (y1 - y0) ** 2) ** 0.5 / 0.05))
        for i in range(1, steps + 1):
            t = i / steps
            x, y = x0 + (x1 - x0) * t, y0 + (y1 - y0) * t
            for b, n, on_f, on_b in obstacles:
                if n != net and (on_f if top else on_b) and dist_to_box(x, y, b) < width / 2 + stub_clear:
                    return False
        return True

    done, missed = 0, []
    for pad in pads:
        net = pad.GetNetname()
        if net not in wanted or pad.GetAttribute() not in (pcbnew.PAD_ATTRIB_SMD, pcbnew.PAD_ATTRIB_CONN):
            continue
        top = pad.IsOnLayer(pcbnew.F_Cu)
        layer = pcbnew.F_Cu if top else pcbnew.B_Cu
        b = box(pad)
        px, py = to_mm(pad.GetPosition().x), to_mm(pad.GetPosition().y)
        fp = pad.GetParentFootprint()
        cx, cy = (to_mm(fp.GetPosition().x), to_mm(fp.GetPosition().y)) if fp else (px, py)
        # Directions: away from the part's centre first, then the other seven.
        import math
        away = math.atan2(py - cy, px - cx) if (px, py) != (cx, cy) else 0.0
        angles = [away + k * math.pi / 4 for k in (0, 1, -1, 2, -2, 3, -3, 4)]
        # An elongated pin (QFP, SOIC, connector) is left straight out along its length first, the only way that does
        # not cross its neighbours.
        w, h = b[2] - b[0], b[3] - b[1]
        if max(w, h) > 1.3 * min(w, h):
            axis = (0.0 if px >= cx else math.pi) if w > h else (math.pi / 2 if py >= cy else -math.pi / 2)
            angles = [axis] + angles
        reach = max(b[2] - b[0], b[3] - b[1]) / 2
        width = max(profile.min_track_mm, min(track_w, min(b[2] - b[0], b[3] - b[1]) * 0.6))
        spot = None
        for extra in (0.35, 0.6, 0.9, 1.3, 1.8, 2.5, 3.2):
            for a in angles:
                d = reach + via_d / 2 + extra
                x, y = px + d * math.cos(a), py + d * math.sin(a)
                if via_ok(x, y, net) and stub_ok(px, py, x, y, net, top, width):
                    spot = (x, y)
                    break
            if spot:
                break
        ref = fp.GetReference() if fp else "?"
        if not spot:
            missed.append(f"{ref}.{pad.GetNumber()}")
            continue
        netinfo = pad.GetNet()
        via = pcbnew.PCB_VIA(board)
        via.SetPosition(pcbnew.VECTOR2I(mm(spot[0]), mm(spot[1])))
        try:
            via.SetWidth(mm(via_d))
        except TypeError:
            via.SetWidth(pcbnew.F_Cu, mm(via_d))
        via.SetDrill(mm(drill))
        via.SetNet(netinfo)
        board.Add(via)
        track = pcbnew.PCB_TRACK(board)
        track.SetStart(pad.GetPosition())
        track.SetEnd(pcbnew.VECTOR2I(mm(spot[0]), mm(spot[1])))
        track.SetWidth(mm(width))
        track.SetLayer(layer)
        track.SetNet(netinfo)
        board.Add(track)
        placed.append((spot[0], spot[1], net))
        done += 1
    return {"vias": done, "missed": missed[:50], "missed_count": len(missed), "nets": [short_net(n) for n in plane_nets]}


def _drop_nets_from_dsn(dsn: Path, nets: list[str]) -> int:
    """Take nets out of a Specctra design's netlist so the router leaves them alone (they reach their planes through
    the fanout vias). Returns how many were removed."""
    text = dsn.read_text()
    removed = 0
    for net in nets:
        quoted = [f'"{net}"', net]
        for q in quoted:
            start = text.find(f"(net {q}\n")
            if start < 0:
                start = text.find(f"(net {q} ")
            if start < 0:
                continue
            depth, i = 0, start
            while i < len(text):
                if text[i] == "(":
                    depth += 1
                elif text[i] == ")":
                    depth -= 1
                    if depth == 0:
                        break
                i += 1
            text = text[:start] + text[i + 1:]
            removed += 1
            break
        # Class membership lists name the net too.
        text = re.sub(rf'(\(class [^\n]*?)\s(?:"{re.escape(net)}"|{re.escape(net)})(?=[\s)])', r"\1", text)
    dsn.write_text(text)
    return removed


# --- DRC --------------------------------------------------------------------------------

def drc(project_dir: Path, pcb: str, refill: bool = True, parity: bool = True) -> dict[str, Any]:
    """KiCad DRC, with schematic parity unless asked not to (an imported board has no KiCad schematic). Exit code
    ignored: violations are data. Excluded items are waivers."""
    args = ["kicad-cli", "pcb", "drc", "--format", "json", "--severity-all", "--severity-exclusions",
            *(["--schematic-parity"] if parity else []), "--units", "mm", "-o", "drc.json"]
    if refill:
        args += ["--refill-zones", "--save-board"]
    subprocess.run(args + [pcb], cwd=project_dir, capture_output=True, text=True, timeout=600, env=_kicad_env())
    path = project_dir / "drc.json"
    if not path.exists():
        raise kicad.KicadError("kicad-cli did not write a DRC report (the board may not load)")
    report = json.loads(path.read_text())

    def simplify(v: dict) -> dict:
        return {"severity": v.get("severity"), "type": v.get("type"), "description": v.get("description"),
                "excluded": bool(v.get("excluded")),
                "items": [{"description": i.get("description"), "pos": i.get("pos")} for i in v.get("items", [])]}

    violations = [simplify(v) for v in report.get("violations", [])]
    # A hole-clearance clash between two features of the same footprint (a USB-C receptacle's pad beside its own
    # locating hole) is the library footprint's geometry, not something placement or routing can change: waived,
    # with the reason kept.
    for v in violations:
        refs = {m.group(1) for i in v["items"] for m in [re.search(r" of ([A-Z]+[0-9]+)\b", i.get("description") or "")] if m}
        if v["type"] == "hole_clearance" and len(refs) == 1 and len(v["items"]) >= 2 and all(" of " in (i.get("description") or "") for i in v["items"]):
            v["excluded"] = True
            v["waiver"] = f"inside footprint {next(iter(refs))}: the library footprint's own pad-to-hole spacing"
    unconnected = [simplify(v) for v in report.get("unconnected_items", [])]
    parity = [simplify(v) for v in report.get("schematic_parity", [])]
    live = [v for v in violations + unconnected + parity if not v["excluded"]]
    return {
        "report": report,
        "errors": sum(v["severity"] == "error" for v in live),
        "warnings": sum(v["severity"] == "warning" for v in live),
        "unconnected": sum(not v["excluded"] for v in unconnected),
        "parity": sum(not v["excluded"] for v in parity),
        "waived": sum(v["excluded"] for v in violations + unconnected + parity),
        "violations": violations, "unconnected_items": unconnected, "schematic_parity": parity,
    }


def fix_starved_thermals(project_dir: Path, pcb: str, report: dict[str, Any]) -> list[str]:
    """Pads whose thermal relief spokes cannot all reach the pour get a solid zone connection instead."""
    pcbnew = _pcbnew()
    targets = set()
    for v in report["violations"]:
        if v["type"] == "starved_thermal" and not v["excluded"]:
            for item in v["items"]:
                m = re.search(r"\bpad (\S+) \[[^\]]*\] of (\S+)", item["description"] or "")
                if m:
                    targets.add((m.group(2), m.group(1)))
    if not targets:
        return []
    path = str(project_dir / pcb)
    board = pcbnew.LoadBoard(path)
    fixed = []
    for fp in board.GetFootprints():
        for pad in fp.Pads():
            if (fp.GetReference(), pad.GetNumber()) in targets:
                pad.SetLocalZoneConnection(pcbnew.ZONE_CONNECTION_FULL)
                fixed.append(f"{fp.GetReference()}.{pad.GetNumber()}")
    pcbnew.SaveBoard(path, board)
    return sorted(fixed)


# --- 3D models --------------------------------------------------------------------------

def _kicad_env() -> dict[str, str]:
    return {**os.environ, MODEL_VAR: str(MODEL_CACHE)}


def _model_tag() -> str:
    m = re.search(r"\d+\.\d+\.\d+", kicad.version())
    return m.group(0) if m else "master"


def fetch_models(board) -> list[dict[str, Any]]:
    """Makes sure every footprint's KiCad library 3D model is in the local cache (fetched once per model)."""
    tag = _model_tag()
    allow_fetch = os.environ.get("VX_3DMODEL_FETCH", "1") != "0"
    results = []
    seen: dict[str, dict] = {}
    for fp in sorted(board.GetFootprints(), key=lambda f: f.GetReference()):
        ref = fp.GetReference()
        models = [m.m_Filename for m in fp.Models() if m.m_Show]
        if not models:
            results.append({"ref": ref, "footprint": str(fp.GetFPID().GetUniStringLibId()), "status": "none", "model": None})
            continue
        for model in models:
            if model.startswith("${KIPRJMOD}/"):
                results.append({"ref": ref, "footprint": str(fp.GetFPID().GetUniStringLibId()), "model": model[len("${KIPRJMOD}/"):],
                                "status": "found", "source": "manufacturer model (verified library entry)"})
                continue
            m = re.match(r"^\$\{KICAD\d*_3DMODEL_DIR\}/(.+)$", model)
            if not m:
                results.append({"ref": ref, "footprint": str(fp.GetFPID().GetUniStringLibId()), "status": "unsupported_path", "model": model})
                continue
            rel = m.group(1)
            if rel not in seen:
                seen[rel] = _ensure_model(rel, tag, allow_fetch)
            results.append({"ref": ref, "footprint": str(fp.GetFPID().GetUniStringLibId()), "model": rel, **seen[rel]})
    return results


def _ssl_context() -> ssl.SSLContext:
    """System CAs plus the worker's extra CA (NODE_EXTRA_CA_CERTS, shared with the Node worker), if any."""
    ctx = ssl.create_default_context()
    extra = os.environ.get("NODE_EXTRA_CA_CERTS")
    if extra and Path(extra).exists():
        ctx.load_verify_locations(extra)
    return ctx


def _ensure_model(rel: str, tag: str, allow_fetch: bool) -> dict[str, Any]:
    dest = MODEL_CACHE / rel
    url = MODEL_URL.format(tag=tag, path=rel)
    if not dest.exists() and allow_fetch:
        dest.parent.mkdir(parents=True, exist_ok=True)
        try:
            req = urllib.request.Request(url, headers={"user-agent": "VX-Design-3d-models/1.0"})
            with urllib.request.urlopen(req, timeout=60, context=_ssl_context()) as r:
                data = r.read()
            if not data.startswith(b"ISO-10303-21"):
                return {"status": "missing", "source": url, "error": "not a STEP file"}
            tmp = dest.with_suffix(dest.suffix + ".part")
            tmp.write_bytes(data)
            tmp.replace(dest)
        except (urllib.error.URLError, OSError, TimeoutError) as e:
            return {"status": "missing", "source": url, "error": str(e)[:200]}
    if not dest.exists():
        return {"status": "missing", "source": url, "error": "not in the local cache and fetching is off"}
    return {"status": "found", "source": url, "sha256": hashlib.sha256(dest.read_bytes()).hexdigest(),
            "bytes": dest.stat().st_size}


# --- Build --------------------------------------------------------------------------------

def install_models(project_dir: Path, models: dict[str, dict[str, Any]]) -> dict[str, str]:
    """Copies verified manufacturer models into the project (3dmodels/) and returns ref -> ${KIPRJMOD} path."""
    out = {}
    if not models:
        return out
    (project_dir / "3dmodels").mkdir(exist_ok=True)
    for ref, m in models.items():
        name = f"{re.sub(r'[^A-Za-z0-9_.-]+', '_', m.get('name') or ref)}.step"
        (project_dir / "3dmodels" / name).write_bytes(Path(m["path"]).read_bytes())
        out[ref] = f"${{KIPRJMOD}}/3dmodels/{name}"
    return out


def seed_ids(*parts: object) -> None:
    """KiCad gives every new board item a random UUID and saves items in UUID order, so two builds of the same design
    would give different files (and different Gerbers). Seeding KiCad's UUID generator from the inputs makes the same
    inputs give the same board (G6 regression suite)."""
    import dataclasses
    import hashlib
    import json
    norm = [dataclasses.asdict(p) if dataclasses.is_dataclass(p) and not isinstance(p, type) else p for p in parts]
    digest = hashlib.sha256(json.dumps(norm, sort_keys=True, default=str).encode()).hexdigest()
    _pcbnew().KIID.SeedGenerator(int(digest[:8], 16))


def build_board(circuit: Circuit, layout: Layout, project_dir: Path, name: str, title: str,
                route: bool = True, models: dict[str, dict[str, Any]] | None = None) -> dict[str, Any]:
    """Creates <name>.kicad_pcb in a project directory that already holds the generated schematic and netlist."""
    pcbnew = _pcbnew()
    seed_ids("board", name, title, circuit, layout, sorted((models or {}).items()))
    profile = PROFILES[layout.fab_profile]
    paths, pin_net_names, fields = _read_netlist(project_dir / "netlist.net")
    board = pcbnew.CreateEmptyBoard()
    apply_to_board(board, profile)
    nets = {}
    for net_name in sorted(set(pin_net_names.values())):
        item = pcbnew.NETINFO_ITEM(board, net_name)
        board.Add(item)
        nets[net_name] = item
    pin_nets = {k: nets[v] for k, v in pin_net_names.items()}
    _place(board, circuit, layout, paths, pin_nets, fields, install_models(project_dir, models or {}))
    _outline(board, layout)
    tb = board.GetTitleBlock()
    tb.SetTitle(title[:60])
    tb.SetCompany("VX Design")
    tb.SetComment(0, "Generated by VX Design from an AI-proposed layout: review before ordering.")
    board.SetFileName(str(project_dir / f"{name}.kicad_pcb"))

    power = sorted(n for n in nets if POWER_NET.match(short_net(n)))
    _write_project(project_dir / f"{name}.kicad_pro", profile, power)
    _assign_netclasses(board, profile, power)

    planes: list[dict[str, str]] = []
    fanout: dict[str, Any] | None = None
    plane_full: list[str] = []
    if profile.layers == 4:
        plane_full = _plane_nets(layout, nets, power, pin_net_names)
        planes = _inner_planes(board, layout, profile, plane_full, nets)
        fanout = _fanout_planes(board, plane_full, profile)
        pcbnew.ZONE_FILLER(board).Fill(board.Zones())
    # Plane nets are connected by the fanout; the router only connects signals (and any pin the fanout missed is
    # reported as unrouted by DRC, as before).
    skip = plane_full if fanout and not fanout["missed_count"] else []
    routing = _route(board, project_dir, skip) if route else {"router": None, "segments": 0, "vias": 0}
    # The router sometimes leaves a sliver narrower than the fab minimum where it necks into a pad: widen it.
    min_w = pcbnew.FromMM(profile.min_track_mm)
    widened = 0
    for t in board.GetTracks():
        if t.GetClass() == "PCB_TRACK" and t.GetWidth() < min_w:
            t.SetWidth(min_w)
            widened += 1
    routing["widened_to_minimum"] = widened
    routing["planes"] = planes
    if fanout:
        routing["fanout"] = fanout
    pour_layers: list[str] = []
    pour_net = next((n for n in nets if layout.ground_pour and short_net(n) == layout.ground_pour), None)
    if pour_net:
        pour_layers = _ground_pour(board, layout, profile, nets[pour_net])
    _set_grid_origin(board)
    pcbnew.SaveBoard(str(project_dir / f"{name}.kicad_pcb"), board)
    routing["ground_pour"] = {"net": layout.ground_pour, "layers": pour_layers} if pour_layers else None
    routing["power_nets"] = [short_net(n) for n in power]
    return {"board": board, "routing": routing, "profile": profile}


def _set_grid_origin(board) -> None:
    pcbnew = _pcbnew()
    ds = board.GetDesignSettings()
    origin = pcbnew.VECTOR2I(pcbnew.FromMM(ORIGIN_MM[0]), pcbnew.FromMM(ORIGIN_MM[1]))
    try:
        ds.SetAuxOrigin(origin)
        ds.SetGridOrigin(origin)
    except AttributeError:
        pass


def _assign_netclasses(board, profile: FabProfile, power: list[str]) -> None:
    """Power class in memory too, so the router uses the wider tracks."""
    if not power:
        return
    pcbnew = _pcbnew()
    try:
        ns = board.GetDesignSettings().m_NetSettings
        nc = pcbnew.NETCLASS("Power")
        nc.SetTrackWidth(pcbnew.FromMM(profile.power_track_mm))
        nc.SetClearance(pcbnew.FromMM(profile.clearance_mm))
        nc.SetViaDiameter(pcbnew.FromMM(profile.via_diameter_mm))
        nc.SetViaDrill(pcbnew.FromMM(profile.via_drill_mm))
        ns.SetNetclass("Power", nc)
        for n in power:
            ns.SetNetclassPatternAssignment(n, "Power")
        board.SynchronizeNetsAndNetClasses(True)
    except (AttributeError, TypeError):
        pass   # older bindings: the .kicad_pro still carries the classes for DRC and the editor


def _write_project(pro: Path, profile: FabProfile, power: list[str]) -> None:
    data = json.loads(pro.read_text()) if pro.exists() else {"meta": {"filename": pro.name, "version": 3}}
    data.update(project_settings(profile, power))
    pro.write_text(json.dumps(data, indent=2))


def exports(project_dir: Path, pcb: str) -> dict[str, str]:
    """Layer drawings, 3D renders, STEP and GLB. Returns file keys -> names actually written."""
    env = _kicad_env()
    out: dict[str, str] = {}

    def run(args: list[str], key: str, name: str, timeout: int = 600) -> None:
        p = subprocess.run(args, cwd=project_dir, capture_output=True, text=True, timeout=timeout, env=env)
        if (project_dir / name).exists() and (project_dir / name).stat().st_size > 0:
            out[key] = name
        else:
            out.setdefault("_errors", "")
            out["_errors"] += f"{key}: {(p.stderr or p.stdout).strip()[-300:]}\n"

    common = ["--mode-single", "--exclude-drawing-sheet", "--fit-page-to-board"]
    run(["kicad-cli", "pcb", "export", "svg", "--layers", "Edge.Cuts,F.Cu,F.Mask,F.Silkscreen,F.Fab", *common,
         "-o", "pcb-top.svg", pcb], "svg_top", "pcb-top.svg")
    run(["kicad-cli", "pcb", "export", "svg", "--layers", "Edge.Cuts,B.Cu,B.Mask,B.Silkscreen,B.Fab", "--mirror", *common,
         "-o", "pcb-bottom.svg", pcb], "svg_bottom", "pcb-bottom.svg")
    run(["kicad-cli", "pcb", "export", "pdf", "--layers", "Edge.Cuts,F.Cu,B.Cu,F.Silkscreen,F.Fab", "--mode-single",
         "-o", "pcb.pdf", pcb], "pdf", "pcb.pdf")
    for side, rot in (("top", None), ("bottom", None), ("iso", "-45,0,45")):
        args = ["kicad-cli", "pcb", "render", "--width", "1600", "--height", "1000", "--quality", "high",
                "--background", "opaque", "-o", f"render-{side}.png"]
        args += ["--side", "top", "--rotate", rot, "--perspective", "--zoom", "0.9"] if rot else ["--side", side]
        run(args + [pcb], f"render_{side}", f"render-{side}.png")
    run(["kicad-cli", "pcb", "export", "step", "--subst-models", "-f", "-o", "board.step", pcb], "step", "board.step", 900)
    run(["kicad-cli", "pcb", "export", "glb", "--subst-models", "--include-tracks", "--include-pads", "--include-zones",
         "--include-silkscreen", "--include-soldermask", "-f", "-o", "board.glb", pcb], "glb", "board.glb", 900)
    return out


def board_facts(board) -> dict[str, Any]:
    pcbnew = _pcbnew()
    return {
        "footprints": len(board.GetFootprints()),
        "nets": max(0, board.GetNetCount() - 1),
        "copper_layers": board.GetCopperLayerCount(),
        "zones": len(list(board.Zones())),
        "thickness_mm": round(pcbnew.ToMM(board.GetDesignSettings().GetBoardThickness()), 2),
    }
