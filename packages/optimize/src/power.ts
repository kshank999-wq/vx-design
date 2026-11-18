/**
 * Power proposals: each changes a copy of the power tree and re-runs the calculator, so before and after come from
 * the same deterministic model. What the change assumes (a switcher's efficiency, a low-Iq part's quiescent current,
 * a better copper layout's thermal resistance) is stated and lowers the confidence.
 */
import { calculate, type Converter, type PowerReport, type PowerTree } from "@vx/power";
import type { ConstraintCheck, Excluded, Impact, OptimizeInput, OptimizeSettings, Proposal } from "./types.ts";
import { finish } from "./parts.ts";
import { requirementTouches } from "./util.ts";

const r2 = (n: number) => Math.round(n * 100) / 100;
const r4 = (n: number) => Math.round(n * 10000) / 10000;
const NOISE = /\b(noise|low[- ]noise|ripple|analog|audio|adc|dac|rf|radio|oscillator|tcxo|xo|pll|clock|sensor|reference|vref)\b/i;

function compare(before: PowerReport, after: PowerReport, converterId: string): Impact[] {
  const out: Impact[] = [];
  for (const src of before.sources) {
    const a = after.sources.find((x) => x.id === src.id);
    if (!a) continue;
    for (const m of before.modes) {
      const pb = src.powerW[m.id], pa = a.powerW[m.id];
      if (pb !== undefined && pa !== undefined) out.push({ metric: `input power from ${src.id}`, at: m.label, before: r4(pb), after: r4(pa), unit: "W", better: "lower" });
    }
  }
  for (const rt of before.runtime) {
    const a = after.runtime.find((x) => x.source === rt.source);
    if (rt.days !== null && a?.days != null) out.push({ metric: `battery runtime (${rt.source}, mixed use)`, before: r2(rt.days), after: r2(a.days), unit: "days", better: "higher" });
  }
  if (!before.runtime.some((r) => r.days !== null)) {
    const daily = (r: PowerReport) => r.sources.reduce((sum, src) => sum + r.modes.reduce((a, m) => a + (src.powerW[m.id] ?? 0) * m.hoursPerDay, 0), 0);
    out.push({ metric: "energy per day (all modes)", before: r4(daily(before)), after: r4(daily(after)), unit: "Wh", better: "lower" });
  }
  const cb = before.converters.find((c) => c.id === converterId), ca = after.converters.find((c) => c.id === converterId);
  if (cb && ca) {
    out.push({ metric: `${converterId} dissipation (worst case)`, before: r4(cb.pdissMaxW), after: r4(ca.pdissMaxW), unit: "W", better: "lower" });
    if (cb.tjMaxC !== null && ca.tjMaxC !== null) out.push({ metric: `${converterId} junction temperature at max ambient`, before: r2(cb.tjMaxC), after: r2(ca.tjMaxC), unit: "°C", better: "lower" });
  }
  return out;
}

/** Relative gain used for ranking: battery runtime if there is a battery, else energy per day over all modes. */
function gainPct(before: PowerReport, after: PowerReport): number {
  const rb = before.runtime.find((r) => r.days !== null), ra = rb && after.runtime.find((r) => r.source === rb.source);
  if (rb?.days && ra?.days != null) return (100 * (ra.days - rb.days)) / rb.days;
  const daily = (r: PowerReport) => r.sources.reduce((sum, src) => sum + r.modes.reduce((a, m) => a + (src.powerW[m.id] ?? 0) * m.hoursPerDay, 0), 0);
  const eb = daily(before), ea = daily(after);
  return eb ? (100 * (eb - ea)) / eb : 0;
}

function withConverter(tree: PowerTree, id: string, change: Partial<Converter>): PowerTree {
  return { ...tree, converters: tree.converters.map((c) => (c.id === id ? { ...c, ...change } : c)) };
}

function railLoads(tree: PowerTree, rail: string): string[] {
  return tree.loads.filter((l) => l.rail === rail).map((l) => `${l.id} (${l.label})`);
}

function powerConstraints(tree: PowerTree, before: PowerReport, after: PowerReport, c: Converter, reqs: OptimizeInput["requirements"],
                          extra: ConstraintCheck[] = []): ConstraintCheck[] {
  const out: ConstraintCheck[] = [...extra];
  out.push(after.counts.errors > before.counts.errors
    ? { id: "power-calc", status: "violated", detail: `the calculator reports new errors: ${after.findings.filter((f) => f.severity === "error").map((f) => f.message).slice(0, 3).join("; ")}` }
    : { id: "power-calc", status: "met", detail: "no new calculator errors (ratings, inputs, sequencing)" });
  for (const r of requirementTouches(reqs, [c.id, c.output_rail, ...(c.mpn ? [c.mpn] : [])])) {
    const forbids = /\b(linear|ldo)\b/i.test(r.text) && r.priority === "must";
    out.push({ id: r.ref_code, status: forbids ? "violated" : "needs_review", detail: `"${r.text.slice(0, 160)}"` });
  }
  return out;
}

export function powerProposals(input: OptimizeInput, s: OptimizeSettings, excluded: Excluded[]): Proposal[] {
  if (!input.power) return [];
  const { tree } = input.power;
  const before = calculate(tree);
  const out: Proposal[] = [];
  const reqs = input.requirements;
  const affectsLoads = (c: Converter) => railLoads(tree, c.output_rail);

  for (const c of tree.converters) {
    const cr = before.converters.find((x) => x.id === c.id);
    if (!cr) continue;

    // 1. LDO dropping a lot of voltage at real current → switching regulator.
    if (c.kind === "ldo") {
      const maxI = Math.max(0, ...Object.values(cr.ioutA));
      const drop = cr.vin.max - c.vout;
      if (drop >= 0.6 && maxI >= 0.02) {
        const kind = cr.vin.min >= c.vout * 1.1 + 0.3 ? "buck" as const : "buck_boost" as const;
        const changed = withConverter(tree, c.id, { kind, efficiency: s.switcherEfficiency, quiescent_a: s.switcherIqA, dropout_v: null,
          vin_range: c.vin_range, basis: { kind: "assumption", ref: `optimization proposal: generic ${kind} at ${s.switcherEfficiency * 100}% efficiency` } });
        const after = calculate(changed);
        const gain = gainPct(before, after);
        const loads = affectsLoads(c);
        const sensitive = [...loads, ...requirementTouches(reqs, [c.output_rail]).map((r) => r.text)].filter((t) => NOISE.test(t));
        const constraints = powerConstraints(tree, before, after, c, reqs, [
          { id: "input range", status: "met", detail: `${kind} chosen for input ${r2(cr.vin.min)}–${r2(cr.vin.max)} V to ${c.vout} V` },
          sensitive.length ? { id: "noise", status: "needs_review", detail: `noise-sensitive loads or requirements on ${c.output_rail}: ${sensitive.join("; ").slice(0, 200)} (consider a post-LDO or LC filter)` }
            : { id: "noise", status: "met", detail: `no noise-sensitive loads named on ${c.output_rail}` },
        ]);
        const title = `Replace LDO ${c.id} (${c.label}) with a ${kind === "buck" ? "buck" : "buck-boost"} regulator`;
        if (constraints.some((x) => x.status === "violated")) excluded.push({ title, reason: constraints.filter((x) => x.status === "violated").map((x) => `${x.id}: ${x.detail}`).join("; ") });
        else if (gain >= 5) out.push(finish({
          objective: "power", title, subject: c.id,
          change: { kind: "replace_converter", from: `${c.kind}${c.mpn ? ` ${c.mpn}` : ""}`, to: `${kind} (part to be chosen)`, details: { efficiency: s.switcherEfficiency, quiescent_a: s.switcherIqA } },
          impact: compare(before, after, c.id),
          basis: { method: "power calculator re-run on the changed tree (same loads, modes and sources)", inputs: [`power tree ${tree.name}`],
                   assumptions: [`switcher efficiency ${s.switcherEfficiency * 100}% and quiescent ${s.switcherIqA * 1e6} µA (typical for the class; confirm with the chosen part's datasheet)`] },
          confidence: "medium", confidence_reason: "efficiency is assumed until a specific part is chosen", effort: "M",
          cost_note: "Schematic and layout change: inductor, input/output capacitors and a tight switching loop; more BOM cost and board area.",
          affects: { interfaces: [`rail ${c.output_rail}: ${loads.join(", ") || "no loads listed"}`], manufacturability: ["adds an inductor and capacitors"],
                     standards: ["radiated/conducted emissions (e.g. CISPR 32 / EN 55032, FCC Part 15 Subpart B): switching noise must be checked"] },
          constraints, benefit: gain, targets: constraints.filter((x) => /^REQ/.test(x.id)).map((x) => x.id),
        }));
      }
    }

    // 2. Quiescent current that dominates a low-load mode → low-Iq part.
    if (c.quiescent_a > s.lowIqA * 5 && c.kind !== "load_switch") {
      const rail = before.rails.find((r) => r.id === c.output_rail);
      const quiet = [...before.modes].map((m) => ({ m, i: rail?.current[m.id]?.nom ?? 0 })).sort((a, b) => a.i - b.i)[0];
      if (quiet && quiet.i > 0 && c.quiescent_a / quiet.i >= 0.2) {
        const after = calculate(withConverter(tree, c.id, { quiescent_a: s.lowIqA }));
        const gain = gainPct(before, after);
        const constraints = powerConstraints(tree, before, after, c, reqs);
        if (gain >= 2 && !constraints.some((x) => x.status === "violated")) out.push(finish({
          objective: "standby", title: `Use a low-quiescent-current part for ${c.id} (${c.label})`, subject: c.id,
          change: { kind: "lower_iq", from: `${r2(c.quiescent_a * 1e6)} µA`, to: `${r2(s.lowIqA * 1e6)} µA class`, details: { mode: quiet.m.id } },
          impact: compare(before, after, c.id).filter((x) => !/junction|dissipation/.test(x.metric)),
          basis: { method: "power calculator re-run with the lower quiescent current", inputs: [`power tree ${tree.name}`],
                   assumptions: [`replacement quiescent current ${s.lowIqA * 1e6} µA (nano-power class; confirm in the datasheet)`] },
          confidence: "medium", confidence_reason: `in ${quiet.m.label} the converter's own ${r2(c.quiescent_a * 1e6)} µA is ${Math.round((100 * c.quiescent_a) / quiet.i)}% of the rail's load; the replacement value is assumed`,
          effort: "M", cost_note: "Part change; check load-transient response and light-load efficiency of the new part.",
          affects: { interfaces: [`rail ${c.output_rail}`], manufacturability: [], standards: [] }, constraints, benefit: gain,
          targets: constraints.filter((x) => /^REQ/.test(x.id)).map((x) => x.id),
        }));
      }
    }

    // 3. Too hot (or close) at max ambient → better thermal path.
    if (c.theta_ja_c_per_w && cr.tjMaxC !== null && cr.tjMaxC > c.tj_max_c - 25) {
      const theta = r2(c.theta_ja_c_per_w * (1 - s.thetaJaReduction));
      const after = calculate(withConverter(tree, c.id, { theta_ja_c_per_w: theta }));
      const ca = after.converters.find((x) => x.id === c.id)!;
      const constraints = powerConstraints(tree, before, after, c, reqs);
      out.push(finish({
        objective: "thermal", title: `Improve the thermal path of ${c.id} (${c.label}): copper area, thermal vias or an exposed-pad package`, subject: c.id,
        change: { kind: "thermal_relief", from: `θJA ${c.theta_ja_c_per_w} °C/W`, to: `θJA ${theta} °C/W` },
        impact: [{ metric: `${c.id} junction temperature at max ambient`, before: r2(cr.tjMaxC), after: r2(ca.tjMaxC ?? 0), unit: "°C", better: "lower" },
                 { metric: "margin to Tj(max)", before: r2(c.tj_max_c - cr.tjMaxC), after: r2(c.tj_max_c - (ca.tjMaxC ?? 0)), unit: "°C", better: "higher" }],
        basis: { method: "power calculator re-run with a lower junction-to-ambient thermal resistance", inputs: [`power tree ${tree.name}`],
                 assumptions: [`${s.thetaJaReduction * 100}% lower θJA from more copper and thermal vias (layout-dependent; verify with the manufacturer's thermal data or a measurement)`] },
        confidence: "low", confidence_reason: "the improvement in thermal resistance is assumed, not simulated", effort: "S",
        cost_note: "Layout change only (copper pour, vias); a package change needs a footprint change.",
        affects: { interfaces: [], manufacturability: ["thermal vias may need plugging or tenting"], standards: [] }, constraints,
        benefit: Math.max(0, (cr.tjMaxC - (ca.tjMaxC ?? cr.tjMaxC)) / 2) + (cr.tjMaxC > c.tj_max_c ? 30 : 0),
        targets: constraints.filter((x) => /^REQ/.test(x.id)).map((x) => x.id),
      }));
    }
  }
  return out;
}
