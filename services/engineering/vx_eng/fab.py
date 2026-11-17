"""Fab-house design-rule profiles applied to generated boards.

Values are conservative readings of each fab's published standard capabilities;
re-check the fab's current capability page before ordering.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass


@dataclass(frozen=True)
class FabProfile:
    name: str
    description: str
    layers: int
    min_track_mm: float
    min_clearance_mm: float
    min_via_diameter_mm: float
    min_via_drill_mm: float
    min_hole_mm: float
    copper_edge_clearance_mm: float
    # Default net class used by the router
    track_mm: float
    clearance_mm: float
    via_diameter_mm: float
    via_drill_mm: float
    # Wider class for supply nets
    power_track_mm: float

    def as_dict(self) -> dict:
        return asdict(self)


PROFILES: dict[str, FabProfile] = {p.name: p for p in (
    FabProfile(
        name="jlcpcb-2layer-standard",
        description="JLCPCB standard 2-layer, 1.6 mm FR-4, 1 oz copper",
        layers=2,
        min_track_mm=0.127, min_clearance_mm=0.127,
        min_via_diameter_mm=0.6, min_via_drill_mm=0.3, min_hole_mm=0.3,
        copper_edge_clearance_mm=0.3,
        track_mm=0.25, clearance_mm=0.2, via_diameter_mm=0.6, via_drill_mm=0.3,
        power_track_mm=0.5,
    ),
    FabProfile(
        name="oshpark-2layer",
        description="OSH Park 2-layer, 1.6 mm FR-4, 1 oz copper",
        layers=2,
        min_track_mm=0.1524, min_clearance_mm=0.1524,
        min_via_diameter_mm=0.6858, min_via_drill_mm=0.254, min_hole_mm=0.254,
        copper_edge_clearance_mm=0.381,
        track_mm=0.254, clearance_mm=0.2032, via_diameter_mm=0.7, via_drill_mm=0.35,
        power_track_mm=0.5,
    ),
)}

DEFAULT_PROFILE = "jlcpcb-2layer-standard"


def apply_to_board(board, profile: FabProfile) -> None:
    """Applies the profile in memory (also read by the DSN export for the autorouter)."""
    import pcbnew

    mm = pcbnew.FromMM
    board.SetCopperLayerCount(profile.layers)
    ds = board.GetDesignSettings()
    ds.m_TrackMinWidth = mm(profile.min_track_mm)
    ds.m_MinClearance = mm(profile.min_clearance_mm)
    ds.m_ViasMinSize = mm(profile.min_via_diameter_mm)
    ds.m_MinThroughDrill = mm(profile.min_hole_mm)
    ds.m_CopperEdgeClearance = mm(profile.copper_edge_clearance_mm)
    nc = ds.m_NetSettings.GetDefaultNetclass()
    nc.SetTrackWidth(mm(profile.track_mm))
    nc.SetClearance(mm(profile.clearance_mm))
    nc.SetViaDiameter(mm(profile.via_diameter_mm))
    nc.SetViaDrill(mm(profile.via_drill_mm))


def project_settings(profile: FabProfile, power_nets: list[str]) -> dict:
    """The board part of the .kicad_pro: design rules and net classes (KiCad reads DRC rules from here)."""
    classes = [{
        "name": "Default", "track_width": profile.track_mm, "clearance": profile.clearance_mm,
        "via_diameter": profile.via_diameter_mm, "via_drill": profile.via_drill_mm,
    }]
    assignments = []
    if power_nets:
        classes.append({
            "name": "Power", "track_width": profile.power_track_mm, "clearance": profile.clearance_mm,
            "via_diameter": profile.via_diameter_mm, "via_drill": profile.via_drill_mm,
        })
        assignments = [{"netclass": "Power", "pattern": n} for n in power_nets]
    return {
        "board": {"design_settings": {"rules": {
            "min_track_width": profile.min_track_mm,
            "min_clearance": profile.min_clearance_mm,
            "min_via_diameter": profile.min_via_diameter_mm,
            "min_through_hole_diameter": profile.min_hole_mm,
            "min_copper_edge_clearance": profile.copper_edge_clearance_mm,
        }}},
        "net_settings": {"classes": classes, "netclass_patterns": assignments, "meta": {"version": 4}},
        "vx_design": {"fab_profile": profile.name},
    }
