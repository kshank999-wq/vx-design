"""Generates a native KiCad schematic (.kicad_sch) from the fixture description.

Approach: copy each symbol definition out of the installed KiCad libraries
(flattening `extends` inheritance), place instances on a grid, and connect pins
with net labels placed exactly on pin endpoints. KiCad then derives the netlist.
"""
from __future__ import annotations

import copy
import uuid
from pathlib import Path

from . import fixture
from .sexpr import Sym, child, children, dumps, head, parse

SCH_VERSION = 20251024  # KiCad 10 symbol/schematic file format


def _uid() -> str:
    return str(uuid.uuid4())


class SymbolLibrary:
    def __init__(self, symbol_dir: Path):
        self.symbol_dir = symbol_dir
        self._libs: dict[str, list] = {}

    def _lib(self, name: str) -> list:
        if name not in self._libs:
            self._libs[name] = parse((self.symbol_dir / f"{name}.kicad_sym").read_text())
        return self._libs[name]

    def _raw(self, lib: str, name: str) -> list:
        for s in children(self._lib(lib), "symbol"):
            if s[1] == name:
                return s
        raise KeyError(f"symbol {lib}:{name} not found")

    def resolve(self, lib_id: str) -> list:
        """Returns a flattened symbol named `lib_id`, ready for a schematic's lib_symbols."""
        lib, name = lib_id.split(":", 1)
        sym = copy.deepcopy(self._raw(lib, name))
        ext = child(sym, "extends")
        if ext is not None:
            parent = copy.deepcopy(self._raw(lib, ext[1]))
            props = children(sym, "property")
            parent_name = parent[1]
            flat = [Sym("symbol"), name]
            for item in parent[2:]:
                if head(item) == "property":
                    continue
                if head(item) == "symbol":
                    item[1] = item[1].replace(parent_name, name, 1)
                flat.append(item)
            # child properties replace the parent's, inserted before sub-units
            first_unit = next(i for i, x in enumerate(flat) if head(x) == "symbol" or head(x) == "embedded_fonts")
            flat[first_unit:first_unit] = props
            sym = flat
        sym[1] = lib_id
        return sym


def pin_offsets(sym: list) -> dict[str, tuple[float, float]]:
    """Pin number -> connection point in symbol coordinates (unit 1, normal body style)."""
    out: dict[str, tuple[float, float]] = {}
    for unit in children(sym, "symbol"):
        parts = str(unit[1]).rsplit("_", 2)
        unit_no, style = int(parts[1]), int(parts[2])
        if unit_no not in (0, 1) or style not in (0, 1):
            continue
        for pin in children(unit, "pin"):
            at = child(pin, "at")
            number = child(pin, "number")
            out[number[1]] = (float(at[1]), float(at[2]))
    return out


def _flag(sym: list, name: str, default: str = "yes") -> Sym:
    node = child(sym, name)
    return Sym(str(node[1])) if node else Sym(default)


def _prop(name: str, value: str, at: tuple[float, float], hidden: bool = False) -> list:
    node = [Sym("property"), name, value, [Sym("at"), at[0], at[1], 0]]
    if hidden:
        node.append([Sym("hide"), Sym("yes")])
    node.append([Sym("effects"), [Sym("font"), [Sym("size"), 1.27, 1.27]]])
    return node


def build_schematic(symbol_dir: Path) -> tuple[str, dict]:
    """Returns (schematic text, metadata) for the fixture circuit."""
    lib = SymbolLibrary(symbol_dir)
    root_uuid = _uid()
    lib_symbols: dict[str, list] = {}
    body: list = []
    pin_at: dict[tuple[str, str], tuple[float, float]] = {}

    def place(ref: str, lib_id: str, value: str, footprint: str, at: tuple[float, float]) -> None:
        if lib_id not in lib_symbols:
            lib_symbols[lib_id] = lib.resolve(lib_id)
        sym = lib_symbols[lib_id]
        x, y = at
        for number, (px, py) in pin_offsets(sym).items():
            pin_at[(ref, number)] = (round(x + px, 4), round(y - py, 4))  # schematic Y axis points down
        inst = [
            Sym("symbol"), [Sym("lib_id"), lib_id], [Sym("at"), x, y, 0], [Sym("unit"), 1],
            [Sym("exclude_from_sim"), Sym("no")],
            [Sym("in_bom"), _flag(sym, "in_bom")], [Sym("on_board"), _flag(sym, "on_board")],
            [Sym("dnp"), Sym("no")], [Sym("uuid"), _uid()],
            _prop("Reference", ref, (x, y - 7.62), hidden=ref.startswith("#")),
            _prop("Value", value, (x, y + 7.62)),
            _prop("Footprint", footprint, (x, y + 10.16), hidden=True),
        ]
        for number in pin_offsets(sym):
            inst.append([Sym("pin"), number, [Sym("uuid"), _uid()]])
        inst.append([Sym("instances"), [Sym("project"), fixture.PROJECT,
                     [Sym("path"), f"/{root_uuid}", [Sym("reference"), ref], [Sym("unit"), 1]]]])
        body.append(inst)

    for p in fixture.PARTS:
        place(p.ref, p.lib_id, p.value, p.footprint, p.sch_at)
    nets = {name: list(pins) for name, pins in fixture.NETS.items()}
    for ref, net, at in fixture.FLAGS:
        place(ref, "power:PWR_FLAG", "PWR_FLAG", "", at)
        nets[net].append((ref, "1"))

    for net, pins in nets.items():
        for ref, number in pins:
            x, y = pin_at[(ref, number)]
            body.append([Sym("label"), net, [Sym("at"), x, y, 0],
                         [Sym("effects"), [Sym("font"), [Sym("size"), 1.27, 1.27]],
                          [Sym("justify"), Sym("left"), Sym("bottom")]],
                         [Sym("uuid"), _uid()]])
    for ref, number in fixture.NO_CONNECT:
        x, y = pin_at[(ref, number)]
        body.append([Sym("no_connect"), [Sym("at"), x, y], [Sym("uuid"), _uid()]])

    doc = [
        Sym("kicad_sch"), [Sym("version"), SCH_VERSION], [Sym("generator"), "vx_design_g0"],
        [Sym("generator_version"), "0.1"], [Sym("uuid"), root_uuid], [Sym("paper"), "A4"],
        [Sym("lib_symbols"), *lib_symbols.values()],
        *body,
        [Sym("sheet_instances"), [Sym("path"), "/", [Sym("page"), "1"]]],
        [Sym("embedded_fonts"), Sym("no")],
    ]
    return dumps(doc) + "\n", {"pin_positions": {f"{r}.{n}": xy for (r, n), xy in pin_at.items()}}


def write_lib_tables(project_dir: Path) -> None:
    """Project-local library tables pointing at the installed KiCad libraries."""
    sym_libs = {p.lib_id.split(":")[0] for p in fixture.PARTS} | {"power"}
    fp_libs = {p.footprint.split(":")[0] for p in fixture.PARTS}
    (project_dir / "sym-lib-table").write_text(
        "(sym_lib_table\n  (version 7)\n" + "".join(
            f'  (lib (name "{n}") (type "KiCad") (uri "${{KICAD10_SYMBOL_DIR}}/{n}.kicad_sym") (options "") (descr ""))\n'
            for n in sorted(sym_libs)) + ")\n")
    (project_dir / "fp-lib-table").write_text(
        "(fp_lib_table\n  (version 7)\n" + "".join(
            f'  (lib (name "{n}") (type "KiCad") (uri "${{KICAD10_FOOTPRINT_DIR}}/{n}.pretty") (options "") (descr ""))\n'
            for n in sorted(fp_libs)) + ")\n")
