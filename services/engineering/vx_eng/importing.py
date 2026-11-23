"""Import existing designs: a board from another tool converted to KiCad with KiCad's own importers (Eagle, Altium,
EasyEDA, PADS, CADSTAR, Allegro, P-CAD, Fabmaster, SolidWorks PCB, IPC-2581, ODB++), checked with KiCad's design-rule
check, and described (size, layers, parts, nets); and a 3D model (STEP, IGES, STL) measured.

The schematic stays in the original tool: KiCad converts boards, not other tools' schematics. A board carries its
connections (nets), so its parts and connectivity are still read and checked.
"""
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path
from typing import Any

from . import kicad

# The source tool's name for kicad-cli's --format hint, where one helps (".brd" is Eagle or Allegro).
FORMAT_HINT = {"eagle": "eagle", "fusion": "eagle", "altium": "altium", "pads": "pads", "cadstar": "cadstar", "solidworks": "solidworks"}


def _pcbnew():
    import pcbnew
    return pcbnew


def import_board(src: Path, out: Path, tool: str = "other") -> dict[str, Any]:
    """Converts (or copies, for KiCad) a board into out/board.kicad_pcb, runs DRC without schematic parity, and reports facts."""
    from . import pcb as pcbmod
    out.mkdir(parents=True, exist_ok=True)
    target = out / "board.kicad_pcb"
    report: dict[str, Any] = {}
    if src.suffix.lower() == ".kicad_pcb":
        shutil.copyfile(src, target)
        converted_from = "KiCad"
    else:
        hint = FORMAT_HINT.get(tool, "auto")
        if src.suffix.lower() == ".brd" and tool in ("allegro", "orcad"):
            hint = "auto"
        args = ["kicad-cli", "pcb", "import", "--format", hint, "--report-format", "json", "--report-file", str(out / "import-report.json"),
                "-o", str(target), str(src)]
        p = subprocess.run(args, capture_output=True, text=True, timeout=900, env=pcbmod._kicad_env())
        if (out / "import-report.json").exists():
            try:
                report = json.loads((out / "import-report.json").read_text() or "{}")
            except json.JSONDecodeError:
                report = {}
        if not target.exists():
            msg = (p.stderr or p.stdout or "").strip().splitlines()
            raise kicad.KicadError(f"KiCad could not import {src.name}: {(msg[-1] if msg else 'unknown format')[:300]}")
        converted_from = str(report.get("format") or report.get("source_format") or hint)
    facts = board_facts(target)
    drc = pcbmod.drc(out, target.name, refill=True, parity=False)
    return {"ok": True, "converted_from": converted_from, "facts": facts, "import_report": report,
            "drc": {k: drc[k] for k in ("errors", "warnings", "unconnected") if k in drc},
            "drc_top": [{"type": v["type"], "description": v["description"]} for v in drc.get("violations", []) if v.get("severity") == "error"][:20],
            "files": {"board": target.name, "drc": "drc-report.json"}}


def board_facts(path: Path) -> dict[str, Any]:
    pcbnew = _pcbnew()
    board = pcbnew.LoadBoard(str(path))
    edges = board.GetBoardEdgesBoundingBox()
    fps = list(board.GetFootprints())
    parts = sorted(({"ref": f.GetReference(), "value": f.GetValue(), "footprint": str(f.GetFPID().GetUniStringLibItemName()),
                     "side": "bottom" if f.IsFlipped() else "top"} for f in fps), key=lambda x: x["ref"])
    tracks = [t for t in board.GetTracks() if t.GetClass() == "PCB_TRACK"]
    vias = [t for t in board.GetTracks() if t.GetClass() == "PCB_VIA"]
    return {
        "width_mm": round(pcbnew.ToMM(edges.GetWidth()), 2), "height_mm": round(pcbnew.ToMM(edges.GetHeight()), 2),
        "copper_layers": board.GetCopperLayerCount(), "footprints": len(fps), "nets": max(0, board.GetNetCount() - 1),
        "tracks": len(tracks), "vias": len(vias), "zones": len(list(board.Zones())),
        "parts": parts[:600], "unrouted_board": len(tracks) == 0,
    }


def model_facts(src: Path) -> dict[str, Any]:
    """Size of a STEP/IGES/STL model in mm (its bounding box) and its solid count."""
    import cadquery as cq
    suffix = src.suffix.lower()
    if suffix in (".step", ".stp"):
        shape = cq.importers.importStep(str(src))
    elif suffix in (".iges", ".igs"):
        from OCP.IGESControl import IGESControl_Reader
        r = IGESControl_Reader()
        if r.ReadFile(str(src)) != 1:
            raise ValueError("the IGES file could not be read")
        r.TransferRoots()
        shape = cq.Workplane().add(cq.Shape.cast(r.OneShape()))
    elif suffix == ".stl":
        from OCP.RWStl import RWStl
        tri = RWStl.ReadFile_s(str(src))
        if tri is None:
            raise ValueError("the STL file could not be read")
        xs, ys, zs = [], [], []
        for i in range(1, tri.NbNodes() + 1):
            pnt = tri.Node(i)
            xs.append(pnt.X()); ys.append(pnt.Y()); zs.append(pnt.Z())
        return {"ok": True, "format": "STL", "size_mm": [round(max(v) - min(v), 2) for v in (xs, ys, zs)], "triangles": tri.NbTriangles(), "solids": None}
    else:
        raise ValueError(f"{src.name} is not a STEP, IGES or STL model")
    bb = shape.val().BoundingBox() if hasattr(shape, "val") else shape.BoundingBox()
    solids = len(shape.solids().vals()) if hasattr(shape, "solids") else None
    return {"ok": True, "format": "STEP" if suffix in (".step", ".stp") else "IGES",
            "size_mm": [round(bb.xlen, 2), round(bb.ylen, 2), round(bb.zlen, 2)], "solids": solids}
