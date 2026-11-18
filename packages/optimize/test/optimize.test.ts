import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeMpn, resolveBom, type Offer, type PartRecord, type SourcingProvider } from "@vx/integrations";
import { calculate, type PowerTree } from "@vx/power";
import { optimize, type OptimizeInput } from "../src/index.ts";

// A small invented catalog (test only) built to exercise each rule.
const offer = (seller: string, stock: number, prices: [number, number][], sku: string): Offer => ({
  provider: "fixture", seller, sku, stock, moq: 1, multiple: 1, packaging: null, currency: "USD", url: null,
  observedAt: "2026-01-01T00:00:00Z", status: "live", prices: prices.map(([quantity, unitPrice]) => ({ quantity, unitPrice })),
});
const rec = (mpn: string, desc: string, pkg: string, offers: Offer[], lifecycle: PartRecord["lifecycle"] = "active"): PartRecord => ({
  provider: "fixture", mpn, manufacturer: "Test", description: desc, lifecycle, lifecycleRaw: lifecycle, datasheetUrl: null, productUrl: null,
  package: pkg, specs: {}, offers,
});
const CATALOG: PartRecord[] = [
  // 10k 0402: the selector prefers the LCSC-stocked part; the other is much cheaper but has no LCSC offer.
  rec("TR-10K-L", "Resistor 10kΩ 0402 1%", "0402", [offer("LCSC", 50000, [[1, 0.02], [100, 0.01]], "C1001"), offer("Dist A", 20000, [[1, 0.02], [100, 0.012]], "A1")]),
  rec("TR-10K-C", "Resistor 10kΩ 0402 1%", "0402", [offer("Dist A", 90000, [[1, 0.004], [100, 0.002]], "A2"), offer("Dist B", 90000, [[1, 0.004], [100, 0.002]], "B2")]),
  // 1uF 0402 on the 5 V rail: needs 10 V or more.
  rec("TC-1U-16", "Capacitor 1uF 16V 0402 X5R", "0402", [offer("LCSC", 40000, [[1, 0.01]], "C2001")]),
  rec("TC-1U-25", "Capacitor 1uF 25V 0402 X5R", "0402", [offer("Dist A", 40000, [[1, 0.03]], "A3"), offer("Dist B", 40000, [[1, 0.03]], "B3")]),
  // 100nF 0402: one named part, one generic line → consolidation.
  rec("TC-100N-NAMED", "Capacitor 100nF 16V 0402 X7R", "0402", [offer("LCSC", 80000, [[1, 0.005]], "C3001"), offer("Dist A", 80000, [[1, 0.006]], "A4")]),
  rec("TC-100N-GEN", "Capacitor 100nF 25V 0402 X7R", "0402", [offer("LCSC", 80000, [[1, 0.003]], "C3002"), offer("Dist A", 80000, [[1, 0.004]], "A5")]),
  // A named regulator that is not recommended for new designs, with no known alternate.
  rec("TU-OLD-REG", "LDO 3.3V SOT-23-5", "SOT-23-5", [offer("Dist A", 300, [[1, 0.4]], "A6")], "nrnd"),
];
const provider: SourcingProvider = {
  id: "fixture", label: "Test catalog", role: "primary", terms: "test", configured: () => true,
  async searchMpn(mpn) { return CATALOG.filter((r) => normalizeMpn(r.mpn) === normalizeMpn(mpn)); },
  async searchKeyword(q) {
    const words = q.toLowerCase().split(/\s+/).filter((w) => /^(\d|resistor|capacitor)/.test(w));
    return CATALOG.filter((r) => words.every((w) => !/^\d/.test(w) || r.description!.toLowerCase().includes(w.replace(/k$/, "k")) || /v$/.test(w)));
  },
};

async function bomInput() {
  const components = [
    { ref: "R1", symbol: "Device:R", value: "10k", footprint: "Resistor_SMD:R_0402_1005Metric", mpn: null, manufacturer: null },
    { ref: "R2", symbol: "Device:R", value: "10k", footprint: "Resistor_SMD:R_0402_1005Metric", mpn: null, manufacturer: null },
    { ref: "C1", symbol: "Device:C", value: "1uF", footprint: "Capacitor_SMD:C_0402_1005Metric", mpn: null, manufacturer: null },
    { ref: "C2", symbol: "Device:C", value: "100nF", footprint: "Capacitor_SMD:C_0402_1005Metric", mpn: "TC-100N-NAMED", manufacturer: "Test" },
    { ref: "C3", symbol: "Device:C", value: "100nF", footprint: "Capacitor_SMD:C_0402_1005Metric", mpn: null, manufacturer: null },
    { ref: "U2", symbol: "Regulator", value: "3.3V", footprint: "Package_TO_SOT_SMD:SOT-23-5", mpn: "TU-OLD-REG", manufacturer: "Test" },
  ];
  const nets = [{ name: "+5V", pins: ["C1.1", "U2.1"] }, { name: "+3V3", pins: ["C2.1", "C3.1", "R1.1", "U2.5"] }, { name: "GND", pins: ["C1.2", "C2.2", "C3.2"] }];
  const bom = await resolveBom({ components, nets, quantities: [1, 10, 100, 1000] }, [provider]);
  const lookups: Record<string, PartRecord[]> = {};
  for (const r of CATALOG) lookups[normalizeMpn(r.mpn)] = [r];
  return { bom, lookups };
}

const usbLdo = (): PowerTree => ({
  name: "usb_ldo", title: "USB to 3.3 V with an LDO", summary: "test", ambient_c: { nominal: 25, max: 45 },
  sources: [{ id: "VBUS", kind: "usb", label: "USB 5 V", voltage: { min: 4.75, nom: 5, max: 5.25 }, max_current_a: 0.5, battery: null, basis: { kind: "requirement", ref: "REQ-PWR-001" } }],
  converters: [{ id: "U2", label: "3.3 V LDO", kind: "ldo", mpn: "TU-OLD-REG", input: "VBUS", output_rail: "+3V3", vout: 3.3, vin_range: { min: 2.5, max: 6 },
    max_output_a: 0.3, efficiency: null, quiescent_a: 55e-6, dropout_v: 0.25, ron_ohm: null, theta_ja_c_per_w: 250, tj_max_c: 125, enable_after: null,
    soft_start_ms: null, basis: { kind: "datasheet", ref: "TU-OLD-REG" } }],
  rails: [{ id: "+3V3", label: "3.3 V", capacitance_uf: 10 }],
  loads: [{ id: "MCU", label: "Microcontroller", rail: "+3V3", current_a: { run: 0.15, sleep: 0.00005 }, peak_a: 0.2, basis: { kind: "assumption", ref: "test" } },
          { id: "TCXO", label: "Timecode TCXO", rail: "+3V3", current_a: { run: 0.002, sleep: 0 }, peak_a: null, basis: { kind: "assumption", ref: "test" } }],
  modes: [{ id: "run", label: "Running", hours_per_day: 8 }, { id: "sleep", label: "Sleep", hours_per_day: 16 }],
  sequencing: [], assumptions: [], open_questions: [],
});

test("part proposals: cheaper alternate, second source, lifecycle, consolidation; constraints re-checked", async () => {
  const { bom, lookups } = await bomInput();
  const r = optimize({ bom, power: null, requirements: [], lookups });
  const by = (re: RegExp) => r.proposals.filter((p) => re.test(p.title));

  const cost = by(/^Use TR-10K-C for R1, R2/)[0]!;
  assert.equal(cost.objective, "cost");
  assert.equal(cost.change.from, "TR-10K-L");
  const at100 = cost.impact.find((i) => i.metric === "R1, R2 cost per board" && i.at === "100 boards")!;
  assert.equal(at100.before, 0.02); assert.equal(at100.after, 0.004, "2 × 0.002 per board at 100 boards");
  assert.deepEqual(cost.constraints.map((c) => [c.id, c.status]), [["specs", "met"]]);
  assert.match(cost.affects.manufacturability.join(), /no LCSC number/);

  const life = by(/^Replace TU-OLD-REG \(U2\): nrnd/)[0]!;
  assert.equal(life.objective, "lifecycle");
  assert.equal(life.confidence, "low");
  assert.equal(life.change.to, "to be chosen by an engineer");

  const cons = by(/for all 100nF 0402 parts \(C2, C3\)|for all 100nF 0402 parts \(C3, C2\)/)[0]!;
  assert.equal(cons.objective, "consolidation");
  assert.equal(cons.change.to, "TC-100N-GEN", "the cheaper part that meets both lines");
  assert.deepEqual(cons.impact[0], { metric: "unique BOM lines", before: bom.lines.length, after: bom.lines.length - 1, unit: "lines", better: "lower" });

  assert.ok(r.proposals.every((p, i) => p.rank === i + 1 && (i === 0 || r.proposals[i - 1]!.score >= p.score)), "ranked by score");
  assert.deepEqual(optimize({ bom, power: null, requirements: [], lookups }), r, "deterministic");
  assert.equal(new Set(r.proposals.map((p) => p.fingerprint)).size, r.proposals.length, "fingerprints unique");
});

test("hard constraints are never traded: wrong package or a requirement naming the part excludes the proposal", async () => {
  const { bom, lookups } = await bomInput();
  const bad = { ...lookups, [normalizeMpn("TR-10K-C")]: [{ ...lookups[normalizeMpn("TR-10K-C")]![0]!, description: "Resistor 10kΩ 0603 1%", package: "0603" }] };
  const r1 = optimize({ bom, power: null, requirements: [], lookups: bad });
  assert.ok(!r1.proposals.some((p) => p.change.to === "TR-10K-C"));
  assert.match(r1.excluded.find((e) => /TR-10K-C/.test(e.title))!.reason, /package 0402 not stated/);

  const req = [{ ref_code: "REQ-BOM-001", kind: "component", priority: "must", text: "R1 and R2 shall be TR-10K-L (customer-approved)." }];
  const r2 = optimize({ bom, power: null, requirements: req, lookups });
  assert.ok(!r2.proposals.some((p) => /R1, R2/.test(p.subject) && p.change.kind === "swap_part"));
  assert.match(r2.excluded.map((e) => e.reason).join(), /REQ-BOM-001: requirement names the current part/);
});

test("power: LDO → buck with a recomputed before/after; noise-sensitive loads flagged; low-Iq and thermal", () => {
  const tree = usbLdo();
  const r = optimize({ bom: null, power: { tree, report: calculate(tree) }, requirements: [], lookups: {} });
  const sw = r.proposals.find((p) => p.objective === "power")!;
  assert.equal(sw.change.to, "buck (part to be chosen)");
  const run = sw.impact.find((i) => i.metric === "input power from VBUS" && i.at === "Running")!;
  assert.ok((run.after as number) < (run.before as number) * 0.85, `${run.before} → ${run.after}`);
  assert.equal(sw.constraints.find((c) => c.id === "noise")!.status, "needs_review", "TCXO on the rail");
  assert.match(sw.basis.assumptions[0]!, /efficiency 88%/);
  assert.match(sw.affects.standards[0]!, /CISPR 32/);

  const th = r.proposals.find((p) => p.objective === "thermal")!;
  const tj = th.impact[0]!;
  assert.ok((tj.before as number) > 100 && (tj.after as number) < (tj.before as number));
  assert.ok(!r.proposals.some((p) => p.objective === "standby"), "on USB power the quiescent current is negligible per day");
  assert.equal(r.proposals[0]!.objective, "power", "ranked by energy per day: the switcher beats the quiescent tweak");
  assert.ok(sw.impact.some((i) => i.metric === "energy per day (all modes)"));

  // On a battery that runs 6 minutes a day and sleeps the rest, 55 µA of quiescent current against a 50 µA sleep load matters.
  const sleepy: PowerTree = { ...tree, modes: [{ id: "run", label: "Running", hours_per_day: 0.1 }, { id: "sleep", label: "Sleep", hours_per_day: 23.9 }],
    sources: [{ id: "VBUS", kind: "battery", label: "1S", voltage: { min: 3.5, nom: 3.7, max: 4.2 }, max_current_a: 2,
      battery: { chemistry: "li_ion", cells_series: 1, cells_parallel: 1, capacity_mah: 2000, usable_fraction: 0.8 }, basis: { kind: "assumption", ref: "t" } }] };
  const iq = optimize({ bom: null, power: { tree: sleepy, report: calculate(sleepy) }, requirements: [], lookups: {} }).proposals.find((p) => p.objective === "standby")!;
  const days = iq.impact.find((i) => /battery runtime/.test(i.metric))!;
  assert.ok((days.after as number) > (days.before as number) * 1.05, `${days.before} → ${days.after} days`);

  // A battery LDO with little headroom gains nothing from a switcher: no proposal.
  const batt: PowerTree = { ...tree, sources: [{ id: "VBUS", kind: "battery", label: "1S", voltage: { min: 3.5, nom: 3.7, max: 4.2 }, max_current_a: 2,
    battery: { chemistry: "li_ion", cells_series: 1, cells_parallel: 1, capacity_mah: 2000, usable_fraction: 0.8 }, basis: { kind: "assumption", ref: "t" } }] };
  assert.ok(!optimize({ bom: null, power: { tree: batt, report: calculate(batt) }, requirements: [], lookups: {} }).proposals.some((p) => p.objective === "power"));

  // A must-requirement for a linear regulator excludes the switcher.
  const req = [{ ref_code: "REQ-PWR-002", kind: "power", priority: "must", text: "The +3V3 rail shall use a linear regulator (LDO) for the TCXO." }];
  const r2 = optimize({ bom: null, power: { tree, report: calculate(tree) }, requirements: req, lookups: {} } as OptimizeInput);
  assert.ok(!r2.proposals.some((p) => p.objective === "power"));
  assert.match(r2.excluded.map((e) => e.reason).join(), /REQ-PWR-002/);
});
