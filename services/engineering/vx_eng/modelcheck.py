"""Manufacturer 3D model check: does this STEP model fit this KiCad footprint, and how must it be placed?

Manufacturer models come with arbitrary origins and orientations. The check:
  1. loads the STEP (or the first STEP inside a ZIP) with OCCT;
  2. tries the 24 axis-aligned orientations; in each, cuts the model just above its lowest point to find the
     terminals (pins, leads, pads), moves the terminal pattern onto the footprint's pads and scores how well
     every terminal lands inside a pad, one terminal per pad;
  3. writes the model re-oriented and moved so it sits on the footprint as KiCad expects (origin at the
     footprint origin, Y up = footprint -Y, seating plane at Z = 0), so KiCad needs no extra transform;
  4. draws a top-view overlay (pads, courtyard, terminals, body) for a person to confirm, and records the
     body size and height.

The result is a proposal. A person confirms it before the model replaces KiCad's generic one; symmetric
packages (where pin 1 cannot be told from geometry) are flagged so the confirmation looks at the marking.
"""
from __future__ import annotations

import hashlib
import io
import math
import zipfile
from pathlib import Path
from typing import Any

SECTION_ABOVE_MM = 0.05     # cut this far above the lowest point to find the terminals
MATCH_TOLERANCE_MM = 0.25   # a terminal centre may sit this far outside its pad's box
TIE_MM = 0.02               # orientations scoring within this are equally good
MIN_COVERAGE = 0.15         # a terminal's contact face must cover at least this share of its pad (edge slivers do not)


def _cq():
    import cadquery as cq   # in the engineering image
    return cq


def extract_step(source: Path, work: Path) -> Path:
    """The STEP file itself, or the best STEP inside a ZIP (manufacturer and library downloads are often zipped)."""
    data = source.read_bytes()
    if data[:2] == b"PK":
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            names = [n for n in z.namelist() if n.lower().endswith((".step", ".stp")) and not n.startswith("__MACOSX")]
            if not names:
                raise ValueError("the ZIP contains no .step/.stp file")
            names.sort(key=lambda n: (0 if "3d" in n.lower() else 1, len(n)))
            out = work / Path(names[0]).name
            out.write_bytes(z.read(names[0]))
            return out
    if b"ISO-10303-21" not in data[:200]:
        raise ValueError("not a STEP file (no ISO-10303-21 header)")
    return source


def _rotations():
    """24 proper rotations of the cube as (axis, angle) sequences applied in order: up-axis choice, then spin about Z."""
    ups = [((1, 0, 0), 0), ((1, 0, 0), 180), ((1, 0, 0), 90), ((1, 0, 0), -90), ((0, 1, 0), 90), ((0, 1, 0), -90)]
    for up in ups:
        for spin in (0, 90, 180, 270):
            yield [up, ((0, 0, 1), spin)]


def _apply(shape, steps, move=(0.0, 0.0, 0.0)):
    cq = _cq()
    s = shape
    for axis, angle in steps:
        if angle:
            s = s.rotate(cq.Vector(0, 0, 0), cq.Vector(*axis), angle)
    if any(move):
        s = s.translate(cq.Vector(*move))
    return s


def _terminals(shape) -> list[dict[str, float]]:
    """Faces of a cut just above the lowest point: centre and box of each terminal footprint."""
    cq = _cq()
    bb = shape.BoundingBox()
    sec = cq.Workplane().add(shape).section(bb.zmin + SECTION_ABOVE_MM)
    out = []
    for f in sec.faces().vals():
        b = f.BoundingBox()
        c = f.Center()
        out.append({"x": c.x, "y": c.y, "x0": b.xmin, "x1": b.xmax, "y0": b.ymin, "y1": b.ymax, "area": f.Area()})
    return out


def footprint_pads(fp_id: str) -> dict[str, Any]:
    """Pads (centre and box) and courtyard of a library footprint at the origin, in model space (Y up)."""
    from .pcb import _courtyard, load_footprint
    import pcbnew
    board = pcbnew.CreateEmptyBoard()
    fp = load_footprint(fp_id)
    board.Add(fp)
    fp.SetPosition(pcbnew.VECTOR2I(0, 0))
    pads = []
    for p in fp.Pads():
        if p.GetAttribute() == pcbnew.PAD_ATTRIB_NPTH:
            continue
        b = p.GetBoundingBox()
        c = p.GetPosition()
        # KiCad footprints have Y down; 3D model space has Y up.
        pads.append({"number": p.GetNumber(), "x": pcbnew.ToMM(c.x), "y": -pcbnew.ToMM(c.y),
                     "x0": pcbnew.ToMM(b.GetLeft()), "x1": pcbnew.ToMM(b.GetRight()),
                     "y0": -pcbnew.ToMM(b.GetBottom()), "y1": -pcbnew.ToMM(b.GetTop()),
                     "tht": p.GetAttribute() == pcbnew.PAD_ATTRIB_PTH})
    x0, y0, x1, y1 = _courtyard(fp)
    return {"pads": pads, "courtyard": {"x0": x0, "x1": x1, "y0": -y1, "y1": -y0}}


def _score(terms: list[dict], pads: list[dict]) -> dict[str, Any]:
    """Moves the terminal pattern's box centre onto the pads' box centre, then matches terminals to pads."""
    if not terms or not pads:
        return {"ok": False, "worst": math.inf, "dx": 0.0, "dy": 0.0, "matched": 0, "outside": len(terms)}
    tx = (min(t["x0"] for t in terms) + max(t["x1"] for t in terms)) / 2
    ty = (min(t["y0"] for t in terms) + max(t["y1"] for t in terms)) / 2
    px = (min(p["x0"] for p in pads) + max(p["x1"] for p in pads)) / 2
    py = (min(p["y0"] for p in pads) + max(p["y1"] for p in pads)) / 2
    dx, dy = px - tx, py - ty
    worst = 0.0
    used: set[int] = set()
    outside = 0
    thin = 0
    pairs = []
    for t in sorted(terms, key=lambda t: -t["area"]):
        x, y = t["x"] + dx, t["y"] + dy
        best = None
        for i, p in enumerate(pads):
            if i in used:
                continue
            # distance from the terminal centre to the pad's box (0 inside)
            ex = max(p["x0"] - x, 0, x - p["x1"])
            ey = max(p["y0"] - y, 0, y - p["y1"])
            d = math.hypot(ex, ey)
            centre = math.hypot(p["x"] - x, p["y"] - y)
            if best is None or (d, centre) < best[0]:
                best = ((d, centre), i)
        if best is None:
            outside += 1
            continue
        used.add(best[1])
        worst = max(worst, best[0][0])
        if best[0][0] > MATCH_TOLERANCE_MM:
            outside += 1
        pad = pads[best[1]]
        coverage = t["area"] / max(1e-9, (pad["x1"] - pad["x0"]) * (pad["y1"] - pad["y0"]))
        if coverage < MIN_COVERAGE:
            thin += 1
        pairs.append({"pad": pad["number"], "x": round(x, 3), "y": round(y, 3), "off_mm": round(best[0][0], 3),
                      "coverage": round(coverage, 3)})
    return {"ok": outside == 0 and thin == 0 and len(terms) == len(pads), "worst": worst, "dx": dx, "dy": dy, "matched": len(used),
            "outside": outside, "thin": thin, "pairs": pairs, "terminals": len(terms), "pads": len(pads)}


def check(step_source: Path, footprint: str, work: Path, mechanical: dict[str, Any] | None = None) -> dict[str, Any]:
    cq = _cq()
    work.mkdir(parents=True, exist_ok=True)
    step = extract_step(step_source, work)
    raw = step.read_bytes()
    model = cq.importers.importStep(str(step))
    solids = model.solids().vals()
    if not solids:
        raise ValueError("the STEP file contains no solids")
    shape = cq.Compound.makeCompound(solids) if len(solids) > 1 else solids[0]
    fp = footprint_pads(footprint)
    pads = fp["pads"]

    tried = []
    for steps in _rotations():
        rotated = _apply(shape, steps)
        terms = _terminals(rotated)
        s = _score(terms, pads)
        tried.append((s, steps, rotated, terms))
    # Prefer full matches, then the smallest worst offset, then the most matched pads.
    tried.sort(key=lambda x: (not x[0]["ok"], x[0]["outside"] + x[0].get("thin", 0), x[0]["worst"], -x[0]["matched"]))
    best, steps, rotated, terms = tried[0]
    ties = [t for t in tried[1:] if t[0]["ok"] == best["ok"] and t[0]["outside"] == best["outside"]
            and abs(t[0]["worst"] - best["worst"]) <= TIE_MM]
    # A symmetric terminal pattern fits in more than one orientation. Even when the model looks the same, its
    # pin-1 mark (a dot or notch too small to change the shape) may not, so a person must check it.
    ambiguous = sorted({_describe(st) for _, st, _, _ in ties} - {_describe(steps)})
    bb = rotated.BoundingBox()
    move = (best["dx"], best["dy"], -bb.zmin)       # seating plane (lowest point) at Z = 0
    aligned = _apply(rotated, [], move)
    abb = aligned.BoundingBox()

    problems: list[str] = []
    warnings: list[str] = []
    if best["terminals"] != len(pads):
        problems.append(f"found {best['terminals']} terminal(s) at the seating plane but the footprint has {len(pads)} pad(s)"
                        + (" (terminals and body may meet at the bottom, as in QFN/DFN; confirm the overlay by eye)" if best["terminals"] < len(pads) else ""))
    if best["outside"]:
        problems.append(f"{best['outside']} terminal(s) land more than {MATCH_TOLERANCE_MM} mm outside their pad (worst {round(best['worst'], 3)} mm)")
    if best.get("thin"):
        problems.append(f"{best['thin']} terminal(s) touch their pad with a sliver (under {int(MIN_COVERAGE * 100)}% of the pad): "
                        "the model does not sit on this footprint the way a part would")
    if ambiguous and best["ok"]:
        warnings.append("the terminal pattern also fits in other orientations (" + ", ".join(ambiguous[:3]) + "): pin 1 / polarity "
                        "cannot be confirmed from the leads; check the body marking in the overlay")
    cy = fp["courtyard"]
    if abb.xmin < cy["x0"] - 0.05 or abb.xmax > cy["x1"] + 0.05 or abb.ymin < cy["y0"] - 0.05 or abb.ymax > cy["y1"] + 0.05:
        warnings.append(f"the body ({round(abb.xlen, 2)} x {round(abb.ylen, 2)} mm) extends beyond the footprint courtyard "
                        f"({round(cy['x1'] - cy['x0'], 2)} x {round(cy['y1'] - cy['y0'], 2)} mm)")
    height = round(abb.zlen, 3)
    want_h = (mechanical or {}).get("height_mm")
    if want_h:
        if abs(height - want_h) > max(0.1, 0.1 * want_h):
            problems.append(f"model height {height} mm differs from the datasheet's {want_h} mm")
    if any(p["tht"] for p in pads):
        warnings.append("through-hole part: the seating plane is taken at the pin tips; check the body sits on the board in the overlay")

    out_step = work / "aligned.step"
    cq.exporters.export(cq.Workplane().add(aligned), str(out_step))
    overlay = overlay_svg(fp, aligned, best.get("pairs", []))
    (work / "overlay.svg").write_text(overlay)
    status = "checked" if not problems else (
        "inconclusive" if best["terminals"] < len(pads) and not best["outside"] and not best.get("thin") else "check_failed")
    return {
        "status": status, "problems": problems, "warnings": warnings,
        "source_sha256": hashlib.sha256(raw).hexdigest(), "source_file": step.name,
        "orientation": _describe(steps), "translation_mm": [round(m, 4) for m in move],
        "terminals": best["terminals"], "pads": len(pads), "worst_offset_mm": round(best["worst"], 3) if math.isfinite(best["worst"]) else None,
        "pairs": best.get("pairs", []),
        "body_mm": {"x": round(abb.xlen, 3), "y": round(abb.ylen, 3), "z": height},
        "mechanical": {"height_mm": height, "body_x_mm": round(abb.xlen, 3), "body_y_mm": round(abb.ylen, 3)},
        "files": {"aligned_step": out_step.name, "overlay_svg": "overlay.svg"},
    }


def _describe(steps) -> str:
    parts = []
    for axis, angle in steps:
        if angle:
            parts.append(f"{'XYZ'[axis.index(1)]}{angle:+d}")
    return " ".join(parts) or "as drawn"


def _wires_svg(shape, z: float, scale: float, ox: float, oy: float, cls: str) -> str:
    cq = _cq()
    try:
        sec = cq.Workplane().add(shape).section(z)
    except Exception:   # noqa: BLE001 - a height with no material
        return ""
    out = []
    for e in sec.edges().vals():
        pts = e.positions([i / 12 for i in range(13)])
        d = " ".join(f"{'M' if i == 0 else 'L'}{(p.x - ox) * scale:.2f},{(oy - p.y) * scale:.2f}" for i, p in enumerate(pts))
        out.append(f'<path class="{cls}" d="{d}"/>')
    return "".join(out)


def overlay_svg(fp: dict[str, Any], aligned, pairs: list[dict]) -> str:
    """Top view: courtyard, pads with numbers, model terminals (cut at the seating plane) and body outline."""
    bb = aligned.BoundingBox()
    cy = fp["courtyard"]
    x0 = min(cy["x0"], bb.xmin, *(p["x0"] for p in fp["pads"])) - 0.5
    x1 = max(cy["x1"], bb.xmax, *(p["x1"] for p in fp["pads"])) + 0.5
    y0 = min(cy["y0"], bb.ymin, *(p["y0"] for p in fp["pads"])) - 0.5
    y1 = max(cy["y1"], bb.ymax, *(p["y1"] for p in fp["pads"])) + 0.5
    scale = 600 / max(x1 - x0, y1 - y0)
    w, h = (x1 - x0) * scale, (y1 - y0) * scale
    X = lambda x: (x - x0) * scale     # noqa: E731
    Y = lambda y: (y1 - y) * scale     # noqa: E731
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w:.1f} {h:.1f}" width="{w:.0f}" height="{h:.0f}">',
             "<style>.cy{fill:none;stroke:#888;stroke-dasharray:6 4}.pad{fill:#d9a441;opacity:.55}.num{font:bold 14px sans-serif;fill:#333}"
             ".term{fill:none;stroke:#c0392b;stroke-width:2}.body{fill:none;stroke:#2c6fbb;stroke-width:2}"
             ".lbl{font:12px sans-serif;fill:#555}</style>",
             f'<rect width="{w:.1f}" height="{h:.1f}" fill="#fff"/>',
             f'<rect class="cy" x="{X(cy["x0"]):.1f}" y="{Y(cy["y1"]):.1f}" width="{(cy["x1"] - cy["x0"]) * scale:.1f}" height="{(cy["y1"] - cy["y0"]) * scale:.1f}"/>']
    for p in fp["pads"]:
        parts.append(f'<rect class="pad" x="{X(p["x0"]):.1f}" y="{Y(p["y1"]):.1f}" width="{(p["x1"] - p["x0"]) * scale:.1f}" height="{(p["y1"] - p["y0"]) * scale:.1f}"/>')
        parts.append(f'<text class="num" x="{X(p["x"]):.1f}" y="{Y(p["y"]) + 5:.1f}" text-anchor="middle">{p["number"]}</text>')
    parts.append(_wires_svg(aligned, bb.zmin + (bb.zmax - bb.zmin) * 0.5, scale, x0, y1, "body"))
    parts.append(_wires_svg(aligned, bb.zmin + SECTION_ABOVE_MM, scale, x0, y1, "term"))
    parts.append(f'<text class="lbl" x="6" y="{h - 8:.1f}">pads (gold) · courtyard (dashed) · model terminals at seating plane (red) · '
                 f'body at mid-height (blue) · top view</text>')
    parts.append("</svg>")
    return "".join(parts)
