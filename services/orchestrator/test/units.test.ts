import { test } from "node:test";
import assert from "node:assert/strict";
import { matchText, normalize } from "../src/datasheet.ts";
import { toCircuitCheck, type BuildResult } from "../src/engineering.ts";
import { executorsFor } from "../src/executors/index.ts";

const SHEET = `AP2112 600mA CMOS LDO REGULATOR WITH ENABLE
Features: Output current 600 mA. Dropout voltage 250mV at 600mA. Operating temperature -40°C to +85°C.
Ordering information: AP2112K - 3.3 TRG1 ... AP2112 K - X TR G 1`;

test("datasheet text match: exact part number and spaced values", () => {
  const r = matchText(SHEET, "AP2112K-3.3TRG1", [{ parameter: "Output current", value: "600mA" },
    { parameter: "Dropout", value: "250 mV" }, { parameter: "Quiescent current", value: "55uA" }]);
  assert.equal(r.mpn.found, "exact");
  assert.deepEqual(r.claims.map((c) => c.found), [true, true, false]);
  assert.match(r.claims[0]!.excerpt!, /600\s*mA/);
  assert.equal(normalize("−40 µA"), "-40ua");
});

test("datasheet text match: falls back to the base part number, never to a fragment", () => {
  assert.equal(matchText("Order code AP2112K-3.3 in SOT-25", "AP2112K-3.3TRG1", []).mpn.found, "base");
  assert.equal(matchText("nothing relevant here", "AP2112K-3.3TRG1", []).mpn.found, "no");
});

test("build results become actionable feedback", () => {
  const base = { generator_version: "0.3.0", kicad_version: "10.0.8", validation: { ok: true, errors: [], warnings: [], components: [] } };
  const invalid = toCircuitCheck({ ...base, ok: false, stage: "validation", validation: { ok: false, components: [], warnings: [],
    errors: [{ code: "unknown_symbol", message: "U1: symbol X:Y is not in the KiCad libraries", suggestions: ["X:Z"] }] } } as BuildResult);
  assert.deepEqual(invalid.problems, ["U1: symbol X:Y is not in the KiCad libraries (closest library entries: X:Z)"]);
  const erc = toCircuitCheck({ ...base, ok: false, stage: "built", erc: { errors: 1, warnings: 1, violations: [
    { severity: "error", type: "power_pin_not_driven", description: "Input Power pin not driven", items: ["Symbol U1 Pin 1 [VIN]"] },
    { severity: "warning", type: "lib_symbol_mismatch", description: "Symbol differs", items: [] }] },
    netlist: { match: true, nets: 3, missing: [], unexpected: [] } } as BuildResult);
  assert.equal(erc.stage, "erc");
  assert.match(erc.problems[0]!, /power_pin_not_driven.*U1 Pin 1/);
  assert.equal(erc.warnings.length, 1);
  const net = toCircuitCheck({ ...base, ok: false, stage: "built", erc: { errors: 0, warnings: 0, violations: [] },
    netlist: { match: false, nets: 3, missing: [["R1.2", "D1.2"]], unexpected: [] } } as BuildResult);
  assert.equal(net.stage, "netlist");
  assert.match(net.problems[0]!, /missing the intended connection R1.2 - D1.2/);
});

test("workers without KiCad do not claim schematic tasks", () => {
  const plain = new Set(executorsFor(null).flatMap((e) => e.disciplines));
  assert.ok(!plain.has("schematic"));
  assert.ok(plain.has("architecture") && plain.has("pcb_layout"));
  const eng = executorsFor({ python: "python3", dir: "/opt/vx", versions: { vx_eng: "0.3.0", kicad: "10.0.8" } });
  assert.ok(eng.flatMap((e) => e.disciplines).includes("schematic"));
});
