import { test } from "node:test";
import assert from "node:assert/strict";
import { enclosureStacks, gasket, GASKET_PRESETS, stack, thermal, thermalFromReports } from "../src/index.ts";

test("stack: worst case and RSS by hand", () => {
  // Gap = 10 − 9.5 − 0.3 with ±0.1, ±0.1, ±0.05.
  const r = stack({ min_gap: 0, contributors: [
    { name: "slot", nominal: 10, plus: 0.1, minus: 0.1, sign: 1 },
    { name: "part", nominal: 9.5, plus: 0.1, minus: 0.1, sign: -1 },
    { name: "shim", nominal: 0.3, plus: 0.05, minus: 0.05, sign: -1, assumed: true },
  ] });
  assert.equal(r.nominal, 0.2);
  assert.deepEqual(r.worst, { min: -0.05, max: 0.45 });
  const half = Math.sqrt(0.01 + 0.01 + 0.0025);   // 0.15
  assert.deepEqual(r.rss, { min: Math.round((0.2 - half) * 1e4) / 1e4, max: Math.round((0.2 + half) * 1e4) / 1e4 });
  assert.equal(r.verdict, "pass_statistical", "worst case interferes, statistically clear");
  assert.deepEqual(r.shares.map((s) => s.pct), [44.4, 44.4, 11.1]);
  assert.deepEqual(r.assumed, ["shim"]);
});

test("stack: asymmetric tolerance shifts the statistical mean; verdicts", () => {
  const r = stack({ min_gap: 0.1, max_gap: 1, contributors: [{ name: "a", nominal: 0.5, plus: 0.2, minus: 0, sign: 1 }] });
  assert.deepEqual(r.worst, { min: 0.5, max: 0.7 });
  assert.deepEqual(r.rss, { min: 0.5, max: 0.7 });
  assert.equal(r.verdict, "pass");
  assert.equal(stack({ min_gap: 1, contributors: [{ name: "a", nominal: 0.5, plus: 0.1, minus: 0.1, sign: 1 }] }).verdict, "fail");
  assert.equal(stack({ contributors: [{ name: "a", nominal: 0.5, plus: 0.1, minus: 0.1, sign: 1 }] }).verdict, "no_limit");
  assert.deepEqual(stack({ contributors: [{ name: "", nominal: 1, plus: -1, minus: 0, sign: 1 }] }).problems,
    ["contributor 1 needs a name", "contributor 1: tolerances are given as positive amounts"]);
});

test("gasket: O-ring compression and gland fill at the extremes", () => {
  const p = GASKET_PRESETS.find((x) => x.key === "oring_face_static")!;
  const ok = gasket({ kind: "oring", section: { nominal: 2, plus: 0.08, minus: 0.08 }, gap: { nominal: 1.5, plus: 0.03, minus: 0.03 },
                      groove_width: { nominal: 2.8, plus: 0.05, minus: 0.05 }, min_pct: p.min_pct, max_pct: p.max_pct, max_fill_pct: p.max_fill_pct });
  assert.deepEqual(ok.compression_pct, { min: 20.3, nominal: 25, max: 29.3 });
  assert.equal(ok.fill_pct, 84.1);
  assert.equal(ok.verdict, "pass");
  const tight = gasket({ kind: "oring", section: { nominal: 2, plus: 0.08, minus: 0.08 }, gap: { nominal: 1.4, plus: 0.1, minus: 0.1 },
                         groove_width: { nominal: 2.5, plus: 0, minus: 0.1 }, min_pct: 15, max_pct: 30, max_fill_pct: 85 });
  assert.equal(tight.verdict, "fail");
  assert.match(tight.findings.join("; "), /compression can reach 37\.5%.*groove fill reaches 108\.9%/);
});

test("gasket: foam needs no groove width", () => {
  const r = gasket({ kind: "foam", section: { nominal: 3, plus: 0.3, minus: 0.3 }, gap: { nominal: 2, plus: 0.2, minus: 0.2 }, min_pct: 25, max_pct: 50 });
  assert.deepEqual(r.compression_pct, { min: 18.5, nominal: 33.3, max: 45.5 });
  assert.equal(r.verdict, "fail");
  assert.equal(r.fill_pct, null);
});

test("thermal: air rise from surface area; junctions inside the box", () => {
  const r = thermal({ power_w: 1.2, box_mm: { x: 100, y: 60, z: 30 }, h_w_m2k: 5, ambient_max_c: 40, air_limit_c: 45,
    sources: [{ name: "LDO", watts: 0.4, theta_ja: 200, tj_max: 125 }, { name: "MCU", watts: 0.1, theta_ja: null }] });
  assert.equal(r.area_m2, 0.0216);
  assert.equal(r.air_rise_c, 11.1);
  assert.equal(r.air_c, 51.1);
  assert.deepEqual(r.sources[0], { name: "LDO", tj_c: 131.1, margin_c: -6.1, ok: false });
  assert.equal(r.sources[1]!.ok, null);
  assert.equal(r.verdict, "fail");
  assert.equal(r.findings.length, 2);
});

test("starting points from the fit report and power budget", () => {
  const fit = { dimensions_mm: { x: 60, y: 40, z: 22 }, board: { thickness_mm: 1.6 },
                spec: { edge_gap_mm: 0.5, top_clearance_mm: 2, standoff_height_mm: 4, openings: [{ ref: "J1", kind: "edge", margin_mm: 0.5 }, { ref: "SW1", kind: "top" }] } };
  const stacks = enclosureStacks(fit, { tolerance_mm: 0.3, basis: "Example Prints, process rules checked 2026-11-01", assumed: false });
  assert.deepEqual(stacks.map((s) => s.title), ["Board edge to enclosure wall", "Tallest component to lid", "J1 opening alignment"]);
  const edge = stack(stacks[0]!.input);
  assert.deepEqual(edge.worst, { min: -0.1, max: 1.1 });
  assert.equal(edge.verdict, "pass_statistical");
  assert.ok(edge.assumed.includes("Board outline (half, per side)"));
  const th = thermalFromReports({ ambientC: { max: 40 }, sources: [{ powerW: { active: 0.8, sleep: 0.01 } }, { powerW: { active: 0.2 } }],
    converters: [{ label: "U3 LDO", pdissMaxW: 0.5, tjMaxC: 90 }, { label: "U4", pdissMaxW: 0, tjMaxC: null }] }, fit);
  assert.equal(th!.power_w, 1);
  assert.deepEqual(th!.sources.map((s) => [s.name, s.theta_ja]), [["U3 LDO", 100]]);
  assert.equal(thermalFromReports({}, fit), null);
});
