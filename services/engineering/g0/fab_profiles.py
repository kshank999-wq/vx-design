"""Fab-house design-rule profiles applied to generated boards.

Values are conservative readings of each fab's published standard capabilities;
re-check the fab's current capability page before ordering.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class FabProfile:
    name: str
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


JLCPCB_2L_STANDARD = FabProfile(
    name="jlcpcb-2layer-standard",
    layers=2,
    min_track_mm=0.127,
    min_clearance_mm=0.127,
    min_via_diameter_mm=0.6,
    min_via_drill_mm=0.3,
    min_hole_mm=0.3,
    copper_edge_clearance_mm=0.3,
    track_mm=0.25,
    clearance_mm=0.15,
    via_diameter_mm=0.6,
    via_drill_mm=0.3,
)


def apply_to_board(board, profile: FabProfile) -> None:
    """Applies the profile in memory (used by DSN export for the autorouter)."""
    import pcbnew

    mm = pcbnew.FromMM
    ds = board.GetDesignSettings()
    ds.m_TrackMinWidth = mm(profile.min_track_mm)
    ds.m_MinClearance = mm(profile.min_clearance_mm)
    ds.m_ViasMinSize = mm(profile.min_via_diameter_mm)
    ds.m_MinThroughDrill = mm(profile.min_via_drill_mm)
    ds.m_CopperEdgeClearance = mm(profile.copper_edge_clearance_mm)
    nc = ds.m_NetSettings.GetDefaultNetclass()
    nc.SetTrackWidth(mm(profile.track_mm))
    nc.SetClearance(mm(profile.clearance_mm))
    nc.SetViaDiameter(mm(profile.via_diameter_mm))
    nc.SetViaDrill(mm(profile.via_drill_mm))


def write_project_file(board_path: Path, profile: FabProfile) -> Path:
    """Writes the .kicad_pro next to a board; KiCad reads design rules and net classes from it."""
    pro = board_path.with_suffix(".kicad_pro")
    pro.write_text(json.dumps({
        "meta": {"filename": pro.name, "version": 3},
        "board": {"design_settings": {"rules": {
            "min_track_width": profile.min_track_mm,
            "min_clearance": profile.min_clearance_mm,
            "min_via_diameter": profile.min_via_diameter_mm,
            "min_through_hole_diameter": profile.min_hole_mm,
            "min_copper_edge_clearance": profile.copper_edge_clearance_mm,
        }}},
        "net_settings": {"classes": [{
            "name": "Default",
            "track_width": profile.track_mm,
            "clearance": profile.clearance_mm,
            "via_diameter": profile.via_diameter_mm,
            "via_drill": profile.via_drill_mm,
        }], "meta": {"version": 4}},
        "vx_design": {"fab_profile": profile.name},
    }, indent=2))
    return pro
