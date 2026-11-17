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
