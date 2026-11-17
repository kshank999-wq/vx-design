"""G0 test circuit: 2-pin input -> AP2112K-3.3 LDO -> LED indicator.

This single description drives every spike (schematic, SKiDL, PCB), so the
outputs can be compared against one source of truth.
"""
from __future__ import annotations

from dataclasses import dataclass

PROJECT = "g0_ldo_led"


@dataclass(frozen=True)
class Part:
    ref: str
    lib_id: str             # KiCad symbol "Library:Name"
    value: str
    footprint: str          # KiCad footprint "Library:Name"
    sch_at: tuple[float, float]   # schematic position (mm, on 2.54 grid)
    pcb_at: tuple[float, float]   # board position (mm, relative to board origin)
    pcb_rot: float = 0.0


PARTS: list[Part] = [
    Part("J1", "Connector_Generic:Conn_01x02", "VIN 5V", "Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical", (50.8, 76.2), (4.0, 8.0)),
    Part("C1", "Device:C", "1uF", "Capacitor_SMD:C_0603_1608Metric", (76.2, 76.2), (10.0, 5.0), 90),
    Part("U1", "Regulator_Linear:AP2112K-3.3", "AP2112K-3.3", "Package_TO_SOT_SMD:SOT-23-5", (101.6, 76.2), (15.0, 8.0)),
    Part("C2", "Device:C", "1uF", "Capacitor_SMD:C_0603_1608Metric", (127.0, 76.2), (20.0, 5.0), 90),
    Part("R1", "Device:R", "1k", "Resistor_SMD:R_0603_1608Metric", (152.4, 76.2), (24.0, 8.0), 90),
    Part("D1", "Device:LED", "Green", "LED_SMD:LED_0603_1608Metric", (177.8, 76.2), (24.0, 12.0), 90),
]

# Power flags tell ERC that the externally supplied nets are driven.
FLAGS: list[tuple[str, str, tuple[float, float]]] = [
    ("#FLG01", "VIN", (63.5, 50.8)),
    ("#FLG02", "GND", (88.9, 50.8)),
]

# net name -> [(ref, pin number)]
NETS: dict[str, list[tuple[str, str]]] = {
    "VIN":    [("J1", "1"), ("C1", "1"), ("U1", "1"), ("U1", "3")],   # EN tied to VIN
    "GND":    [("J1", "2"), ("C1", "2"), ("U1", "2"), ("C2", "2"), ("D1", "1")],
    "+3V3":   [("U1", "5"), ("C2", "1"), ("R1", "1")],
    "LED_A":  [("R1", "2"), ("D1", "2")],
}

NO_CONNECT: list[tuple[str, str]] = [("U1", "4")]

BOARD_SIZE_MM = (28.0, 16.0)


def expected_connectivity() -> set[frozenset[tuple[str, str]]]:
    """Nets as sets of (ref, pin), independent of naming — used to compare tools."""
    return {frozenset(pins) for pins in NETS.values()}
