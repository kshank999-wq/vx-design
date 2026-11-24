"""Native KiCad 10 schematic from a validated Circuit.

- Symbols are copied from the installed libraries (inheritance flattened), so the file is
  self-contained and matches the library exactly.
- Every unit of a multi-unit part is placed. Parts are laid out left to right in design
  order on a 2.54 mm grid; the sheet grows (A5 -> A0) to fit.
- Each connected pin gets a short wire stub ending in a net label; nets that are supplied
  from outside get a PWR_FLAG. Unused pins get a no-connect marker.
- Output is deterministic: UUIDs derive from the design, so rebuilding the same design
  produces byte-identical files (a resumed task re-uploads the same content).
"""
from __future__ import annotations

import json
import math
import uuid
from pathlib import Path

from . import __version__
from .circuit import Circuit
from .library import FOOTPRINT_DIR, Library
from .sexpr import Sym, dumps

SCH_VERSION = 20251024  # KiCad 10 schematic format
GRID = 2.54
STUB = 2.54
SHEETS = [("A5", 210.0, 148.0), ("A4", 297.0, 210.0), ("A3", 420.0, 297.0), ("A2", 594.0, 420.0), ("A1", 841.0, 594.0), ("A0", 1189.0, 841.0)]
MARGIN = 25.4
NS = uuid.UUID("6f1c2d3e-4b5a-4c6d-8e9f-a0b1c2d3e4f5")



_BOM_EXCLUDED: dict[str, bool] = {}


def _footprint_excluded_from_bom(footprint: str | None) -> bool:
    """Whether a library footprint ("Lib:Name") is marked exclude_from_bom in its .kicad_mod attributes."""
    if not footprint or ":" not in footprint:
        return False
    if footprint not in _BOM_EXCLUDED:
        lib, name = footprint.split(":", 1)
        path = FOOTPRINT_DIR / f"{lib}.pretty" / f"{name}.kicad_mod"
        try:
            text = path.read_text(errors="replace")
            import re
            m = re.search(r"\(attr([^()]*)\)", text)
            _BOM_EXCLUDED[footprint] = bool(m and "exclude_from_bom" in m.group(1))
        except OSError:
            _BOM_EXCLUDED[footprint] = False
    return _BOM_EXCLUDED[footprint]

def _snap(v: float) -> float:
    return round(round(v / GRID) * GRID, 4)


def _prop(name: str, value: str, at: tuple[float, float], hidden: bool = False, angle: float = 0,
          justify: str | None = None) -> list:
    node = [Sym("property"), name, value, [Sym("at"), at[0], at[1], angle]]
    if hidden:
        node.append([Sym("hide"), Sym("yes")])
    effects = [Sym("effects"), [Sym("font"), [Sym("size"), 1.27, 1.27]]]
    if justify:
        effects.append([Sym("justify"), Sym(justify)])
    node.append(effects)
    return node


class _Ids:
    def __init__(self, seed: str):
        self.seed = seed
        self.n = 0

    def __call__(self, key: str = "") -> str:
        self.n += 1
        return str(uuid.uuid5(NS, f"{self.seed}/{key}/{self.n}"))


def build(circuit: Circuit, lib: Library, out_dir: Path) -> dict:
    """Writes <name>.kicad_pro, <name>.kicad_sch and library tables into out_dir. Returns layout facts."""
    name = circuit.project_name()
    design_key = json.dumps({"c": [c.__dict__ for c in circuit.components], "n": [n.__dict__ for n in circuit.nets],
                             "nc": circuit.no_connect}, sort_keys=True)
    uid = _Ids(str(uuid.uuid5(NS, design_key)))
    root = uid("root")

    # One placement per (component, unit), plus PWR_FLAGs for externally driven nets.
    placements: list[tuple[str, str, int, str, str]] = []  # (ref, lib_id, unit, value, footprint)
    for c in circuit.components:
        for unit in range(1, lib.symbol(c.symbol).units + 1):
            if any(p.unit == unit for p in lib.symbol(c.symbol).pins) or unit == 1:
                placements.append((c.ref, c.symbol, unit, c.value, c.footprint))
    nets = {n.name: list(n.pins) for n in circuit.nets}
    flag_n = 0
    for n in circuit.nets:
        if n.driven_externally:
            flag_n += 1
            ref = f"#FLG{flag_n:02d}"
            placements.append((ref, "power:PWR_FLAG", 1, "PWR_FLAG", ""))
            nets[n.name].append(f"{ref}.1")

    # Lay out in rows; pick the smallest sheet that fits.
    longest = max((len(n) for n in nets), default=4)
    label_room = STUB + 1.27 * (longest * 0.75 + 2)          # stub plus label text
    cells = []
    for ref, lib_id, unit, _, _ in placements:
        x0, y0, x1, y1 = lib.unit_bbox(lib_id, unit)
        sides = _pin_sides(lib, lib_id, unit)
        text_w = 0 if not sides & {"top", "bottom"} else 12.7   # reference/value go beside vertical parts
        cells.append((x0 - (label_room if "left" in sides else 2.54),
                      y0 - (label_room if "bottom" in sides else 5.08),
                      x1 + (label_room if "right" in sides else 2.54) + text_w,
                      y1 + (label_room if "top" in sides else 5.08)))
    for sheet, w, h in SHEETS:
        pos = _flow(cells, w, h)
        if pos is not None:
            break
    assert pos is not None, "design too large for an A0 sheet"

    lib_symbols: dict[str, list] = {}
    body: list = []
    pin_at: dict[str, tuple[float, float, float]] = {}   # "REF.N" -> (x, y, outward angle in degrees)
    for (ref, lib_id, unit, value, footprint), (x, y) in zip(placements, pos):
        info = lib.symbol(lib_id)
        lib_symbols.setdefault(lib_id, info.definition)
        unit_pins = [p for p in info.pins if p.unit == unit]
        for p in unit_pins:
            pin_at[f"{ref}.{p.number}"] = (round(x + p.at[0], 4), round(y - p.at[1], 4), (p.angle + 180) % 360)
        x0, y0, x1, y1 = lib.unit_bbox(lib_id, unit)
        hidden_ref = ref.startswith("#")
        # The parts list follows the footprint: library footprints for things that are not bought (a Tag-Connect
        # pad, a test point, a fiducial) are marked "exclude from BOM", and the symbol must say the same or the
        # board fails the schematic-parity check.
        in_bom = not hidden_ref and not _footprint_excluded_from_bom(footprint)
        inst = [
            Sym("symbol"), [Sym("lib_id"), lib_id], [Sym("at"), x, y, 0], [Sym("unit"), unit],
            [Sym("exclude_from_sim"), Sym("no")], [Sym("in_bom"), Sym("yes" if in_bom else "no")],
            [Sym("on_board"), Sym("no" if hidden_ref else "yes")], [Sym("dnp"), Sym("no")],
            [Sym("uuid"), uid(f"sym/{ref}/{unit}")],
            *_ref_value(ref, value, x, y, (x0, y0, x1, y1), _pin_sides(lib, lib_id, unit), hidden_ref),
            _prop("Footprint", footprint, (x, y), hidden=True),
            _prop("Datasheet", info.properties.get("Datasheet", ""), (x, y), hidden=True),
        ]
        comp = next((c for c in circuit.components if c.ref == ref), None)
        if comp:
            if comp.mpn:
                inst.append(_prop("MPN", comp.mpn, (x, y), hidden=True))
            if comp.manufacturer:
                inst.append(_prop("Manufacturer", comp.manufacturer, (x, y), hidden=True))
        for p in unit_pins:
            inst.append([Sym("pin"), p.number, [Sym("uuid"), uid(f"pin/{ref}/{p.number}")]])
        inst.append([Sym("instances"), [Sym("project"), name,
                     [Sym("path"), f"/{root}", [Sym("reference"), ref], [Sym("unit"), unit]]]])
        body.append(inst)

    # Wire stub + label for every connected pin.
    for net, pins in nets.items():
        for p in pins:
            x, y, ang = pin_at[p]
            dx, dy = round(math.cos(math.radians(ang)), 6), -round(math.sin(math.radians(ang)), 6)
            ex, ey = round(x + dx * STUB, 4), round(y + dy * STUB, 4)
            body.append([Sym("wire"), [Sym("pts"), [Sym("xy"), x, y], [Sym("xy"), ex, ey]],
                         [Sym("stroke"), [Sym("width"), 0], [Sym("type"), Sym("default")]], [Sym("uuid"), uid(f"w/{p}")]])
            justify = "left" if ang in (0, 90) else "right"
            label_angle = int(ang)   # KiCad writes leftward/downward labels as 180/270, right-justified
            body.append([Sym("label"), net, [Sym("at"), ex, ey, label_angle],
                         [Sym("effects"), [Sym("font"), [Sym("size"), 1.27, 1.27]], [Sym("justify"), Sym(justify), Sym("bottom")]],
                         [Sym("uuid"), uid(f"l/{p}")]])
    for p in circuit.no_connect:
        x, y, _ = pin_at[p]
        body.append([Sym("no_connect"), [Sym("at"), x, y], [Sym("uuid"), uid(f"nc/{p}")]])

    short = circuit.title if len(circuit.title) <= 60 else circuit.title[:57].rstrip() + "..."   # fits the title block
    title = [Sym("title_block"), [Sym("title"), short], [Sym("company"), "VX Design"],
             [Sym("comment"), 1, "Generated by VX Design from an AI-proposed design: review before use."]]
    doc = [
        Sym("kicad_sch"), [Sym("version"), SCH_VERSION], [Sym("generator"), "vx_design"],
        [Sym("generator_version"), __version__], [Sym("uuid"), root], [Sym("paper"), sheet], title,
        [Sym("lib_symbols"), *lib_symbols.values()],
        *body,
        [Sym("sheet_instances"), [Sym("path"), "/", [Sym("page"), "1"]]],
        [Sym("embedded_fonts"), Sym("no")],
    ]
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / f"{name}.kicad_sch").write_text(dumps(doc) + "\n")
    _write_project(out_dir, name, circuit, root)
    return {"project": name, "sheet": sheet, "placements": len(placements), "files": sorted(p.name for p in out_dir.iterdir())}


def _pin_sides(lib: Library, lib_id: str, unit: int) -> set[str]:
    """Sides of the symbol that pins stick out of (schematic orientation)."""
    names = {0: "left", 90: "bottom", 180: "right", 270: "top"}   # pin angle points into the body
    return {names.get(int(p.angle) % 360, "left") for p in lib.symbol(lib_id).pins if p.unit == unit}


def _ref_value(ref: str, value: str, x: float, y: float, bbox: tuple[float, float, float, float],
               sides: set[str], hidden: bool) -> list[list]:
    """Reference above and value below for parts with side pins; beside the body for vertical parts."""
    x0, y0, x1, y1 = bbox
    if sides & {"top", "bottom"} and not sides & {"left", "right"}:
        rx = round(x + x1 + 1.27, 4)
        return [_prop("Reference", ref, (rx, round(y - 1.27, 4)), hidden=hidden, justify="left"),
                _prop("Value", value, (rx, round(y + 1.27, 4)), hidden=hidden, justify="left")]
    return [_prop("Reference", ref, (x, _snap(y - y1 - 2.54)), hidden=hidden),
            _prop("Value", value, (x, _snap(y - y0 + 2.54)), hidden=hidden)]


def _flow(cells: list[tuple[float, float, float, float]], w: float, h: float) -> list[tuple[float, float]] | None:
    """Left-to-right rows. Returns symbol origins, or None if the cells do not fit the sheet."""
    out: list[tuple[float, float]] = []
    x, y_top, row_h = MARGIN, MARGIN, 0.0
    for x0, y0, x1, y1 in cells:
        cw, ch = x1 - x0, y1 - y0
        if x + cw > w - MARGIN and x > MARGIN:
            x, y_top, row_h = MARGIN, y_top + row_h, 0.0
        if x + cw > w - MARGIN or y_top + ch > h - MARGIN - 30:   # keep the title block clear
            return None
        out.append((_snap(x - x0), _snap(y_top + y1)))           # symbol y-up: top edge is y1
        x += cw
        row_h = max(row_h, ch)
    return out


def _write_project(out_dir: Path, name: str, circuit: Circuit, root: str) -> None:
    sym_libs = sorted({c.symbol.split(":")[0] for c in circuit.components} | {"power"})
    fp_libs = sorted({c.footprint.split(":")[0] for c in circuit.components if ":" in c.footprint})
    (out_dir / f"{name}.kicad_pro").write_text(json.dumps({
        "meta": {"filename": f"{name}.kicad_pro", "version": 3},
        "sheets": [[root, "Root"]],
        "text_variables": {},
    }, indent=2) + "\n")
    (out_dir / "sym-lib-table").write_text("(sym_lib_table\n  (version 7)\n" + "".join(
        f'  (lib (name "{n}") (type "KiCad") (uri "${{KICAD10_SYMBOL_DIR}}/{n}.kicad_sym") (options "") (descr ""))\n'
        for n in sym_libs) + ")\n")
    (out_dir / "fp-lib-table").write_text("(fp_lib_table\n  (version 7)\n" + "".join(
        f'  (lib (name "{n}") (type "KiCad") (uri "${{KICAD10_FOOTPRINT_DIR}}/{n}.pretty") (options "") (descr ""))\n'
        for n in fp_libs) + ")\n")
