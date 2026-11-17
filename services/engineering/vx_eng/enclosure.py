"""Enclosure from the routed board: a two-part housing (base with standoffs, lid with a locating lip) built
around the board's own outline and 3D models, then checked for fit.

Coordinates are those of KiCad's STEP export with --drill-origin: X right and Y up from the board's top-left
corner (Y = -board y), board bottom at Z = 0, board top at Z = thickness.

  cavity    the board outline offset by the edge gap, from the floor (standoff height below the board) to the
            lid's inner face (tallest enclosed component + top clearance)
  base      floor, walls up to the split plane, a standoff with a screw hole (heat-set insert, pilot or tapped)
            under every mounting hole
  lid       walls above the split plane and the top, with a lip that locates it inside the base
  openings  edge openings for connectors (through the nearest wall, sized from the connector's 3D model) and
            top openings (light holes, header and button windows)

Checks: every component's 3D model and the board against both parts (any overlap is an error, naming the part),
clearance to the walls, edge connectors reachable from outside, screw bosses deep enough for the fastener,
process limits (wall, boss wall, inner corner radius for CNC, build volume). Parts without a 3D model cannot be
checked and are reported.
"""
from __future__ import annotations

import json
import math
import os
import re
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import kicad


@dataclass(frozen=True)
class Process:
    name: str
    label: str
    min_wall_mm: float
    min_boss_wall_mm: float
    fit_clearance_mm: float        # lid lip to base wall
    min_inner_radius_mm: float     # CNC tool radius; 0 for printing
    build_mm: tuple[float, float, float]
    density_g_cm3: float
    fastenings: tuple[str, ...]


PROCESSES: dict[str, Process] = {p.name: p for p in (
    Process("fdm", "FDM 3D print (PETG/PLA/ASA)", 1.2, 1.2, 0.25, 0.0, (250, 210, 210), 1.27, ("heat_set_insert", "self_tapping")),
    Process("sla", "SLA resin print", 0.8, 1.0, 0.15, 0.0, (145, 145, 175), 1.18, ("heat_set_insert", "self_tapping")),
    Process("sls", "SLS/MJF nylon print", 0.8, 1.0, 0.2, 0.0, (340, 340, 600), 1.01, ("heat_set_insert", "self_tapping")),
    Process("cnc_aluminum", "CNC machined aluminium 6061", 1.0, 1.0, 0.1, 1.5, (500, 400, 150), 2.70, ("tapped",)),
)}

# Hole diameter and the depth the fastener needs, per screw size. Heat-set insert sizes are typical catalogue
# values (check the insert maker's table); pilot holes are for thread-forming screws in plastic; tapped are
# ISO coarse tap drills.
FASTENER_HOLES: dict[str, dict[str, tuple[float, float]]] = {
    "heat_set_insert": {"M2": (3.2, 4.0), "M2.5": (3.6, 4.5), "M3": (4.2, 5.7)},
    "self_tapping": {"M2": (1.6, 5.0), "M2.5": (2.0, 6.0), "M3": (2.5, 6.0)},
    "tapped": {"M2": (1.6, 4.0), "M2.5": (2.05, 5.0), "M3": (2.5, 6.0)},
}
SIDES = ("left", "right", "front", "back")
LIP_HEIGHT_MM = 2.0
SPLIT_ABOVE_BOARD_MM = 2.5


@dataclass
class Opening:
    kind: str                 # "edge" or "top"
    ref: str
    side: str | None = None   # edge: left/right/front/back, or None to use the nearest wall
    shape: str = "rect"       # top: "round" or "rect"
    size_mm: float | None = None
    margin_mm: float = 0.5


@dataclass
class EnclosureSpec:
    process: str
    material: str
    wall_mm: float
    edge_gap_mm: float
    top_clearance_mm: float
    standoff_height_mm: float
    fastening: str
    openings: list[Opening] = field(default_factory=list)

    @staticmethod
    def from_json(d: dict[str, Any]) -> "EnclosureSpec":
        return EnclosureSpec(
            process=str(d.get("process") or "fdm"), material=str(d.get("material") or ""),
            wall_mm=float(d.get("wall_mm") or 2), edge_gap_mm=float(d.get("edge_gap_mm") or 0.5),
            top_clearance_mm=float(d.get("top_clearance_mm") or 2), standoff_height_mm=float(d.get("standoff_height_mm") or 4),
            fastening=str(d.get("fastening") or "heat_set_insert"),
            openings=[Opening(kind=str(o["kind"]), ref=str(o["ref"]), side=o.get("side"), shape=str(o.get("shape") or "rect"),
                              size_mm=o.get("size_mm"), margin_mm=float(o.get("margin_mm") if o.get("margin_mm") is not None else 0.5))
                      for o in d.get("openings") or []],
        )


def _cq():
    import cadquery as cq
    return cq


def _problem(code: str, message: str, **extra: Any) -> dict[str, Any]:
    return {"code": code, "message": message, **extra}


def _r(v: float, n: int = 2) -> float:
    return round(float(v), n)


# --- Board facts ------------------------------------------------------------------------------

def board_facts(project_dir: Path, pcb: str) -> dict[str, Any]:
    """Thickness, mounting holes (STEP coordinates) and components of the routed board."""
    import pcbnew
    board = pcbnew.LoadBoard(str(project_dir / pcb))
    origin = board.GetDesignSettings().GetAuxOrigin()
    to = lambda p: (_r(pcbnew.ToMM(p.x - origin.x), 3), _r(-pcbnew.ToMM(p.y - origin.y), 3))  # noqa: E731
    holes, parts = [], []
    for fp in board.GetFootprints():
        if fp.IsBoardOnly() and "MountingHole" in str(fp.GetFPID().GetLibNickname()):
            pad = next(iter(fp.Pads()), None)
            drill = pcbnew.ToMM(pad.GetDrillSize().x) if pad else 3.2
            size = "M2" if drill < 2.45 else "M2.5" if drill < 2.95 else "M3"
            x, y = to(fp.GetPosition())
            holes.append({"ref": fp.GetReference(), "x": x, "y": y, "drill_mm": _r(drill), "size": size})
            continue
        x, y = to(fp.GetPosition())
        parts.append({"ref": fp.GetReference(), "value": fp.GetValue(), "x": x, "y": y, "side": "bottom" if fp.IsFlipped() else "top",
                      "has_model": any(m.m_Show for m in fp.Models())})
    return {"thickness_mm": _r(pcbnew.ToMM(board.GetDesignSettings().GetBoardThickness()), 3), "holes": holes,
            "parts": sorted(parts, key=lambda p: p["ref"])}


def export_solids(project_dir: Path, pcb: str, refs: list[str], env: dict[str, str]) -> tuple[Any, dict[str, Any]]:
    """Board body and each component as solids, from KiCad's STEP export (drill origin)."""
    cq = _cq()
    work = project_dir / "enclosure-step"
    work.mkdir(exist_ok=True)
    def export(args: list[str], out: str) -> Path | None:
        p = subprocess.run(["kicad-cli", "pcb", "export", "step", "--drill-origin", "--subst-models", "-f", *args, "-o", str(work / out), pcb],
                           cwd=project_dir, capture_output=True, text=True, timeout=600, env=env)
        return work / out if (work / out).exists() and (work / out).stat().st_size > 0 else None
    board_step = export(["--board-only"], "board.step")
    if not board_step:
        raise kicad.KicadError("KiCad could not export the board body to STEP")
    board = cq.importers.importStep(str(board_step)).val()
    comps: dict[str, Any] = {}
    for ref in refs:
        f = export(["--no-board-body", "--component-filter", ref], f"{re.sub(r'[^A-Za-z0-9_]', '_', ref)}.step")
        if f:
            solids = cq.importers.importStep(str(f)).solids().vals()
            if solids:
                comps[ref] = cq.Compound.makeCompound(solids)
    return board, comps


# --- Geometry ------------------------------------------------------------------------------------

def _outline_face(board):
    """The board's top face outline (outer wire) as a planar face at Z = 0."""
    cq = _cq()
    top = max(board.Faces(), key=lambda f: (f.Center().z, f.Area()))
    wire = top.outerWire()
    return cq.Face.makeFromWires(wire.translate(cq.Vector(0, 0, -top.Center().z)))


def _prism(face, offset: float, z0: float, z1: float):
    """The outline offset outward by `offset`, extruded from z0 to z1."""
    cq = _cq()
    wire = face.outerWire().offset2D(offset, "arc")[0] if offset else face.outerWire()
    base = cq.Face.makeFromWires(wire.translate(cq.Vector(0, 0, z0)))
    return cq.Solid.extrudeLinear(base, cq.Vector(0, 0, z1 - z0))


def _box(x0, x1, y0, y1, z0, z1):
    cq = _cq()
    return cq.Solid.makeBox(x1 - x0, y1 - y0, z1 - z0, cq.Vector(x0, y0, z0))


def build(spec: EnclosureSpec, board, comps: dict[str, Any], facts: dict[str, Any]) -> dict[str, Any]:
    cq = _cq()
    proc = PROCESSES[spec.process]
    t = facts["thickness_mm"]
    face = _outline_face(board)
    bb = board.BoundingBox()
    opened_top = {o.ref for o in spec.openings if o.kind == "top"}
    enclosed_tops = [c.BoundingBox().zmax for r, c in comps.items() if r not in opened_top]
    top_inner = max([t, *enclosed_tops]) + spec.top_clearance_mm
    split = min(t + SPLIT_ABOVE_BOARD_MM, top_inner - 0.5)
    floor_top = -spec.standoff_height_mm
    floor_bottom = floor_top - spec.wall_mm
    top_outer = top_inner + spec.wall_mm
    g, w = spec.edge_gap_mm, spec.wall_mm

    # Built additively (slabs and rings extruded from the outline, then fused). Cutting one prism through
    # another, or a shell with a box, failed silently in OCCT and left a closed box.
    def ring(outer_off: float, inner_off: float, z0: float, z1: float):
        ow = face.outerWire().offset2D(outer_off, "arc")[0].translate(cq.Vector(0, 0, z0))
        iw = face.outerWire().offset2D(inner_off, "arc")[0].translate(cq.Vector(0, 0, z0))
        return cq.Solid.extrudeLinear(cq.Face.makeFromWires(ow, [iw]), cq.Vector(0, 0, z1 - z0))

    outer = _prism(face, g + w, floor_bottom, top_outer)
    cavity = _prism(face, g, floor_top, top_inner)
    base = _prism(face, g + w, floor_bottom, floor_top).fuse(ring(g + w, g, floor_top, split))
    lid = ring(g + w, g, split, top_inner).fuse(_prism(face, g + w, top_inner, top_outer))

    # Lid lip: a ring just inside the base wall, below the split plane.
    lip_h = min(LIP_HEIGHT_MM, max(0.0, split - t - 0.3))
    if lip_h > 0:
        lip_t = max(proc.min_wall_mm, w / 2)
        lid = lid.fuse(ring(g - proc.fit_clearance_mm, g - proc.fit_clearance_mm - lip_t, split - lip_h, split))

    # Standoffs with fastener holes under the mounting holes.
    hole_d = {}
    for h in facts["holes"]:
        d, _depth = FASTENER_HOLES.get(spec.fastening, FASTENER_HOLES["heat_set_insert"]).get(h["size"], (3.2, 5.0))
        od = d + 2 * proc.min_boss_wall_mm + 0.4
        boss = cq.Solid.makeCylinder(od / 2, spec.standoff_height_mm, cq.Vector(h["x"], h["y"], floor_top))
        hole = cq.Solid.makeCylinder(d / 2, spec.standoff_height_mm + 0.01, cq.Vector(h["x"], h["y"], floor_top))
        base = base.fuse(boss).cut(hole)
        hole_d[h["ref"]] = {"hole_mm": d, "boss_od_mm": _r(od)}

    # Openings.
    cuts, opening_facts = [], []
    ob = outer.BoundingBox()
    for o in spec.openings:
        c = comps.get(o.ref)
        if c is None:
            opening_facts.append({"ref": o.ref, "kind": o.kind, "error": "no 3D model, so the opening cannot be placed"})
            continue
        cb = c.BoundingBox()
        m = o.margin_mm
        if o.kind == "edge":
            side = o.side or _nearest_side(cb, ob)
            z0, z1 = max(cb.zmin, t) - m, cb.zmax + m
            if side == "left":
                box = _box(ob.xmin - 1, cb.xmax, cb.ymin - m, cb.ymax + m, z0, z1)
            elif side == "right":
                box = _box(cb.xmin, ob.xmax + 1, cb.ymin - m, cb.ymax + m, z0, z1)
            elif side == "front":       # front = -Y (bottom edge of the board drawing)
                box = _box(cb.xmin - m, cb.xmax + m, ob.ymin - 1, cb.ymax, z0, z1)
            else:
                box = _box(cb.xmin - m, cb.xmax + m, cb.ymin, ob.ymax + 1, z0, z1)
            recess = {"left": cb.xmin - ob.xmin, "right": ob.xmax - cb.xmax, "front": cb.ymin - ob.ymin, "back": ob.ymax - cb.ymax}[side]
            opening_facts.append({"ref": o.ref, "kind": "edge", "side": side, "width_mm": _r(max(box.BoundingBox().xlen, box.BoundingBox().ylen) if side in ("front", "back") else box.BoundingBox().ylen),
                                  "height_mm": _r(z1 - z0), "recess_mm": _r(recess)})
        else:
            cx, cy = (cb.xmin + cb.xmax) / 2, (cb.ymin + cb.ymax) / 2
            if o.shape == "round":
                dia = o.size_mm or max(cb.xlen, cb.ylen) + 2 * m
                box = cq.Solid.makeCylinder(dia / 2, top_outer - split + 2, cq.Vector(cx, cy, split - 1))
                opening_facts.append({"ref": o.ref, "kind": "top", "shape": "round", "diameter_mm": _r(dia)})
            else:
                box = _box(cb.xmin - m, cb.xmax + m, cb.ymin - m, cb.ymax + m, split - 1, top_outer + 1)
                opening_facts.append({"ref": o.ref, "kind": "top", "shape": "rect", "width_mm": _r(cb.xlen + 2 * m), "depth_mm": _r(cb.ylen + 2 * m)})
        cuts.append(box)
    for box in cuts:
        base = _checked_cut(base, box)
        lid = _checked_cut(lid, box)
    # Sanity check on the geometry kernel: base and lid stay on their side of the split, and the walls,
    # floor and top add up to the outer prism minus the cavity (before bosses, lip and openings).
    bz, lz = base.BoundingBox(), lid.BoundingBox()
    if bz.zmax > split + 0.01 or lz.zmin < split - lip_h - 0.01:
        raise kicad.KicadError(f"enclosure geometry is wrong: base reaches {bz.zmax:.2f} mm and lid {lz.zmin:.2f} mm around the {split:.2f} mm split")
    return {"base": base, "lid": lid, "cavity": cavity, "outer_bb": ob,
            "levels": {"floor_bottom": _r(floor_bottom), "floor_top": _r(floor_top), "board_top": t, "split": _r(split),
                       "lid_inner": _r(top_inner), "top_outer": _r(top_outer), "lip_height": _r(lip_h)},
            "holes": hole_d, "openings": opening_facts}


def _checked_cut(part, tool):
    """Cut, then confirm material was actually removed where the tool overlapped (OCCT can fail silently)."""
    before = part.Volume()
    out = part.cut(tool)
    removed = before - out.Volume()
    left = out.intersect(tool).Volume() if removed < 1e-6 else 0.0
    if removed < 1e-6 and left > 1e-3:
        raise kicad.KicadError("the geometry kernel failed to cut an opening; adjust its size or position slightly")
    return out


def _nearest_side(cb, ob) -> str:
    d = {"left": cb.xmin - ob.xmin, "right": ob.xmax - cb.xmax, "front": cb.ymin - ob.ymin, "back": ob.ymax - cb.ymax}
    return min(d, key=d.get)


# --- Checks ------------------------------------------------------------------------------------------

def _overlap(a, b) -> tuple[float, Any]:
    """Overlap volume of two solids. Cross-checked with a cut, because OCCT's common operation can return an
    empty result for some shapes: vol(b) - vol(b - a) must agree, else the check is reported as failed."""
    try:
        common = a.intersect(b)
        v_common = common.Volume()
        v_cut = b.Volume() - b.cut(a).Volume()
        if abs(v_common - v_cut) > max(1e-3, 0.02 * max(v_common, v_cut)):
            return -1.0, None
        return v_common, common
    except Exception:   # noqa: BLE001 - OCCT boolean failure on odd vendor geometry
        return -1.0, None


def check(spec: EnclosureSpec, built: dict[str, Any], board, comps: dict[str, Any], facts: dict[str, Any]) -> dict[str, Any]:
    proc = PROCESSES[spec.process]
    problems, warnings = [], []
    edge_refs = {o.ref for o in spec.openings if o.kind == "edge"}
    top_refs = {o.ref for o in spec.openings if o.kind == "top"}
    collisions = []
    for name, part in (("base", built["base"]), ("lid", built["lid"])):
        for ref, solid in [("board", board), *sorted(comps.items())]:
            vol, common = _overlap(part, solid)
            if vol < 0:
                warnings.append(_problem("boolean_failed", f"could not intersect {ref} with the {name}; check its fit by eye"))
            elif vol > 1e-3:
                c = common.BoundingBox()
                collisions.append({"part": name, "ref": ref, "volume_mm3": _r(vol, 3),
                                   "at": [_r((c.xmin + c.xmax) / 2), _r((c.ymin + c.ymax) / 2), _r((c.zmin + c.zmax) / 2)]})
    for c in collisions:
        hint = (" (give it an edge opening, or more top clearance)" if c["ref"] not in edge_refs | top_refs and c["ref"] != "board" else "")
        problems.append(_problem("interference", f"{c['ref']} collides with the {c['part']}: {c['volume_mm3']} mm³ of overlap around "
                                 f"({c['at'][0]}, {c['at'][1]}, {c['at'][2]}) mm{hint}", ref=c["ref"], part=c["part"]))
    # Clearance to the enclosure for parts that should not touch it.
    clear = {}
    for ref, solid in sorted(comps.items()):
        if ref in edge_refs | top_refs:
            continue
        try:
            d = min(solid.distance(built["base"]), solid.distance(built["lid"]))
        except Exception:   # noqa: BLE001
            continue
        clear[ref] = _r(d, 3)
        if 0 < d < proc.fit_clearance_mm:
            warnings.append(_problem("tight", f"{ref} is {_r(d, 2)} mm from the enclosure (under {proc.fit_clearance_mm} mm for {proc.label})", ref=ref))
    for o in built["openings"]:
        if o.get("error"):
            problems.append(_problem("opening", f"{o['ref']}: {o['error']}", ref=o["ref"]))
        elif o["kind"] == "edge" and o["recess_mm"] > 1.5:
            warnings.append(_problem("connector_recessed", f"{o['ref']} sits {o['recess_mm']} mm behind the outer wall ({o['side']}); "
                                     "a cable plug may not seat. Move it to the board edge or thin the wall locally", ref=o["ref"]))
    missing = [p["ref"] for p in facts["parts"] if p["ref"] not in comps]
    if missing:
        warnings.append(_problem("no_model", f"no 3D model for {', '.join(missing)}: their fit is not checked"))
    # Process rules.
    if spec.wall_mm < proc.min_wall_mm:
        problems.append(_problem("wall", f"walls are {spec.wall_mm} mm; {proc.label} needs at least {proc.min_wall_mm} mm"))
    if spec.fastening not in proc.fastenings:
        problems.append(_problem("fastening", f"{spec.fastening.replace('_', ' ')} does not suit {proc.label}; use {' or '.join(proc.fastenings)}"))
    for h in facts["holes"]:
        need = FASTENER_HOLES.get(spec.fastening, {}).get(h["size"], (0, 0))[1]
        if spec.standoff_height_mm < need:
            problems.append(_problem("boss_depth", f"standoff under {h['ref']} is {spec.standoff_height_mm} mm; a {h['size']} "
                                     f"{spec.fastening.replace('_', ' ')} needs {need} mm", ref=h["ref"]))
    inner_r = spec.edge_gap_mm   # board corners add their own radius; sharp corners leave just the offset arc
    if proc.min_inner_radius_mm and inner_r < proc.min_inner_radius_mm:
        problems.append(_problem("inner_radius", f"inner corners have a {_r(inner_r)} mm radius; a {proc.label} cutter needs "
                                 f"{proc.min_inner_radius_mm} mm (raise the edge gap)"))
    ob = built["outer_bb"]
    size = sorted([ob.xlen, ob.ylen, built["levels"]["top_outer"] - built["levels"]["floor_bottom"]], reverse=True)
    if any(a > b for a, b in zip(size, sorted(proc.build_mm, reverse=True))):
        problems.append(_problem("build_volume", f"the enclosure ({' x '.join(str(_r(s)) for s in size)} mm) exceeds the "
                                 f"{' x '.join(str(int(b)) for b in proc.build_mm)} mm build volume of {proc.label}"))
    return {"ok": not problems, "problems": problems, "warnings": warnings, "collisions": collisions, "clearance_mm": clear,
            "missing_models": missing}


def enclosure_facts(project_dir: Path) -> dict[str, Any]:
    """What a designer needs to plan the housing: board size, holes, and every part's 3D extent and edge distance."""
    from . import pcb as pcbmod
    import pcbnew
    pcbs = sorted(project_dir.glob("*.kicad_pcb"))
    if len(pcbs) != 1:
        raise kicad.KicadError("expected one .kicad_pcb in the project")
    pcb = pcbs[0].name
    facts = board_facts(project_dir, pcb)
    pcbmod.fetch_models(pcbnew.LoadBoard(str(project_dir / pcb)))
    board, comps = export_solids(project_dir, pcb, [p["ref"] for p in facts["parts"] if p["has_model"]], pcbmod._kicad_env())
    bb = board.BoundingBox()
    parts = []
    for p in facts["parts"]:
        c = comps.get(p["ref"])
        entry = {**p}
        if c is not None:
            cb = c.BoundingBox()
            edges = {"left": cb.xmin - bb.xmin, "right": bb.xmax - cb.xmax, "front": cb.ymin - bb.ymin, "back": bb.ymax - cb.ymax}
            side = min(edges, key=edges.get)
            entry.update({"top_z_mm": _r(cb.zmax), "bottom_z_mm": _r(cb.zmin), "height_above_board_mm": _r(cb.zmax - facts["thickness_mm"]),
                          "extent_mm": {"x": [_r(cb.xmin), _r(cb.xmax)], "y": [_r(cb.ymin), _r(cb.ymax)]},
                          "nearest_edge": side, "edge_distance_mm": _r(edges[side])})
        parts.append(entry)
    return {"ok": True, "board": {"width_mm": _r(bb.xlen), "height_mm": _r(bb.ylen), "thickness_mm": facts["thickness_mm"]},
            "holes": facts["holes"], "parts": parts,
            "processes": {k: {"label": v.label, "min_wall_mm": v.min_wall_mm, "fastenings": list(v.fastenings),
                              "min_inner_radius_mm": v.min_inner_radius_mm, "build_mm": list(v.build_mm)} for k, v in PROCESSES.items()},
            "fastener_depth_mm": {k: {s: d[1] for s, d in v.items()} for k, v in FASTENER_HOLES.items()},
            "coordinates": "X right, Y up from the board's top-left corner (Y = -board y), Z up with the board's underside at 0"}


# --- Entry point ----------------------------------------------------------------------------------

def build_enclosure(project_dir: Path, spec_json: dict[str, Any], out: Path) -> dict[str, Any]:
    from . import pcb as pcbmod
    import pcbnew
    cq = _cq()
    spec = EnclosureSpec.from_json(spec_json)
    if spec.process not in PROCESSES:
        return {"ok": False, "stage": "spec", "problems": [_problem("process", f"unknown process {spec.process!r}",
                                                                    suggestions=sorted(PROCESSES))], "warnings": []}
    bad = [o for o in spec.openings if o.kind not in ("edge", "top") or (o.side and o.side not in SIDES)]
    if bad:
        return {"ok": False, "stage": "spec", "warnings": [],
                "problems": [_problem("opening", f"opening for {o.ref}: kind must be edge or top, side one of {', '.join(SIDES)}") for o in bad]}
    pcbs = sorted(project_dir.glob("*.kicad_pcb"))
    if len(pcbs) != 1:
        raise kicad.KicadError("expected one .kicad_pcb in the project")
    pcb = pcbs[0].name
    facts = board_facts(project_dir, pcb)
    unknown = [o.ref for o in spec.openings if o.ref not in {p["ref"] for p in facts["parts"]}]
    if unknown:
        return {"ok": False, "stage": "spec", "warnings": [],
                "problems": [_problem("opening", f"opening for {r}, which is not a component on the board") for r in unknown]}
    pcbmod.fetch_models(pcbnew.LoadBoard(str(project_dir / pcb)))     # library models into the cache
    board, comps = export_solids(project_dir, pcb, [p["ref"] for p in facts["parts"] if p["has_model"]], pcbmod._kicad_env())
    built = build(spec, board, comps, facts)
    report = check(spec, built, board, comps, facts)

    out.mkdir(parents=True, exist_ok=True)
    files = {}
    for name in ("base", "lid"):
        part = built[name]
        cq.exporters.export(cq.Workplane().add(part), str(out / f"enclosure-{name}.step"))
        cq.exporters.export(cq.Workplane().add(part), str(out / f"enclosure-{name}.stl"), tolerance=0.02, angularTolerance=0.1)
        files[f"{name}_step"] = f"enclosure-{name}.step"
        files[f"{name}_stl"] = f"enclosure-{name}.stl"
        for view, d in (("top", (0, 0, 1)), ("front", (0, -1, 0))):
            cq.exporters.export(cq.Workplane().add(part), str(out / f"enclosure-{name}-{view}.svg"),
                                opt={"projectionDir": d, "showHidden": False, "width": 600, "height": 400, "marginLeft": 20, "marginTop": 20})
            files[f"{name}_{view}_svg"] = f"enclosure-{name}-{view}.svg"
    asm = cq.Assembly(name="enclosure")
    asm.add(built["base"], name="base", color=cq.Color(0.55, 0.6, 0.66, 1))
    asm.add(built["lid"].translate(cq.Vector(0, 0, 0)), name="lid", color=cq.Color(0.55, 0.6, 0.66, 0.35))
    asm.add(board, name="board", color=cq.Color(0.1, 0.4, 0.2, 1))
    for ref, solid in comps.items():
        asm.add(solid, name=ref, color=cq.Color(0.2, 0.2, 0.2, 1))
    asm.export(str(out / "enclosure-assembly.step"))
    files["assembly_step"] = "enclosure-assembly.step"
    # Lid set beside the base (not above it), so the board, standoffs and the lid's openings are all visible.
    exploded = cq.Assembly(name="exploded")
    shift = built["outer_bb"].xlen + 10.0
    exploded.add(built["base"], name="base", color=cq.Color(0.55, 0.6, 0.66, 1))
    exploded.add(board, name="board", color=cq.Color(0.1, 0.45, 0.2, 1))
    for ref, solid in comps.items():
        exploded.add(solid, name=ref, color=cq.Color(0.15, 0.15, 0.15, 1))
    exploded.add(built["lid"].translate(cq.Vector(shift, 0, 0)), name="lid", color=cq.Color(0.62, 0.68, 0.75, 1))
    exploded.export(str(out / "enclosure-exploded.glb"))
    files["exploded_glb"] = "enclosure-exploded.glb"

    proc = PROCESSES[spec.process]
    ob = built["outer_bb"]
    vol = {n: built[n].Volume() for n in ("base", "lid")}
    result = {
        "ok": report["ok"], "stage": "built", "process": {"name": proc.name, "label": proc.label}, "material": spec.material,
        "problems": report["problems"], "warnings": report["warnings"],
        "dimensions_mm": {"x": _r(ob.xlen), "y": _r(ob.ylen), "z": _r(built["levels"]["top_outer"] - built["levels"]["floor_bottom"])},
        "levels_mm": built["levels"], "mounting": built["holes"], "openings": built["openings"],
        "collisions": report["collisions"], "clearance_mm": report["clearance_mm"], "missing_models": report["missing_models"],
        "volume_cm3": {n: _r(v / 1000, 2) for n, v in vol.items()},
        "mass_g": {n: _r(v / 1000 * proc.density_g_cm3, 1) for n, v in vol.items()},
        "board": {"thickness_mm": facts["thickness_mm"], "holes": facts["holes"], "parts_checked": sorted(comps), "parts": len(facts["parts"])},
        "spec": spec_json, "files": files,
    }
    (out / "fit-report.json").write_text(json.dumps(result, indent=2))
    result["files"]["report"] = "fit-report.json"
    return result
