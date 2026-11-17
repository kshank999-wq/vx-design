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
