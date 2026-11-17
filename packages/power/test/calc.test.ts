import { test } from "node:test";
import assert from "node:assert/strict";
import { calculate, structuralFindings, type PowerTree } from "../src/index.ts";

const basis = { kind: "assumption" as const, ref: "test" };
const conv = (o: Partial<PowerTree["converters"][number]> & Pick<PowerTree["converters"][number], "id" | "kind" | "input" | "output_rail" | "vout" | "max_output_a">) => ({
  label: o.id, mpn: null, vin_range: null, efficiency: null, quiescent_a: 0, dropout_v: null, ron_ohm: null,
  theta_ja_c_per_w: null, tj_max_c: 125, enable_after: null, soft_start_ms: null, basis, ...o,
});

/** 1S Li-ion -> buck-boost 3.3 V -> MCU + LED, and 3.3 V -> LDO 1.8 V -> core. */
function tree(): PowerTree {
  return {
    name: "t", title: "Test", summary: "", ambient_c: { nominal: 25, max: 50 },
    sources: [{ id: "VBAT", kind: "battery", label: "1S Li-ion", voltage: { min: 3.0, nom: 3.7, max: 4.2 }, max_current_a: 2,
                battery: { chemistry: "li_ion", cells_series: 1, cells_parallel: 1, capacity_mah: 2000, usable_fraction: 0.8 }, basis }],
    converters: [
      conv({ id: "U1", kind: "buck_boost", input: "VBAT", output_rail: "+3V3", vout: 3.3, max_output_a: 1, efficiency: 0.9, quiescent_a: 30e-6,
             vin_range: { min: 1.8, max: 5.5 }, theta_ja_c_per_w: 60 }),
      conv({ id: "U2", kind: "ldo", input: "+3V3", output_rail: "+1V8", vout: 1.8, max_output_a: 0.3, quiescent_a: 50e-6, dropout_v: 0.1,
             theta_ja_c_per_w: 200 }),
    ],
    rails: [{ id: "+3V3", label: "3.3 V", capacitance_uf: 22 }, { id: "+1V8", label: "1.8 V core", capacitance_uf: 10 }],
    loads: [
      { id: "MCU", label: "MCU", rail: "+3V3", current_a: { active: 0.05, standby: 0.002 }, peak_a: 0.1, basis },
      { id: "LED", label: "LED", rail: "+3V3", current_a: { active: 0.0013, standby: 0.0013 }, peak_a: null, basis },
      { id: "CORE", label: "Core", rail: "+1V8", current_a: { active: 0.02, standby: 0 }, peak_a: null, basis },
    ],
    modes: [{ id: "active", label: "Active", hours_per_day: 4 }, { id: "standby", label: "Standby", hours_per_day: 20 }],
    sequencing: [], assumptions: [], open_questions: [],
  };
}

const close = (a: number, b: number, tol = 1e-4) => assert.ok(Math.abs(a - b) <= tol, `${a} != ${b}`);

test("currents, losses and runtime match hand calculation", () => {
  const r = calculate(tree());
  assert.equal(r.ok, true, JSON.stringify(r.findings));
  const ldo = r.converters.find((c) => c.id === "U2")!;
  close(ldo.iinA.active!.nom, 0.02005);                          // 20 mA + 50 uA ground current
  close(ldo.pdissW.active!.nom, (3.3 - 1.8) * 0.02 + 3.3 * 50e-6);  // 30.165 mW
  const rail = r.rails.find((x) => x.id === "+3V3")!;
  close(rail.current.active!.nom, 0.05 + 0.0013 + 0.02005);
  const bb = r.converters.find((c) => c.id === "U1")!;
  const pin = (3.3 * 0.07135) / 0.9 + 3.0 * 30e-6;
  close(bb.iinA.active!.min, pin / 3.0);                           // worst input current at the lowest battery voltage
  close(bb.tjMaxC!, 50 + bb.pdissMaxW * 60, 0.1);
  const run = r.runtime[0]!;
  close(run.energyWh, 3.7 * 2 * 0.8);                              // 5.92 Wh usable
  const pActive = 3.7 * (((3.3 * 0.07135) / 0.9 + 3.7 * 30e-6) / 3.7);
  close(run.perMode.find((m) => m.mode === "active")!.hours!, Math.round((5.92 / pActive) * 10) / 10, 0.05);
  assert.ok(run.days! > 0);
  // Load power 3.3 V x 51.3 mA + 1.8 V x 20 mA = 205.29 mW from 261.7 mW at the battery: the 1.8 V LDO costs the most.
  close(r.efficiency.active!, (3.3 * 0.0513 + 1.8 * 0.02) / (3.7 * (((3.3 * 0.07135) / 0.9 + 3.7 * 30e-6) / 3.7)), 1e-3);
  assert.equal(rail.peakA > rail.current.active!.max, true, "peak includes the MCU's 100 mA burst");
});

test("LDO straight from a Li-ion cell to 3.3 V fails dropout at low battery", () => {
  const t = tree();
  t.converters[0] = conv({ id: "U1", kind: "ldo", input: "VBAT", output_rail: "+3V3", vout: 3.3, max_output_a: 0.6, dropout_v: 0.25, theta_ja_c_per_w: 250 });
  const codes = calculate(t).findings.filter((f) => f.severity === "error").map((f) => f.code);
  assert.deepEqual(codes, ["ldo_input_below_output"]);
  t.sources[0]!.voltage = { min: 3.5, nom: 3.7, max: 4.2 };
  assert.deepEqual(calculate(t).findings.filter((f) => f.severity === "error").map((f) => f.code), ["ldo_dropout"], "0.2 V headroom < 0.25 V dropout");
});

test("buck and boost topology limits", () => {
  const buck = tree();
  buck.converters[0] = { ...buck.converters[0]!, kind: "buck" };
  assert.ok(calculate(buck).findings.some((f) => f.code === "buck_no_headroom"));
  const boost = tree();
  boost.converters[0] = { ...boost.converters[0]!, kind: "boost", vout: 4.0 };
  assert.ok(calculate(boost).findings.some((f) => f.code === "boost_input_above_output"), "4.2 V full battery > 4.0 V out");
});

test("ratings: overcurrent, near limit, input range, overtemperature, source limit", () => {
  const t = tree();
  t.loads[0]!.peak_a = 1.2;
  t.converters[1]!.theta_ja_c_per_w = 3000;
  t.converters[0]!.vin_range = { min: 3.2, max: 5.5 };
  t.sources[0]!.max_current_a = 0.2;
  const codes = calculate(t).findings.map((f) => f.code);
  for (const c of ["converter_overcurrent", "overtemperature", "vin_out_of_range", "source_overcurrent"]) assert.ok(codes.includes(c), c);
});

test("sequencing is enforced by enable_after or by being derived from the earlier rail", () => {
  const t = tree();
  t.sequencing = [{ before: "+3V3", after: "+1V8", reason: "I/O before core" }];
  assert.ok(!calculate(t).findings.some((f) => f.code === "sequencing_unenforced"), "+1V8 is made from +3V3");
  t.sequencing = [{ before: "+1V8", after: "+3V3", reason: "core before I/O" }];
  assert.ok(calculate(t).findings.some((f) => f.code === "sequencing_unenforced"));
  t.converters[0]!.enable_after = "+1V8";
  assert.ok(!calculate(t).findings.some((f) => f.code === "sequencing_unenforced"));
});

test("inrush from rail capacitance and soft-start", () => {
  const t = tree();
  t.rails[0]!.capacitance_uf = 2000;
  t.converters[0]!.soft_start_ms = 1;
  const r = calculate(t);
  close(r.converters.find((c) => c.id === "U1")!.inrushA!, 2000e-6 * 3.3 / 1e-3);   // 6.6 A
  assert.ok(r.findings.some((f) => f.code === "inrush"));
});

test("structure: unknown references, two producers of one rail, loops; no numbers are computed", () => {
  const t = tree();
  t.converters.push(conv({ id: "U3", kind: "buck", input: "VUSB", output_rail: "+3V3", vout: 3.3, max_output_a: 1 }));
  t.loads.push({ id: "X", label: "x", rail: "+5V", current_a: { active: 0.1, idle: 0 }, peak_a: null, basis });
  const codes = structuralFindings(t).map((f) => f.code).sort();
  assert.deepEqual([...new Set(codes)], ["mode_missing", "rail_multiple_producers", "unknown_input", "unknown_mode", "unknown_rail"]);
  const r = calculate(t);
  assert.equal(r.ok, false);
  assert.equal(r.converters.length, 0);
  const loop = tree();
  loop.converters[0] = { ...loop.converters[0]!, input: "+1V8" };
  assert.ok(structuralFindings(loop).some((f) => f.code === "cycle"));
});

test("missing data is a warning, never a silent pass", () => {
  const t = tree();
  t.converters[0] = { ...t.converters[0]!, efficiency: null, theta_ja_c_per_w: null };
  t.converters[1] = { ...t.converters[1]!, dropout_v: null };
  t.sources[0]!.max_current_a = null;
  const r = calculate(t);
  const codes = r.findings.map((f) => f.code);
  for (const c of ["efficiency_assumed", "no_thermal_data", "ldo_dropout_unknown", "source_limit_unknown"]) assert.ok(codes.includes(c), c);
  assert.equal(r.converters.find((c) => c.id === "U1")!.efficiencyUsed, 0.85);
  assert.deepEqual(r.basis, { assumption: 6 });
});
