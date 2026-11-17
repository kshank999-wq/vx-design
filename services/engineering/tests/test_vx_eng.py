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
