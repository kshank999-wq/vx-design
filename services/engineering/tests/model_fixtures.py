"""Synthetic manufacturer-style STEP models for the model-check tests (built with CadQuery, no downloads)."""
from __future__ import annotations

from pathlib import Path


def sot23_5(path: Path, *, leads=((-1.25, -0.95), (-1.25, 0.0), (-1.25, 0.95), (1.25, 0.95), (1.25, -0.95)),
            rotate_x: float = 90, move=(7.0, -3.0, 2.0), body_height: float = 1.1) -> Path:
    """SOT-23-5-like body and gull-wing feet, then re-oriented and moved the way a vendor model might be drawn."""
    import cadquery as cq
    body = cq.Workplane("XY").box(1.6, 2.9, body_height, centered=(True, True, False)).translate((0, 0, 0.1))
    m = body
    for x, y in leads:
        m = m.union(cq.Workplane("XY").box(0.5, 0.4, 0.15, centered=(True, True, False)).translate((x, y, 0)))
        m = m.union(cq.Workplane("XY").box(abs(x) - 0.7, 0.4, 0.15, centered=(True, True, False))
                    .translate(((x / abs(x)) * (0.8 + (abs(x) - 0.8) / 2 - 0.05), y, 0.5)))
    shape = m.val().rotate(cq.Vector(0, 0, 0), cq.Vector(1, 0, 0), rotate_x).translate(cq.Vector(*move))
    cq.exporters.export(cq.Workplane().add(shape), str(path))
    return path


def boxes(path: Path, parts: list[tuple[float, float, float, float, float, float]]) -> Path:
    """A model made of boxes (x0, x1, y0, y1, z0, z1), already in KiCad model space (footprint origin, Y up, board top Z=0)."""
    import cadquery as cq
    shape = None
    for x0, x1, y0, y1, z0, z1 in parts:
        b = cq.Solid.makeBox(x1 - x0, y1 - y0, z1 - z0, cq.Vector(x0, y0, z0))
        shape = b if shape is None else shape.fuse(b)
    cq.exporters.export(cq.Workplane().add(shape), str(path))
    return path


def fixture_board_models(d: Path) -> dict[str, dict[str, str]]:
    """Simple stand-in 3D models for every part of the LDO+LED fixture board (no downloads)."""
    chip = [(-0.8, 0.8, -0.4, 0.4, 0.0, 0.8)]                    # 0603 body
    header = [(-1.27, 1.27, -3.81, 1.27, 0.0, 2.5),              # plastic body around pins at y 0 and -2.54
              (-0.32, 0.32, -0.32, 0.32, -3.0, 8.5), (-0.32, 0.32, -2.86, -2.22, -3.0, 8.5)]
    sot = [(-0.8, 0.8, -1.45, 1.45, 0.1, 1.2), (-1.4, -0.8, -1.15, 1.15, 0.0, 0.15), (0.8, 1.4, -1.15, 1.15, 0.0, 0.15)]
    out = {}
    for ref, parts in (("C1", chip), ("C2", chip), ("R1", chip), ("D1", chip), ("J1", header), ("U1", sot)):
        out[ref] = {"path": str(boxes(d / f"{ref}.step", parts)), "name": f"fixture-{ref}"}
    return out
