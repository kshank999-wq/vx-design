"""vx_eng tests. Run inside the engineering image:
    docker run --rm -v $PWD:/src -w /src --entrypoint python3 vx-engineering:g3 -m unittest discover -s tests -v
"""
from __future__ import annotations

import copy
import json
import tempfile
import unittest
from pathlib import Path

from vx_eng.circuit import Circuit, validate
from vx_eng.cli import cmd_build, cmd_validate
from vx_eng.library import Library

FIXTURE = json.loads((Path(__file__).parent.parent / "vx_eng/fixtures/ldo_led.json").read_text())
LIB = Library()

# Dual op-amp: units A and B plus a separate power unit. Exercises multi-unit placement.
OPAMP = {
    "name": "buffer", "title": "Dual op-amp buffer",
    "components": [
        {"ref": "U1", "symbol": "Amplifier_Operational:LM358", "value": "LM358", "footprint": "Package_SO:SOIC-8_3.9x4.9mm_P1.27mm"},
        {"ref": "J1", "symbol": "Connector_Generic:Conn_01x04", "value": "IO", "footprint": "Connector_PinHeader_2.54mm:PinHeader_1x04_P2.54mm_Vertical"},
        {"ref": "C1", "symbol": "Device:C", "value": "100nF", "footprint": "Capacitor_SMD:C_0603_1608Metric"},
    ],
    "nets": [
        {"name": "VCC", "pins": ["J1.1", "U1.8", "C1.1"], "driven_externally": True},
        {"name": "GND", "pins": ["J1.4", "U1.4", "C1.2"], "driven_externally": True},
        {"name": "IN", "pins": ["J1.2", "U1.3", "U1.5"]},
        {"name": "OUT_A", "pins": ["U1.1", "U1.2", "J1.3"]},
        {"name": "OUT_B", "pins": ["U1.7", "U1.6"]},
    ],
}


def codes(result: dict) -> list[str]:
    return [e["code"] for e in result["errors"]]


class ValidationTests(unittest.TestCase):
    def test_fixture_is_valid(self):
        r = cmd_validate(FIXTURE)
        self.assertTrue(r["ok"], r["errors"])
        self.assertEqual(r["warnings"], [])
        u1 = next(c for c in r["components"] if c["ref"] == "U1")
        self.assertTrue(u1["pads_match"])
        self.assertEqual(u1["library_datasheet"], "https://www.diodes.com/assets/Datasheets/AP2112.pdf")

    def test_unknown_symbol_and_footprint_get_suggestions(self):
        spec = copy.deepcopy(FIXTURE)
        spec["components"][2]["symbol"] = "Regulator_Linear:AP2112K-33"
        spec["components"][2]["footprint"] = "Package_TO_SOT_SMD:SOT-23-5L"
        r = cmd_validate(spec)
        sym = next(e for e in r["errors"] if e["code"] == "unknown_symbol")
        fp = next(e for e in r["errors"] if e["code"] == "unknown_footprint")
        self.assertIn("Regulator_Linear:AP2112K-3.3", sym["suggestions"])
        self.assertIn("Package_TO_SOT_SMD:SOT-23-5", fp["suggestions"])

    def test_wrong_pin_lists_real_pins(self):
        spec = copy.deepcopy(FIXTURE)
        spec["nets"][2]["pins"][0] = "U1.6"
        r = cmd_validate(spec)
        err = next(e for e in r["errors"] if e["code"] == "unknown_pin")
        self.assertIn("5 VOUT", err["message"])
        self.assertIn("unconnected_pins", codes(r))   # U1.5 is now loose

    def test_pin_pad_mismatch(self):
        spec = copy.deepcopy(FIXTURE)
        spec["components"][2]["footprint"] = "Package_TO_SOT_SMD:SOT-23"   # 3 pads for a 5-pin part
        self.assertIn("pin_pad_mismatch", codes(cmd_validate(spec)))

    def test_structure_errors(self):
        spec = copy.deepcopy(FIXTURE)
        spec["components"].append(dict(spec["components"][0]))       # duplicate J1
        spec["nets"].append({"name": "LONELY", "pins": ["R1.1"]})     # single pin, and R1.1 already in +3V3
        spec["no_connect"].append("D1.1")                             # D1.1 is in GND
        c = codes(cmd_validate(spec))
        for code in ("duplicate_ref", "single_pin_net", "pin_in_two_nets", "nc_connected"):
            self.assertIn(code, c)

    def test_undriven_power_warning(self):
        spec = copy.deepcopy(FIXTURE)
        spec["nets"][0]["driven_externally"] = False
        r = cmd_validate(spec)
        self.assertTrue(r["ok"])
        self.assertIn("undriven_power", [w["code"] for w in r["warnings"]])


class BuildTests(unittest.TestCase):
    def build(self, spec: dict) -> tuple[dict, Path]:
        out = Path(tempfile.mkdtemp()) / "out"
        return cmd_build(spec, out), out

    def test_fixture_builds_clean_and_matches_intent(self):
        r, out = self.build(FIXTURE)
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["erc"]["errors"], 0)
        self.assertTrue(r["netlist"]["match"])
        for f in r["files"].values():
            self.assertTrue((out / f).exists(), f)
        self.assertIn("AP2112K-3.3TRG1", (out / "bom.csv").read_text())

    def test_build_is_deterministic(self):
        a, out_a = self.build(FIXTURE)
        b, out_b = self.build(FIXTURE)
        for key in ("schematic", "project_zip"):
            self.assertEqual((out_a / a["files"][key]).read_bytes(), (out_b / b["files"][key]).read_bytes(), key)

    def test_negative_control_missing_power_source_fails_erc(self):
        spec = copy.deepcopy(FIXTURE)
        spec["nets"][0]["driven_externally"] = False    # nothing drives VIN
        r, _ = self.build(spec)
        self.assertFalse(r["ok"])
        self.assertGreater(r["erc"]["errors"], 0)
        self.assertIn("power_pin_not_driven", {v["type"] for v in r["erc"]["violations"]})

    def test_invalid_design_is_not_built(self):
        spec = copy.deepcopy(FIXTURE)
        spec["components"][0]["symbol"] = "Nope:Nothing"
        r, out = self.build(spec)
        self.assertEqual(r["stage"], "validation")
        self.assertFalse(out.exists())

    def test_multi_unit_part(self):
        v = cmd_validate(OPAMP)
        self.assertTrue(v["ok"], v["errors"])
        self.assertEqual(next(c for c in v["components"] if c["ref"] == "U1")["units"], 3)
        r, out = self.build(OPAMP)
        self.assertTrue(r["ok"], r.get("erc"))
        sch = (out / r["files"]["schematic"]).read_text()
        self.assertEqual(sch.count('(lib_id "Amplifier_Operational:LM358")'), 3, "all three units placed")


if __name__ == "__main__":
    unittest.main()


LAYOUT = json.loads((Path(__file__).parent.parent / "vx_eng/fixtures/ldo_led_layout.json").read_text())


def _layout(**changes) -> dict:
    lay = copy.deepcopy(LAYOUT)
    for ref, fields in changes.items():
        p = next(p for p in lay["placements"] if p["ref"] == ref)
        p.update(fields)
    return lay


class LayoutCheckTests(unittest.TestCase):
    def test_fixture_layout_passes(self):
        from vx_eng.cli import cmd_layout_check
        r = cmd_layout_check(FIXTURE, LAYOUT)
        self.assertTrue(r["ok"], r["problems"])
        self.assertEqual(sorted(r["courtyards"]), ["C1", "C2", "D1", "H1", "H2", "H3", "H4", "J1", "R1", "U1"])
        self.assertEqual(r["courtyards"]["J1"]["sides"], ["bottom", "top"], "through-hole parts occupy both sides")

    def test_overlap_names_both_parts(self):
        from vx_eng.cli import cmd_layout_check
        r = cmd_layout_check(FIXTURE, _layout(C1={"x_mm": 14, "y_mm": 11}))
        overlap = next(p for p in r["problems"] if p["code"] == "courtyard_overlap")
        self.assertEqual(sorted(overlap["refs"]), ["C1", "U1"])

    def test_bottom_side_part_may_sit_under_a_top_part(self):
        from vx_eng.cli import cmd_layout_check
        r = cmd_layout_check(FIXTURE, _layout(C1={"x_mm": 15.5, "y_mm": 11, "side": "bottom"}))
        self.assertTrue(r["ok"], r["problems"])

    def test_outside_board_gives_allowed_range(self):
        from vx_eng.cli import cmd_layout_check
        r = cmd_layout_check(FIXTURE, _layout(D1={"x_mm": 33.5}))
        p = next(p for p in r["problems"] if p["code"] == "outside_board" and p.get("ref") == "D1")
        lo, hi = p["allowed"]["x"]
        self.assertAlmostEqual(hi, 34 - 0.78, delta=0.05)   # 0603 rotated 90: courtyard half-width 0.78 mm
        self.assertLess(lo, 1)

    def test_structural_problems(self):
        from vx_eng.cli import cmd_layout_check
        lay = _layout(U1={"rotation_deg": 45})
        lay["placements"] = [p for p in lay["placements"] if p["ref"] != "R1"] + [{"ref": "Q9", "x_mm": 1, "y_mm": 1}]
        lay["board"]["mounting_holes"][0]["size"] = "M4"
        r = cmd_layout_check(FIXTURE, lay)
        self.assertEqual(sorted({p["code"] for p in r["problems"]}),
                         ["bad_hole", "bad_rotation", "missing_placement", "unknown_ref"])


class BoardBuildTests(unittest.TestCase):
    """Builds the fixture board (Freerouting + KiCad DRC). Slow: about a minute."""

    @classmethod
    def setUpClass(cls):
        import os
        from vx_eng.cli import cmd_layout_build
        cls.tmp = tempfile.TemporaryDirectory()
        os.environ.setdefault("VX_3DMODEL_FETCH", "0")   # models are reported, not required, in unit tests
        cls.out = Path(cls.tmp.name) / "board"
        cls.result = cmd_layout_build(FIXTURE, LAYOUT, cls.out)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_routed_board_passes_drc_with_schematic_parity(self):
        r = self.result
        self.assertTrue(r["ok"], r.get("problems"))
        self.assertEqual((r["drc"]["errors"], r["drc"]["unconnected"], r["drc"]["parity"]), (0, 0, 0))
        self.assertGreater(r["routing"]["segments"], 0)
        self.assertEqual(r["routing"]["ground_pour"]["layers"], ["F.Cu", "B.Cu"])
        self.assertEqual(r["board"]["footprints"], 10)

    def test_board_is_linked_to_schematic_symbols(self):
        import pcbnew
        from vx_eng.pcb import _read_netlist
        paths, _, _ = _read_netlist(self.out / "netlist.net")
        board = pcbnew.LoadBoard(str(self.out / "ldo_led_fixture.kicad_pcb"))
        for fp in board.GetFootprints():
            if fp.GetReference().startswith("H"):
                self.assertTrue(fp.IsBoardOnly())
            else:
                self.assertEqual(fp.GetPath().AsString().strip("/"), paths[fp.GetReference()])
        pads = {(fp.GetReference(), p.GetNumber()): p.GetNetname() for fp in board.GetFootprints() for p in fp.Pads()}
        self.assertEqual(pads[("U1", "5")], "/+3V3")
        self.assertEqual(pads[("U1", "2")], "/GND")

    def test_project_zip_and_exports(self):
        import zipfile
        r = self.result
        with zipfile.ZipFile(self.out / r["files"]["project_zip"]) as z:
            names = sorted(z.namelist())
        self.assertIn("ldo_led_fixture/ldo_led_fixture.kicad_pcb", names)
        self.assertIn("ldo_led_fixture/ldo_led_fixture.kicad_sch", names)
        for key in ("pcb_svg_top", "pcb_svg_bottom", "step", "glb", "render_top", "render_iso"):
            self.assertIn(key, r["files"], r.get("export_errors"))
            self.assertGreater((self.out / r["files"][key]).stat().st_size, 1000)
        self.assertTrue((self.out / r["files"]["step"]).read_bytes().startswith(b"ISO-10303-21"))

    def test_models_are_reported_per_part(self):
        m = self.result["models"]
        self.assertEqual(m["total"], 6)
        for miss in m["missing"]:
            self.assertIn(miss["status"], ("missing",))
            self.assertTrue(miss["source"].startswith("https://gitlab.com/kicad/libraries/kicad-packages3D/"))

    def test_unrouted_board_fails_drc(self):
        """Negative control: the same board without routing reports unconnected items."""
        from vx_eng import pcb
        from vx_eng.cli import cmd_build
        out = Path(self.tmp.name) / "unrouted"
        cmd_build(FIXTURE, out)
        pcb.build_board(Circuit.from_json(FIXTURE), pcb.Layout.from_json({**LAYOUT, "ground_pour": None}), out,
                        "ldo_led_fixture", "x", route=False)
        report = pcb.drc(out, "ldo_led_fixture.kicad_pcb")
        self.assertGreater(report["unconnected"], 0)
        self.assertEqual(report["parity"], 0)

    def test_parity_catches_a_board_that_drifted_from_the_schematic(self):
        """Negative control: a footprint whose link to its schematic symbol is lost is reported."""
        import pcbnew
        from vx_eng import pcb
        src = self.out / "ldo_led_fixture.kicad_pcb"
        work = Path(self.tmp.name) / "drift"
        work.mkdir()
        for f in self.out.iterdir():
            if f.is_file():
                (work / f.name).write_bytes(f.read_bytes())
        board = pcbnew.LoadBoard(str(work / src.name))
        r1 = next(fp for fp in board.GetFootprints() if fp.GetReference() == "R1")
        r1.SetValue("10k")
        pcbnew.SaveBoard(str(work / src.name), board)
        report = pcb.drc(work, src.name, refill=False)
        self.assertGreater(report["parity"], 0)
        self.assertTrue(any("10k" in v["description"] or "Value" in v["description"] for v in report["schematic_parity"]),
                        report["schematic_parity"])


class FabPackageTests(unittest.TestCase):
    """G4.5: fab package from the routed fixture board, plus negative controls for every independent check."""

    @classmethod
    def setUpClass(cls):
        import os
        from vx_eng.cli import cmd_fab_package, cmd_layout_build
        os.environ.setdefault("VX_3DMODEL_FETCH", "0")
        cls.tmp = tempfile.TemporaryDirectory()
        root = Path(cls.tmp.name)
        built = cmd_layout_build(FIXTURE, LAYOUT, root / "board")
        assert built["ok"], built.get("problems")
        cls.project_zip = root / "board" / built["files"]["project_zip"]
        cls.out = root / "pkg"
        cls.result = cmd_fab_package(cls.project_zip, cls.out, panel=True, profile=None)
        cls.check = json.loads((cls.out / "fab-check.json").read_text())

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_package_passes_all_checks(self):
        r = self.result
        self.assertTrue(r["ok"], r.get("problems"))
        self.assertEqual(r["drc"], {"errors": 0, "warnings": 0, "unconnected": 0, "parity": 0, "waived": 0})
        self.assertEqual(r["gerbers"]["outline_mm"], [34.0, 22.0])
        self.assertEqual(r["gerbers"]["drill_hits"]["nonplated"], 4, "four M3 mounting holes")
        self.assertEqual(r["assembly"]["cpl_rows"], 6)
        self.assertEqual(r["profile"]["house"], "jlcpcb")
        self.assertEqual(r["panel"]["boards"], 4)
        self.assertTrue(any(w["code"] == "lcsc_missing" for w in r["warnings"]), "no LCSC numbers yet: warned, not hidden")

    def test_package_zip_and_manifest(self):
        import hashlib
        import zipfile
        with zipfile.ZipFile(self.out / self.result["files"]["package"]) as z:
            names = set(z.namelist())
            manifest = json.loads(z.read("manifest.json"))
            for arc, sha in manifest.items():
                self.assertEqual(hashlib.sha256(z.read(arc)).hexdigest(), sha, arc)
        for f in ("gerbers.zip", "bom.csv", "cpl.csv", "FAB-NOTES.txt", "assembly-top.pdf", "drill-map.pdf",
                  "panel/panel-gerbers.zip", "manifest.json"):
            self.assertIn(f, names)
        notes = (self.out / "FAB-NOTES.txt").read_text()
        self.assertIn("34.0 x 22.0 mm", notes)
        self.assertIn("MISSING for C1, C2, D1, J1, R1, U1", notes)

    def test_exchange_formats_are_written_and_checked(self):
        import zipfile
        ex = self.check["exports"]
        self.assertTrue(ex["ok"], ex["problems"])
        self.assertEqual(sorted(ex["files"]), ["dxf", "ipc2581", "ipcd356", "odb"])
        self.assertEqual(ex["summary"]["ipc2581"]["revision"], "C")
        self.assertEqual(ex["summary"]["ipc2581"]["copper_layers"], 2)
        self.assertEqual(ex["summary"]["odb"]["signal_layers"], 2)
        self.assertEqual(ex["summary"]["ipc2581"]["outline_mm"], [34.0, 22.0])
        self.assertEqual(ex["summary"]["dxf"]["outline_mm"], [34.0, 22.0])
        self.assertIn("U1", ex["summary"]["odb"]["components"])
        self.assertGreaterEqual(ex["summary"]["ipcd356"]["nets"], 4)
        with zipfile.ZipFile(self.out / self.result["files"]["package"]) as z:
            names = set(z.namelist())
        for fn in ex["files"].values():
            self.assertIn(f"formats/{fn}", names)
        self.assertIn("IPC-D-356 netlist", (self.out / "FAB-NOTES.txt").read_text())

    def test_exchange_format_check_catches_a_different_board(self):
        from vx_eng.exports import check_exports
        files = {f: self.out / "formats" / fn for f, fn in self.check["exports"]["files"].items()}
        wrong = {"copper_layers": 4, "refs": ["C1", "U1", "U9"], "width_mm": 40.0, "height_mm": 22.0, "nets": ["GND", "/NOT_A_NET"]}
        codes = {p["code"] for p in check_exports(files, wrong)["problems"]}
        self.assertEqual(codes, {"ipc2581_layers", "ipc2581_components", "ipc2581_outline", "odb_layers", "odb_components", "odb_outline",
                                 "ipcd356_nets", "dxf_outline"})

    def _facts(self, **changes):
        facts = copy.deepcopy({**self.check["board"], "parts": self.check["parts"]})
        facts.update(changes)
        return facts

    def test_gerber_check_catches_wrong_outline_and_drills(self):
        from vx_eng.fab import PROFILES
        from vx_eng.release import check_gerbers
        gz = self.out / "gerbers.zip"
        prof = PROFILES["jlcpcb-2layer-standard"]
        self.assertTrue(check_gerbers(gz, self._facts(), prof)["ok"])
        r = check_gerbers(gz, self._facts(width_mm=40.0), prof)
        self.assertIn("outline_size", [p["code"] for p in r["problems"]])
        holes = dict(self.check["board"]["holes"], vias=self.check["board"]["holes"]["vias"] + 1)
        r = check_gerbers(gz, self._facts(holes=holes), prof)
        self.assertIn("drill_count", [p["code"] for p in r["problems"]])

    def test_gerber_check_applies_fab_limits(self):
        import dataclasses
        from vx_eng.fab import PROFILES
        from vx_eng.release import check_gerbers
        strict = dataclasses.replace(PROFILES["jlcpcb-2layer-standard"], copper_edge_clearance_mm=1.0,
                                     min_board_mm=50.0, min_hole_mm=0.5, min_via_drill_mm=0.5)
        codes_ = sorted({p["code"] for p in check_gerbers(self.out / "gerbers.zip", self._facts(), strict)["problems"]})
        self.assertEqual(codes_, ["board_size", "copper_to_edge", "min_drill"])

    def test_assembly_check_catches_cpl_and_bom_errors(self):
        from vx_eng.release import check_assembly
        work = Path(self.tmp.name) / "tampered"
        work.mkdir(exist_ok=True)
        rows = (self.out / "cpl.csv").read_text().splitlines()
        shifted = [rows[0]] + [r.replace("10.00,-11.00", "11.00,-11.00") for r in rows[1:] if not r.startswith("R1,")]
        (work / "cpl.csv").write_text("\n".join(shifted) + "\n")
        bom = [r for r in (self.out / "bom.csv").read_text().splitlines() if "D1" not in r]
        (work / "bom.csv").write_text("\n".join(bom) + "\n")
        r = check_assembly(work / "bom.csv", work / "cpl.csv", self._facts())
        self.assertEqual(sorted({p["code"] for p in r["problems"]}), ["bom_missing", "cpl_missing", "cpl_position"])

    def test_drc_gate_refuses_a_broken_board(self):
        import pcbnew
        from vx_eng.release import build_package, unzip_project
        proj = unzip_project(self.project_zip, Path(self.tmp.name) / "broken")
        pcb = next(proj.glob("*.kicad_pcb"))
        board = pcbnew.LoadBoard(str(pcb))
        for t in list(board.GetTracks()):
            if t.GetNetname() == "/LED_A":
                board.Remove(t)
        pcbnew.SaveBoard(str(pcb), board)
        r = build_package(proj, Path(self.tmp.name) / "broken-out", panel=False)
        self.assertFalse(r["ok"])
        self.assertEqual(r["stage"], "drc")
        self.assertGreater(r["drc"]["unconnected"], 0)

    def test_lcsc_numbers_from_sourcing_reach_the_assembly_bom(self):
        from vx_eng.release import build_package, unzip_project
        proj = unzip_project(self.project_zip, Path(self.tmp.name) / "lcsc")
        r = build_package(proj, Path(self.tmp.name) / "lcsc-out", panel=False, lcsc={"U1": "C51118", "C1": "C15849", "C2": "C15849"})
        self.assertTrue(r["ok"], r.get("problems"))
        self.assertEqual(r["lcsc_applied"], ["C1", "C2", "U1"])
        bom = (Path(self.tmp.name) / "lcsc-out" / "bom.csv").read_text()
        self.assertIn("C51118", bom)
        self.assertIn('"C1,C2",Capacitor_SMD:C_0603_1608Metric,C15849', bom)
        from vx_eng.pcb import drc
        report = drc(proj, next(proj.glob("*.kicad_pcb")).name, refill=False)
        self.assertEqual(report["parity"], 0, "LCSC fields written to schematic and board alike")
        self.assertEqual(sorted(r["assembly"]["lcsc_missing"]), ["D1", "J1", "R1"])

    def test_unsafe_zip_is_rejected(self):
        import zipfile
        from vx_eng import kicad
        from vx_eng.release import unzip_project
        bad = Path(self.tmp.name) / "bad.zip"
        with zipfile.ZipFile(bad, "w") as z:
            z.writestr("../escape.txt", "x")
        with self.assertRaises(kicad.KicadError):
            unzip_project(bad, Path(self.tmp.name) / "bad")


class FourLayerTests(unittest.TestCase):
    """The fixture board on the 4-layer profile: inner ground and power planes, routed, DRC-clean, and a fab package
    whose Gerbers carry both inner layers and whose notes give the stackup."""

    @classmethod
    def setUpClass(cls):
        import os
        from vx_eng.cli import cmd_fab_package, cmd_layout_build
        os.environ.setdefault("VX_3DMODEL_FETCH", "0")
        cls.tmp = tempfile.TemporaryDirectory()
        root = Path(cls.tmp.name)
        cls.built = cmd_layout_build(FIXTURE, {**LAYOUT, "fab_profile": "jlcpcb-4layer-standard"}, root / "board")
        cls.pkg = None
        if cls.built["ok"]:
            cls.pkg = cmd_fab_package(root / "board" / cls.built["files"]["project_zip"], root / "pkg", panel=False, profile=None)
            cls.notes = (root / "pkg" / "FAB-NOTES.txt").read_text() if (root / "pkg" / "FAB-NOTES.txt").exists() else ""

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_board_has_planes_and_passes_drc(self):
        r = self.built
        self.assertTrue(r["ok"], r.get("problems"))
        self.assertEqual((r["drc"]["errors"], r["drc"]["unconnected"], r["drc"]["parity"]), (0, 0, 0))
        self.assertEqual(r["board"]["copper_layers"], 4)
        self.assertEqual([p["layer"] for p in r["routing"]["planes"]], ["In1.Cu", "In2.Cu"])
        self.assertEqual(r["routing"]["planes"][0]["net"], "GND")

    def test_chosen_inner_planes_are_used(self):
        from vx_eng import pcb
        lay = pcb.Layout.from_json({**LAYOUT, "fab_profile": "jlcpcb-4layer-standard", "inner_planes": ["GND", "+3V3"]})
        self.assertEqual(lay.inner_planes, ["GND", "+3V3"])

    def test_fab_package_has_inner_layers_and_stackup(self):
        self.assertIsNotNone(self.pkg)
        self.assertTrue(self.pkg["ok"], self.pkg.get("problems"))
        self.assertFalse([p for p in self.pkg.get("problems", []) if p.get("code") == "inner_layers"])
        self.assertIn("In1.Cu ground plane", self.notes)



class ModelCheckTests(unittest.TestCase):
    """Manufacturer 3D model alignment: synthetic vendor-style models, plus a round trip through KiCad's STEP export."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_reoriented_model_is_aligned_to_the_pads(self):
        from model_fixtures import sot23_5
        from vx_eng import modelcheck
        r = modelcheck.check(sot23_5(self.dir / "vendor.step"), "Package_TO_SOT_SMD:SOT-23-5", self.dir / "out", {"height_mm": 1.2})
        self.assertEqual(r["status"], "checked", r)
        self.assertEqual((r["terminals"], r["pads"]), (5, 5))
        self.assertLessEqual(r["worst_offset_mm"], 0.25)
        self.assertAlmostEqual(r["body_mm"]["z"], 1.2, places=2)
        self.assertEqual(r["warnings"], [], "3 + 2 leads fix the orientation")
        self.assertTrue((self.dir / "out" / "aligned.step").read_bytes().startswith(b"ISO-10303-21"))
        self.assertIn("<svg", (self.dir / "out" / "overlay.svg").read_text())

    def test_zip_download_is_unpacked(self):
        import zipfile
        from model_fixtures import sot23_5
        from vx_eng import modelcheck
        step = sot23_5(self.dir / "part.step")
        z = self.dir / "cad.zip"
        with zipfile.ZipFile(z, "w") as f:
            f.writestr("readme.txt", "x")
            f.write(step, "KiCad/3D/part.step")
        self.assertEqual(modelcheck.check(z, "Package_TO_SOT_SMD:SOT-23-5", self.dir / "out")["status"], "checked")

    def test_wrong_model_or_wrong_footprint_fails(self):
        from model_fixtures import sot23_5
        from vx_eng import modelcheck
        four = sot23_5(self.dir / "four.step", leads=((-1.25, -0.95), (-1.25, 0.95), (1.25, 0.95), (1.25, -0.95)))
        r = modelcheck.check(four, "Package_TO_SOT_SMD:SOT-23-5", self.dir / "o1")
        self.assertNotEqual(r["status"], "checked")
        self.assertTrue(any("4 terminal(s)" in p for p in r["problems"]), r["problems"])
        r = modelcheck.check(sot23_5(self.dir / "ok.step"), "Capacitor_SMD:C_0603_1608Metric", self.dir / "o2")
        self.assertNotEqual(r["status"], "checked")
        r = modelcheck.check(sot23_5(self.dir / "tall.step"), "Package_TO_SOT_SMD:SOT-23-5", self.dir / "o3", {"height_mm": 2.5})
        self.assertEqual(r["status"], "check_failed")
        self.assertTrue(any("height" in p for p in r["problems"]))

    def test_symmetric_package_is_flagged_for_pin_1(self):
        from model_fixtures import sot23_5
        from vx_eng import modelcheck
        # Six leads, three a side, on SOT-23-6: 0 and 180 degrees fit equally, so pin 1 needs a human look.
        six = ((-1.25, -0.95), (-1.25, 0.0), (-1.25, 0.95), (1.25, 0.95), (1.25, 0.0), (1.25, -0.95))
        r = modelcheck.check(sot23_5(self.dir / "sym.step", leads=six), "Package_TO_SOT_SMD:SOT-23-6", self.dir / "o")
        self.assertEqual(r["status"], "checked", r["problems"])
        self.assertTrue(any("pin 1 / polarity cannot be confirmed" in w for w in r["warnings"]), r["warnings"])

    def test_not_a_step_file(self):
        from vx_eng import modelcheck
        bad = self.dir / "x.step"
        bad.write_text("hello")
        with self.assertRaises(ValueError):
            modelcheck.check(bad, "Package_TO_SOT_SMD:SOT-23-5", self.dir / "o")

    def test_aligned_model_lands_on_the_pads_in_kicads_board_step(self):
        """Round trip: place the aligned model on a board in KiCad, export the board STEP, find the leads on the pads."""
        import cadquery as cq
        import pcbnew
        from model_fixtures import sot23_5
        from vx_eng import modelcheck
        r = modelcheck.check(sot23_5(self.dir / "vendor.step"), "Package_TO_SOT_SMD:SOT-23-5", self.dir / "out")
        aligned = self.dir / "out" / "aligned.step"
        board = pcbnew.CreateEmptyBoard()
        from vx_eng.pcb import load_footprint
        fp = load_footprint("Package_TO_SOT_SMD:SOT-23-5")
        board.Add(fp)
        fp.SetPosition(pcbnew.VECTOR2I(pcbnew.FromMM(20), pcbnew.FromMM(15)))
        fp.SetOrientationDegrees(90)
        m = pcbnew.FP_3DMODEL()
        m.m_Filename = str(aligned)
        fp.Models().clear()
        fp.Models().push_back(m)
        edge = pcbnew.PCB_SHAPE(board)
        edge.SetShape(pcbnew.SHAPE_T_RECT)
        edge.SetStart(pcbnew.VECTOR2I(pcbnew.FromMM(10), pcbnew.FromMM(5)))
        edge.SetEnd(pcbnew.VECTOR2I(pcbnew.FromMM(30), pcbnew.FromMM(25)))
        edge.SetLayer(pcbnew.Edge_Cuts)
        board.Add(edge)
        pcb = self.dir / "b.kicad_pcb"
        pcbnew.SaveBoard(str(pcb), board)
        import subprocess
        subprocess.run(["kicad-cli", "pcb", "export", "step", "--no-board-body", "-f", "-o", "b.step", pcb.name],
                       cwd=self.dir, capture_output=True, text=True, timeout=300)
        shape = cq.importers.importStep(str(self.dir / "b.step"))
        z0 = shape.val().BoundingBox().zmin
        feet = [f.Center() for f in shape.section(z0 + 0.05).faces().vals()]
        self.assertEqual(len(feet), 5, "five feet at the board surface")
        pads = []
        for p in fp.Pads():
            c = p.GetPosition()
            b = p.GetBoundingBox()
            pads.append((pcbnew.ToMM(b.GetLeft()), pcbnew.ToMM(b.GetRight()), pcbnew.ToMM(b.GetTop()), pcbnew.ToMM(b.GetBottom())))
        # KiCad's STEP export: X as on the board, Y negated; origin is the board's drawing origin.
        for f in feet:
            x, y = f.x, -f.y
            hit = [p for p in pads if p[0] - 0.05 <= x <= p[1] + 0.05 and p[2] - 0.05 <= y <= p[3] + 0.05]
            if not hit:   # exports may be centred on the board instead of the page origin
                x, y = f.x + 20, -f.y + 15
                hit = [p for p in pads if p[0] - 0.05 <= x <= p[1] + 0.05 and p[2] - 0.05 <= y <= p[3] + 0.05]
            self.assertTrue(hit, f"foot at ({f.x:.2f}, {f.y:.2f}) is on no pad; pads {pads}")


class VerifiedModelInLayoutTests(unittest.TestCase):
    """A verified manufacturer model replaces KiCad's generic one, ships inside the project and shows in the board STEP."""

    def test_layout_uses_the_verified_model(self):
        import os
        import zipfile
        from model_fixtures import sot23_5
        from vx_eng import modelcheck
        from vx_eng.cli import cmd_layout_build
        os.environ.setdefault("VX_3DMODEL_FETCH", "0")
        with tempfile.TemporaryDirectory() as tmp:
            d = Path(tmp)
            r = modelcheck.check(sot23_5(d / "vendor.step", body_height=1.3), "Package_TO_SOT_SMD:SOT-23-5", d / "chk")
            self.assertEqual(r["status"], "checked")
            built = cmd_layout_build(FIXTURE, LAYOUT, d / "board",
                                     {"U1": {"path": str(d / "chk" / "aligned.step"), "name": "AP2112K-3.3TRG1"}})
            self.assertTrue(built["ok"], built.get("problems"))
            models = json.loads((d / "board" / "models.json").read_text())
            u1 = next(m for m in models if m["ref"] == "U1")
            self.assertEqual((u1["status"], u1["model"]), ("found", "3dmodels/AP2112K-3.3TRG1.step"))
            with zipfile.ZipFile(d / "board" / built["files"]["project_zip"]) as z:
                self.assertIn("ldo_led_fixture/3dmodels/AP2112K-3.3TRG1.step", z.namelist())
            # The board STEP contains the 1.3 mm body (KiCad's generic SOT-23-5 is 1.45 mm with a different shape).
            import cadquery as cq
            s = cq.importers.importStep(str(d / "board" / built["files"]["step"]))
            self.assertGreater(len(s.solids().vals()), 1)


ENCLOSURE = {"process": "fdm", "material": "PETG", "wall_mm": 2, "edge_gap_mm": 0.5, "top_clearance_mm": 2, "standoff_height_mm": 6,
             "fastening": "heat_set_insert",
             "openings": [{"kind": "top", "ref": "J1", "shape": "rect", "margin_mm": 0.5},
                          {"kind": "top", "ref": "D1", "shape": "round", "size_mm": 2.5}]}


class EnclosureTests(unittest.TestCase):
    """Enclosure around the fixture board with stand-in 3D models for every part."""

    @classmethod
    def setUpClass(cls):
        import os
        from model_fixtures import fixture_board_models
        from vx_eng.cli import cmd_layout_build
        os.environ.setdefault("VX_3DMODEL_FETCH", "0")
        cls.tmp = tempfile.TemporaryDirectory()
        d = Path(cls.tmp.name)
        built = cmd_layout_build(FIXTURE, LAYOUT, d / "board", fixture_board_models(d))
        assert built["ok"], built.get("problems")
        cls.project = d / "board"

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def build(self, name, **changes):
        from vx_eng.enclosure import build_enclosure
        spec = {**copy.deepcopy(ENCLOSURE), **changes}
        return build_enclosure(self.project, spec, Path(self.tmp.name) / name)

    def test_fixture_enclosure_fits(self):
        r = self.build("ok")
        self.assertTrue(r["ok"], r["problems"])
        self.assertEqual(r["collisions"], [])
        self.assertEqual(sorted(r["board"]["parts_checked"]), ["C1", "C2", "D1", "J1", "R1", "U1"])
        self.assertEqual(len(r["mounting"]), 4)
        self.assertEqual(r["mounting"]["H1"]["hole_mm"], 4.2, "M3 heat-set insert hole")
        self.assertAlmostEqual(r["dimensions_mm"]["x"], 34 + 2 * (0.5 + 2), places=1)
        self.assertGreater(min(r["clearance_mm"].values()), 1.5)
        for f in ("base_step", "lid_step", "base_stl", "lid_stl", "assembly_step", "exploded_glb", "base_top_svg"):
            self.assertGreater((Path(self.tmp.name) / "ok" / r["files"][f]).stat().st_size, 500, f)
        self.assertGreater(r["mass_g"]["base"], 1)
        # Base and lid are open halves that meet at the split plane (a closed box would still "fit").
        import cadquery as cq
        base = cq.importers.importStep(str(Path(self.tmp.name) / "ok" / r["files"]["base_step"])).val().BoundingBox()
        lid = cq.importers.importStep(str(Path(self.tmp.name) / "ok" / r["files"]["lid_step"])).val().BoundingBox()
        lv = r["levels_mm"]
        self.assertAlmostEqual(base.zmax, lv["split"], places=2)
        self.assertAlmostEqual(base.zmin, lv["floor_bottom"], places=2)
        self.assertAlmostEqual(lid.zmax, lv["top_outer"], places=2)
        self.assertAlmostEqual(lid.zmin, lv["split"] - lv["lip_height"], places=2)
        # Material check: walls 2 mm around a 35 x 23 mm cavity (0.5 mm gap) plus floor and top (each 39 x 27 x 2 with rounded corners).
        self.assertLess(r["volume_cm3"]["base"] + r["volume_cm3"]["lid"], 12, "no doubled shell")

    def test_drafted_enclosure_for_molding(self):
        r = self.build("molded", draft_deg=2)
        self.assertTrue(r["ok"], r["problems"])
        self.assertEqual(r["levels_mm"]["draft_deg"], 2)
        import cadquery as cq
        lid = cq.importers.importStep(str(Path(self.tmp.name) / "molded" / r["files"]["lid_step"]))
        self.assertEqual(len(lid.solids().vals()), 1, "the lid is one piece")
        self.assertAlmostEqual(lid.val().BoundingBox().zmax, r["levels_mm"]["top_outer"], delta=0.01)

    def test_lid_grows_over_parts_without_an_opening(self):
        r = self.build("no-window", openings=[{"kind": "top", "ref": "D1", "shape": "round", "size_mm": 2.5}])
        self.assertTrue(r["ok"], r["problems"])
        self.assertGreater(r["levels_mm"]["lid_inner"], 1.6 + 8.5, "lid clears the 8.5 mm header pins")

    def test_lid_too_low_is_a_collision_naming_the_parts(self):
        r = self.build("low-lid", top_clearance_mm=-0.5)
        self.assertFalse(r["ok"])
        hits = {(p["ref"], p["part"]) for p in r["problems"] if p["code"] == "interference"}
        self.assertIn(("U1", "lid"), hits, r["problems"])

    def test_short_standoffs_hit_through_hole_pins_and_cannot_take_inserts(self):
        r = self.build("short", standoff_height_mm=1)
        codes = {(p["code"], p.get("ref")) for p in r["problems"]}
        self.assertIn(("interference", "J1"), codes, "J1's pins reach 1.4 mm below the board's underside")
        self.assertIn(("boss_depth", "H1"), codes)

    def test_process_rules(self):
        r = self.build("cnc", process="cnc_aluminum")
        codes = {p["code"] for p in r["problems"]}
        self.assertEqual(codes & {"fastening", "inner_radius"}, {"fastening", "inner_radius"})
        r = self.build("thin", wall_mm=0.8)
        self.assertIn("wall", {p["code"] for p in r["problems"]})

    def test_edge_opening_reports_the_wall_and_recess(self):
        r = self.build("edge", openings=[{"kind": "edge", "ref": "J1", "margin_mm": 0.5},
                                         {"kind": "top", "ref": "D1", "shape": "round", "size_mm": 2.5}],
                       top_clearance_mm=7.5)
        j1 = next(o for o in r["openings"] if o["ref"] == "J1")
        self.assertEqual(j1["side"], "left", "J1 sits 1.3 mm from the left edge")
        self.assertGreater(j1["recess_mm"], 1.5)
        self.assertIn("connector_recessed", {w["code"] for w in r["warnings"]})
        self.assertNotIn(("J1", "lid"), {(p.get("ref"), p.get("part")) for p in r["problems"]})

    def test_bad_spec(self):
        r = self.build("bad", openings=[{"kind": "top", "ref": "Q9"}])
        self.assertEqual(r["stage"], "spec")
        r = self.build("bad2", process="injection")
        self.assertEqual(r["stage"], "spec")



class SpiceTest(unittest.TestCase):
    def test_refuses_shell_access_and_runs_a_deck(self):
        import shutil
        from vx_eng import spice
        self.assertTrue(spice.check_deck(".control\nshell touch /tmp/x\n.endc\n.tran 1u 1m\n.meas tran x FIND v(a) AT=1m"))
        self.assertTrue(any(".include" in p for p in spice.check_deck(".include /etc/passwd\n.op\n.meas op x FIND v(a)")))
        if not shutil.which("ngspice"):
            self.skipTest("ngspice not installed")
        with tempfile.TemporaryDirectory() as d:
            r = spice.simulate("RC\nV1 in 0 PULSE(0 1 0 1n 1n 1 2)\nR1 in out 1k\nC1 out 0 1u\n.tran 1u 5m\n"
                               ".meas tran tau WHEN v(out)=0.632 RISE=1\n", Path(d))
        self.assertTrue(r["ok"], r)
        self.assertLess(abs(r["measures"]["tau"] - 1e-3), 2e-5)
