"""Manufacturer exchange formats for the fab package (S5): IPC-2581 (rev C), ODB++, the IPC-D-356 netlist for bare-board
electrical test, and a DXF of the board outline for mechanical and enclosure suppliers.

KiCad writes each file; this module then reads every file back with its own parser and compares it with the board as
pcbnew reports it (copper layers, components, nets, outline size), so a file that is missing content, or describes a
different board, fails the package instead of reaching a manufacturer.
"""
from __future__ import annotations

import math
import re
import subprocess
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path
from typing import Any

FORMATS = ("ipc2581", "odb", "ipcd356", "dxf")
LABELS = {"ipc2581": "IPC-2581 rev C (XML)", "odb": "ODB++ (zip)", "ipcd356": "IPC-D-356 netlist (bare-board test)",
          "dxf": "DXF board outline (mm)"}
TOL_MM = 0.15


def _problem(code: str, message: str) -> dict[str, str]:
    return {"code": code, "message": message}


def board_reference(project_dir: Path, pcb: str) -> dict[str, Any]:
    """What the files must agree with, read from the board itself."""
    import pcbnew
    board = pcbnew.LoadBoard(str(project_dir / pcb))
    bb = board.GetBoardEdgesBoundingBox()
    pads: dict[str, int] = {}
    refs = []
    for fp in board.GetFootprints():
        if fp.IsBoardOnly():
            continue
        refs.append(fp.GetReference())
        for pad in fp.Pads():
            net = pad.GetNetname()
            if net:
                pads[net] = pads.get(net, 0) + 1
    return {"copper_layers": board.GetCopperLayerCount(), "refs": sorted(refs),
            "width_mm": round(pcbnew.ToMM(bb.GetWidth()) - 0.1, 3), "height_mm": round(pcbnew.ToMM(bb.GetHeight()) - 0.1, 3),
            "nets": sorted(n for n, c in pads.items() if c >= 2)}


# --- Readers (independent of KiCad) ------------------------------------------------------

def read_ipc2581(path: Path) -> dict[str, Any]:
    root = ET.parse(path).getroot()
    ns = root.tag.split("}")[0] + "}" if root.tag.startswith("{") else ""
    q = lambda t: f"{ns}{t}"  # noqa: E731
    copper = [e.get("name") for e in root.iter(q("Layer")) if e.get("layerFunction") in ("CONDUCTOR", "PLANE", "SIGNAL", "MIXED")]
    comps = sorted({e.get("refDes") for e in root.iter(q("Component")) if e.get("refDes")})
    xs, ys = [], []
    for prof in root.iter(q("Profile")):
        for e in prof.iter():
            if e.get("x") is not None and e.get("y") is not None:
                xs.append(float(e.get("x"))); ys.append(float(e.get("y")))
    return {"revision": root.get("revision"), "root": root.tag.replace(ns, ""), "copper_layers": len(copper), "components": comps,
            "bom_items": sum(1 for _ in root.iter(q("BomItem"))),
            "outline_mm": [round(max(xs) - min(xs), 3), round(max(ys) - min(ys), 3)] if xs else None}


def read_odb(path: Path) -> dict[str, Any]:
    with zipfile.ZipFile(path) as z:
        names = z.namelist()
        # The job may sit at the archive root or in one folder: find it by its matrix file.
        mx = next((n for n in names if n == "matrix/matrix" or n.endswith("/matrix/matrix")), "matrix/matrix")
        root = mx[: -len("matrix/matrix")]
        get = lambda n: z.read(root + n).decode("utf-8", "replace") if root + n in names else None  # noqa: E731
        matrix = get("matrix/matrix") or ""
        layers = [dict(re.findall(r"^\s*(\w+)=(.*)$", block, re.M)) for block in re.findall(r"LAYER\s*\{(.*?)\}", matrix, re.S)]
        steps = sorted({n[len(root):].split("/")[1] for n in names if n[len(root):].startswith("steps/") and n[len(root):].count("/") >= 2})
        comps: list[str] = []
        for side in ("comp_+_top", "comp_+_bot"):
            for step in steps:
                text = get(f"steps/{step}/layers/{side}/components") or ""
                comps += [line.split()[6] for line in text.splitlines() if line.startswith("CMP ") and len(line.split()) > 6]
        prof = next((get(f"steps/{s}/profile") for s in steps if get(f"steps/{s}/profile")), "") or ""
        pts = [(float(a), float(b)) for a, b in re.findall(r"^O[BSE]\s+(-?[\d.]+)\s+(-?[\d.]+)", prof, re.M)]
    return {"has_matrix": bool(matrix), "steps": steps, "signal_layers": sum(1 for l in layers if l.get("TYPE") in ("SIGNAL", "POWER_GROUND", "MIXED")),
            "components": sorted(set(comps)),
            "outline_mm": [round(max(p[0] for p in pts) - min(p[0] for p in pts), 3), round(max(p[1] for p in pts) - min(p[1] for p in pts), 3)] if pts else None}


def read_ipcd356(path: Path) -> dict[str, Any]:
    aliases: dict[str, str] = {}
    nets: dict[str, int] = {}
    for line in path.read_text(errors="replace").splitlines():
        m = re.match(r"^P\s+NNAME(\S+)\s+(.+?)\s*$", line)
        if m:
            aliases[m.group(1)] = m.group(2)
            continue
        if line[:3] in ("317", "327"):
            name = line[3:17].strip()
            name = aliases.get(name, name)
            nets[name] = nets.get(name, 0) + 1
    return {"nets": sorted(nets), "points": sum(nets.values()), "version": "IPC-D-356A" if "IPC-D-356A" in path.read_text(errors="replace") else None}


def read_dxf_extent(path: Path) -> list[float] | None:
    """Outline extent from LINE, ARC and LWPOLYLINE entities (group codes 10/20, 11/21, 40, 50/51)."""
    lines = [l.strip() for l in path.read_text(errors="replace").splitlines()]
    pairs = list(zip(lines[0::2], lines[1::2]))
    xs: list[float] = []; ys: list[float] = []
    i = 0
    while i < len(pairs):
        code, val = pairs[i]
        if code == "0" and val in ("LINE", "ARC", "LWPOLYLINE", "CIRCLE"):
            kind, g = val, {}
            i += 1
            pts: list[tuple[float, float]] = []
            cur_x = None
            while i < len(pairs) and pairs[i][0] != "0":
                c, v = pairs[i]
                if kind == "LWPOLYLINE" and c == "10": cur_x = float(v)
                elif kind == "LWPOLYLINE" and c == "20" and cur_x is not None: pts.append((cur_x, float(v)))
                else: g.setdefault(c, v)
                i += 1
            if kind == "LINE":
                pts = [(float(g["10"]), float(g["20"])), (float(g["11"]), float(g["21"]))]
            elif kind in ("ARC", "CIRCLE"):
                cx, cy, r = float(g["10"]), float(g["20"]), float(g["40"])
                a0, a1 = (float(g.get("50", 0)), float(g.get("51", 360))) if kind == "ARC" else (0.0, 360.0)
                if a1 < a0: a1 += 360
                angles = [a0, a1] + [k * 90.0 for k in range(-4, 9) if a0 <= k * 90.0 <= a1]
                pts = [(cx + r * math.cos(math.radians(a)), cy + r * math.sin(math.radians(a))) for a in angles]
            xs += [p[0] for p in pts]; ys += [p[1] for p in pts]
            continue
        i += 1
    return [round(max(xs) - min(xs), 3), round(max(ys) - min(ys), 3)] if xs else None


# --- Export and check -------------------------------------------------------------------

def check_exports(files: dict[str, Path], ref: dict[str, Any]) -> dict[str, Any]:
    problems: list[dict[str, str]] = []
    summary: dict[str, Any] = {}
    size = [ref["width_mm"], ref["height_mm"]]
    near = lambda a, b: a is not None and all(abs(x - y) <= TOL_MM for x, y in zip(sorted(a), sorted(b)))  # noqa: E731
    if "ipc2581" in files:
        r = read_ipc2581(files["ipc2581"]); summary["ipc2581"] = r
        if r["root"] != "IPC-2581" or r["revision"] != "C": problems.append(_problem("ipc2581_header", f"IPC-2581 file is not revision C (root {r['root']}, revision {r['revision']})"))
        if r["copper_layers"] != ref["copper_layers"]: problems.append(_problem("ipc2581_layers", f"IPC-2581 has {r['copper_layers']} copper layers; the board has {ref['copper_layers']}"))
        missing = sorted(set(ref["refs"]) - set(r["components"]))
        if missing: problems.append(_problem("ipc2581_components", f"IPC-2581 lacks components {', '.join(missing)}"))
        if not near(r["outline_mm"], size): problems.append(_problem("ipc2581_outline", f"IPC-2581 outline {r['outline_mm']} mm differs from the board's {size} mm"))
    if "odb" in files:
        r = read_odb(files["odb"]); summary["odb"] = r
        if not r["has_matrix"] or not r["steps"]: problems.append(_problem("odb_structure", "ODB++ archive has no matrix or step"))
        if r["signal_layers"] != ref["copper_layers"]: problems.append(_problem("odb_layers", f"ODB++ has {r['signal_layers']} signal layers; the board has {ref['copper_layers']}"))
        missing = sorted(set(ref["refs"]) - set(r["components"]))
        if missing: problems.append(_problem("odb_components", f"ODB++ lacks components {', '.join(missing)}"))
        if not near(r["outline_mm"], size): problems.append(_problem("odb_outline", f"ODB++ profile {r['outline_mm']} mm differs from the board's {size} mm"))
    if "ipcd356" in files:
        r = read_ipcd356(files["ipcd356"]); summary["ipcd356"] = {k: v for k, v in r.items() if k != "nets"} | {"nets": len(r["nets"])}
        missing = sorted(set(ref["nets"]) - set(r["nets"]))
        if missing: problems.append(_problem("ipcd356_nets", f"IPC-D-356 netlist lacks nets {', '.join(missing[:10])}{' …' if len(missing) > 10 else ''}"))
    if "dxf" in files:
        ext = read_dxf_extent(files["dxf"]); summary["dxf"] = {"outline_mm": ext}
        if not near(ext, size): problems.append(_problem("dxf_outline", f"DXF outline {ext} mm differs from the board's {size} mm"))
    return {"ok": not problems, "problems": problems, "summary": summary}


FIXED_ISO = "2000-01-01T00:00:00"
FIXED_ODB = "20000101.000000"


def make_reproducible(files: dict[str, Path]) -> None:
    """KiCad stamps the export time into IPC-2581 and ODB++; pin it (and the ODB++ archive's own entry times and order)
    so the same board always gives byte-identical files. The release's date is in its manifest, not in these files."""
    if "ipc2581" in files:
        p = files["ipc2581"]
        text = p.read_text(encoding="utf-8")
        text = re.sub(r'(origination|lastChange|datetime)="\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}"', rf'\1="{FIXED_ISO}"', text)
        p.write_text(text, encoding="utf-8")
    if "odb" in files:
        p = files["odb"]
        with zipfile.ZipFile(p) as z:
            entries = [(i.filename, z.read(i.filename)) for i in z.infolist()]
        tmp = p.with_suffix(".tmp")
        with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
            for name, data in sorted(entries):
                if name.endswith("misc/info"):
                    data = re.sub(rb"(CREATION_DATE|SAVE_DATE)=\d{8}\.\d{6}", rb"\1=" + FIXED_ODB.encode(), data)
                # Some ODB++ files start with an export-time comment ("# 2026-11-18T19:18:48").
                data = re.sub(rb"^# \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}", b"# " + FIXED_ISO.encode(), data, flags=re.M)
                info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
                info.external_attr = (0o40755 << 16) | 0x10 if name.endswith("/") else 0o644 << 16
                z.writestr(info, data, zipfile.ZIP_DEFLATED)
        tmp.replace(p)


def export_formats(project_dir: Path, pcb: str, out: Path, formats: tuple[str, ...] = FORMATS) -> dict[str, Any]:
    out.mkdir(parents=True, exist_ok=True)
    name = Path(pcb).stem
    targets = {"ipc2581": out / f"{name}-ipc2581.xml", "odb": out / f"{name}-odb.zip", "ipcd356": out / f"{name}.ipc356",
               "dxf": out / f"{name}-outline.dxf"}
    args = {"ipc2581": ["ipc2581", "--version", "C", "--units", "mm", "--bom-col-mfg-pn", "MPN", "--bom-col-mfg", "Manufacturer"],
            "odb": ["odb", "--units", "mm", "--compression", "zip"], "ipcd356": ["ipcd356"],
            "dxf": ["dxf", "--layers", "Edge.Cuts", "--mode-single", "--ou", "mm"]}
    files: dict[str, Path] = {}
    errors: list[dict[str, str]] = []
    for f in formats:
        r = subprocess.run(["kicad-cli", "pcb", "export", *args[f], "-o", str(targets[f]), pcb], cwd=project_dir, capture_output=True, text=True, timeout=600)
        if r.returncode != 0 or not targets[f].exists() or targets[f].stat().st_size == 0:
            errors.append(_problem(f"{f}_export", f"KiCad could not write {LABELS[f]}: {(r.stderr or r.stdout).strip()[-300:]}"))
        else:
            files[f] = targets[f]
    make_reproducible(files)
    check = check_exports(files, board_reference(project_dir, pcb))
    return {"ok": check["ok"] and not errors, "problems": errors + check["problems"], "files": {f: p.name for f, p in files.items()},
            "summary": check["summary"], "labels": {f: LABELS[f] for f in files}}
