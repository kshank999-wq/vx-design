"""Circuit design description and its checks against the installed KiCad libraries.

A design lists components (KiCad symbol + footprint + sourcing data) and nets (pins joined
by name). It is the contract between the model, which proposes it, and the schematic
generator, which turns it into a native KiCad project. Every problem found here is reported
with enough detail (pin lists, close library matches) for the model to fix it.
"""
from __future__ import annotations

import fnmatch
import re
from dataclasses import dataclass, field
from typing import Any

from .library import Library

REF_RE = re.compile(r"^[A-Z]{1,4}[0-9]{1,4}$")
NET_RE = re.compile(r"^[A-Za-z0-9_+\-./]{1,40}$")


@dataclass
class Component:
    ref: str
    symbol: str
    value: str
    footprint: str
    mpn: str | None = None
    manufacturer: str | None = None
    datasheet: str | None = None
    purpose: str | None = None
    claims: list[dict[str, str]] = field(default_factory=list)


@dataclass
class Net:
    name: str
    pins: list[str]                 # "REF.PIN_NUMBER"
    driven_externally: bool = False  # supplied from outside the circuit (connector, battery): gets a PWR_FLAG


@dataclass
class Circuit:
    name: str
    title: str
    components: list[Component]
    nets: list[Net]
    no_connect: list[str] = field(default_factory=list)

    @staticmethod
    def from_json(d: dict[str, Any]) -> "Circuit":
        return Circuit(
            name=str(d.get("name") or "circuit"),
            title=str(d.get("title") or d.get("name") or "Circuit"),
            components=[Component(
                ref=str(c["ref"]), symbol=str(c["symbol"]), value=str(c.get("value") or ""),
                footprint=str(c.get("footprint") or ""), mpn=c.get("mpn"), manufacturer=c.get("manufacturer"),
                datasheet=c.get("datasheet"), purpose=c.get("purpose"), claims=list(c.get("claims") or []),
            ) for c in d.get("components", [])],
            nets=[Net(str(n["name"]), [str(p) for p in n.get("pins", [])], bool(n.get("driven_externally")))
                  for n in d.get("nets", [])],
            no_connect=[str(p) for p in d.get("no_connect", [])],
        )

    def project_name(self) -> str:
        return re.sub(r"[^a-z0-9_]+", "_", self.name.lower()).strip("_") or "circuit"

    def connectivity(self) -> set[frozenset[tuple[str, str]]]:
        return {frozenset(tuple(p.split(".", 1)) for p in n.pins) for n in self.nets}  # type: ignore[misc]


def _problem(code: str, message: str, **extra: Any) -> dict[str, Any]:
    return {"code": code, "message": message, **{k: v for k, v in extra.items() if v is not None}}


def _pin_list(pins) -> str:
    return ", ".join(f"{p.number} {p.name}" + (f" (unit {p.unit})" if p.unit > 1 else "") for p in pins)


def validate(circuit: Circuit, lib: Library) -> dict[str, Any]:
    """Returns {ok, errors, warnings, components}; components carry the library facts used."""
    errors: list[dict] = []
    warnings: list[dict] = []
    facts: list[dict] = []
    symbols = {}

    if not circuit.components:
        errors.append(_problem("empty", "the design has no components"))
    seen_refs: set[str] = set()
    for c in circuit.components:
        f: dict[str, Any] = {"ref": c.ref, "symbol": c.symbol, "footprint": c.footprint}
        facts.append(f)
        if not REF_RE.match(c.ref):
            errors.append(_problem("bad_ref", f"{c.ref}: references look like R1, U12, J3", ref=c.ref))
        if c.ref in seen_refs:
            errors.append(_problem("duplicate_ref", f"{c.ref} is used twice", ref=c.ref))
        seen_refs.add(c.ref)

        f["symbol_found"] = ":" in c.symbol and lib.has_symbol(c.symbol)
        if not f["symbol_found"]:
            errors.append(_problem("unknown_symbol", f"{c.ref}: symbol {c.symbol} is not in the KiCad libraries",
                                   ref=c.ref, suggestions=lib.suggest_symbols(c.symbol) if ":" in c.symbol else None))
        else:
            sym = lib.symbol(c.symbol)
            symbols[c.ref] = sym
            f["units"] = sym.units
            f["pins"] = [{"number": p.number, "name": p.name, "type": p.etype, "unit": p.unit} for p in sym.pins]
            f["library_datasheet"] = sym.properties.get("Datasheet") or None
            f["library_description"] = sym.properties.get("Description") or None
            if sym.is_power:
                errors.append(_problem("power_symbol", f"{c.ref}: {c.symbol} is a power symbol; name the net instead "
                                       "(power symbols are added automatically)", ref=c.ref))

        f["footprint_found"] = ":" in c.footprint and lib.has_footprint(c.footprint)
        if not c.footprint:
            errors.append(_problem("no_footprint", f"{c.ref}: choose a footprint", ref=c.ref))
        elif not f["footprint_found"]:
            errors.append(_problem("unknown_footprint", f"{c.ref}: footprint {c.footprint} is not in the KiCad libraries",
                                   ref=c.ref, suggestions=lib.suggest_footprints(c.footprint)))
        if f["symbol_found"] and f["footprint_found"] and c.ref in symbols:
            sym = symbols[c.ref]
            pads = lib.footprint_pads(c.footprint)
            pin_numbers = {p.number for p in sym.pins}
            f["pads"] = sorted(pads)
            missing = sorted(pin_numbers - pads)
            extra = sorted(pads - pin_numbers)
            f["pads_match"] = not missing
            if missing:
                errors.append(_problem("pin_pad_mismatch", f"{c.ref}: symbol pins {', '.join(missing)} have no pad in "
                                       f"{c.footprint} (pads: {', '.join(sorted(pads))})", ref=c.ref))
            if extra:
                warnings.append(_problem("extra_pads", f"{c.ref}: footprint pads {', '.join(extra)} have no symbol pin "
                                         "(often a thermal or mounting pad; check the datasheet)", ref=c.ref))
            filters = sym.fp_filters
            fp_name = c.footprint.split(":", 1)[1]
            # Filters match the footprint name, or "Library:Name" when they contain a colon.
            f["fp_filter_match"] = not filters or any(
                fnmatch.fnmatch(c.footprint if ":" in flt else fp_name, flt) for flt in filters)
            if not f["fp_filter_match"]:
                warnings.append(_problem("footprint_filter", f"{c.ref}: {c.footprint} does not match the symbol's "
                                         f"footprint filters ({' '.join(filters)})", ref=c.ref))

    # Nets and pins.
    pin_net: dict[str, str] = {}
    names: set[str] = set()
    for n in circuit.nets:
        if not NET_RE.match(n.name):
            errors.append(_problem("bad_net_name", f"net name {n.name!r}: use letters, digits and _+-./ (max 40)"))
        if n.name in names:
            errors.append(_problem("duplicate_net", f"net {n.name} is listed twice; merge its pins"))
        names.add(n.name)
        if len(set(n.pins)) < 2:
            errors.append(_problem("single_pin_net", f"net {n.name} connects fewer than two pins"))
        for p in n.pins:
            ref, _, number = p.partition(".")
            if p in pin_net and pin_net[p] != n.name:
                errors.append(_problem("pin_in_two_nets", f"{p} is in both {pin_net[p]} and {n.name}", ref=ref))
            pin_net[p] = n.name
            _check_pin(p, ref, number, symbols, seen_refs, errors)
    for p in circuit.no_connect:
        ref, _, number = p.partition(".")
        _check_pin(p, ref, number, symbols, seen_refs, errors)
        if p in pin_net:
            errors.append(_problem("nc_connected", f"{p} is marked no-connect but is in net {pin_net[p]}", ref=ref))

    # Every pin must be connected or explicitly left unconnected.
    nc = set(circuit.no_connect)
    for ref, sym in symbols.items():
        loose = [pin for pin in sym.pins if f"{ref}.{pin.number}" not in pin_net and f"{ref}.{pin.number}" not in nc]
        if loose:
            errors.append(_problem("unconnected_pins", f"{ref}: pins {_pin_list(loose)} are not connected; add them to a "
                                   "net or to no_connect", ref=ref))

    # Power inputs need a source: a power output on the net, or an external supply.
    for n in circuit.nets:
        types = []
        for p in n.pins:
            ref, _, number = p.partition(".")
            pin = symbols[ref].pin(number) if ref in symbols else None
            if pin:
                types.append(pin.etype)
        if "power_in" in types and "power_out" not in types and not n.driven_externally:
            warnings.append(_problem("undriven_power", f"net {n.name} feeds power inputs but nothing drives it; set "
                                     "driven_externally if it comes from a connector or battery"))

    return {"ok": not errors, "errors": errors, "warnings": warnings, "components": facts}


def _check_pin(p: str, ref: str, number: str, symbols: dict, refs: set[str], errors: list[dict]) -> None:
    if not number:
        errors.append(_problem("bad_pin", f"{p}: pins are written REF.NUMBER, e.g. U1.5", ref=ref))
    elif ref not in refs:
        errors.append(_problem("unknown_ref", f"{p}: there is no component {ref}", ref=ref))
    elif ref in symbols and symbols[ref].pin(number) is None:
        errors.append(_problem("unknown_pin", f"{p}: {symbols[ref].lib_id} has no pin {number}; its pins are "
                               f"{_pin_list(symbols[ref].pins)}", ref=ref))
