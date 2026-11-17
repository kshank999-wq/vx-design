"""Index of the installed KiCad symbol and footprint libraries.

The name index is built by scanning files (fast) and cached; full symbol definitions are
parsed lazily, one library at a time, only for libraries a design actually uses.
"""
from __future__ import annotations

import copy
import difflib
import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path

from .sexpr import Sym, child, children, head, parse, walk

SYMBOL_DIR = Path(os.environ.get("KICAD_SYMBOL_DIR", "/usr/share/kicad/symbols"))
FOOTPRINT_DIR = Path(os.environ.get("KICAD_FOOTPRINT_DIR", "/usr/share/kicad/footprints"))
INDEX_CACHE = Path(os.environ.get("VX_LIB_INDEX", "/tmp/vx-kicad-lib-index.json"))

_TOP_SYMBOL = re.compile(r'^\t\(symbol "([^"]+)"', re.M)
_PAD = re.compile(r'\(pad "([^"]*)"')


@dataclass
class Pin:
    number: str
    name: str
    etype: str            # power_in, power_out, input, output, bidirectional, passive, no_connect, ...
    unit: int             # 1-based unit; pins common to all units are reported on unit 1
    at: tuple[float, float]
    angle: float          # direction from the connection point towards the symbol body (symbol coords, y up)
    hidden: bool = False


@dataclass
class SymbolInfo:
    lib_id: str
    units: int
    pins: list[Pin]
    properties: dict[str, str]
    is_power: bool
    definition: list = field(repr=False)   # flattened definition, named by lib_id

    def pin(self, number: str) -> Pin | None:
        return next((p for p in self.pins if p.number == number), None)

    @property
    def fp_filters(self) -> list[str]:
        return self.properties.get("ki_fp_filters", "").split()


class Library:
    def __init__(self, symbol_dir: Path = SYMBOL_DIR, footprint_dir: Path = FOOTPRINT_DIR):
        self.symbol_dir = symbol_dir
        self.footprint_dir = footprint_dir
        self._parsed: dict[str, list] = {}
        self._symbols: dict[str, SymbolInfo] = {}
        self._index: dict[str, dict[str, list[str]]] | None = None

    # --- name index -----------------------------------------------------------------

    @property
    def index(self) -> dict[str, dict[str, list[str]]]:
        if self._index is None:
            self._index = self._load_index()
        return self._index

    def _load_index(self) -> dict[str, dict[str, list[str]]]:
        stamp = f"{self.symbol_dir}:{self.footprint_dir}"
        if INDEX_CACHE.exists():
            try:
                data = json.loads(INDEX_CACHE.read_text())
                if data.get("stamp") == stamp:
                    return data
            except (OSError, ValueError):
                pass
        symbols = {p.stem: sorted(_TOP_SYMBOL.findall(p.read_text(encoding="utf-8")))
                   for p in sorted(self.symbol_dir.glob("*.kicad_sym"))}
        footprints = {p.stem: sorted(f.stem for f in p.glob("*.kicad_mod"))
                      for p in sorted(self.footprint_dir.glob("*.pretty"))}
        data = {"stamp": stamp, "symbols": symbols, "footprints": footprints}
        try:
            INDEX_CACHE.write_text(json.dumps(data))
        except OSError:
            pass
        return data

    def has_symbol(self, lib_id: str) -> bool:
        lib, _, name = lib_id.partition(":")
        return name in self.index["symbols"].get(lib, [])

    def has_footprint(self, fp_id: str) -> bool:
        lib, _, name = fp_id.partition(":")
        return name in self.index["footprints"].get(lib, [])

    def suggest_symbols(self, lib_id: str, n: int = 6) -> list[str]:
        lib, _, name = lib_id.partition(":")
        same = [f"{lib}:{s}" for s in difflib.get_close_matches(name, self.index["symbols"].get(lib, []), n, 0.5)]
        everywhere = [f"{l}:{s}" for l, names in self.index["symbols"].items() for s in names]
        anywhere = difflib.get_close_matches(lib_id, everywhere, n, 0.6) if len(same) < n else []
        by_name = [x for x in everywhere if x.split(":", 1)[1].lower() == name.lower()]
        return list(dict.fromkeys(by_name + same + anywhere))[:n]

    def suggest_footprints(self, fp_id: str, n: int = 6) -> list[str]:
        lib, _, name = fp_id.partition(":")
        if lib in self.index["footprints"]:
            return [f"{lib}:{s}" for s in difflib.get_close_matches(name, self.index["footprints"][lib], n, 0.4)]
        libs = difflib.get_close_matches(lib, list(self.index["footprints"]), 3, 0.5)
        return [f"{l}:{s}" for l in libs for s in difflib.get_close_matches(name, self.index["footprints"][l], 2, 0.4)][:n]

    # --- symbol definitions -----------------------------------------------------------

    def _lib(self, name: str) -> list:
        if name not in self._parsed:
            self._parsed[name] = parse((self.symbol_dir / f"{name}.kicad_sym").read_text(encoding="utf-8"))
        return self._parsed[name]

    def _raw(self, lib: str, name: str) -> list:
        for s in children(self._lib(lib), "symbol"):
            if s[1] == name:
                return s
        raise KeyError(f"symbol {lib}:{name} not found")

    def symbol(self, lib_id: str) -> SymbolInfo:
        if lib_id in self._symbols:
            return self._symbols[lib_id]
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
            first_unit = next((i for i, x in enumerate(flat) if head(x) in ("symbol", "embedded_fonts")), len(flat))
            flat[first_unit:first_unit] = props
            sym = flat
        sym[1] = lib_id
        info = SymbolInfo(
            lib_id=lib_id,
            units=_unit_count(sym, name),
            pins=_pins(sym, name),
            properties={str(p[1]): str(p[2]) for p in children(sym, "property")},
            is_power=child(sym, "power") is not None,
            definition=sym,
        )
        self._symbols[lib_id] = info
        return info

    def unit_bbox(self, lib_id: str, unit: int) -> tuple[float, float, float, float]:
        """Approximate (xmin, ymin, xmax, ymax) of one unit in symbol coordinates (y up)."""
        info = self.symbol(lib_id)
        name = lib_id.split(":", 1)[1]
        xs: list[float] = []
        ys: list[float] = []
        for sub in children(info.definition, "symbol"):
            u, style = _unit_style(str(sub[1]), name)
            if u not in (0, unit) or style not in (0, 1):
                continue
            for node in walk(sub):
                if head(node) in ("xy", "at", "start", "end", "center") and len(node) >= 3:
                    try:
                        xs.append(float(node[1]))
                        ys.append(float(node[2]))
                    except (TypeError, ValueError):
                        pass
            for pin in children(sub, "pin"):
                at, length = child(pin, "at"), child(pin, "length")
                if at is not None and length is not None:
                    xs.append(float(at[1]))
                    ys.append(float(at[2]))
        if not xs:
            return (-2.54, -2.54, 2.54, 2.54)
        return (min(xs), min(ys), max(xs), max(ys))

    def footprint_pads(self, fp_id: str) -> set[str]:
        lib, name = fp_id.split(":", 1)
        text = (self.footprint_dir / f"{lib}.pretty" / f"{name}.kicad_mod").read_text(encoding="utf-8")
        return {p for p in _PAD.findall(text) if p}


def _unit_style(sub_name: str, name: str) -> tuple[int, int]:
    """Sub-symbols are named NAME_<unit>_<body style>; unit 0 is common to all units."""
    parts = sub_name.rsplit("_", 2)
    return int(parts[1]), int(parts[2])


def _unit_count(sym: list, name: str) -> int:
    units = [_unit_style(str(s[1]), name)[0] for s in children(sym, "symbol")]
    return max([u for u in units if u > 0], default=1)


def _pins(sym: list, name: str) -> list[Pin]:
    out: dict[tuple[str, int], Pin] = {}
    for sub in children(sym, "symbol"):
        unit, style = _unit_style(str(sub[1]), name)
        if style not in (0, 1):
            continue
        for pin in children(sub, "pin"):
            at = child(pin, "at")
            number = str(child(pin, "number")[1])
            pin_name = str(child(pin, "name")[1])
            hidden = any(head(x) == "hide" for x in pin) or Sym("hide") in pin
            key = (number, max(unit, 1))
            out[key] = Pin(number, pin_name, str(pin[1]), max(unit, 1), (float(at[1]), float(at[2])),
                           float(at[3]) if len(at) > 3 else 0.0, hidden)
    return sorted(out.values(), key=lambda p: (p.unit, _natural(p.number)))


def _natural(s: str) -> tuple:
    return tuple(int(t) if t.isdigit() else t for t in re.split(r"(\d+)", s))
