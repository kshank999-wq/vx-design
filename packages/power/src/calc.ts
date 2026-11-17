/**
 * Deterministic power budget: rail currents, converter losses and junction temperatures, source and
 * battery limits, runtime, inrush and sequencing. No model is involved; every number in the report
 * follows from the tree and the formulas below.
 *
 *   voltages: top-down from the sources, at the minimum, nominal and maximum source voltage ("corners")
 *   currents: bottom-up from the loads, per operating mode and corner
 *   LDO        Iin = Iout + Iq                    Pdiss = (Vin - Vout) * Iout + Vin * Iq
 *   load switch Iin = Iout + Iq                   Pdiss = Iout^2 * Ron + Vin * Iq
 *   switcher   Pin = Vout * Iout / eta + Vin * Iq  Iin = Pin / Vin   Pdiss = Pin - Vout * Iout
 *   junction   Tj = Ta(max) + Pdiss(max steady) * theta_JA
 *   battery    E = V(nom) * capacity * parallel cells * usable fraction; runtime = E / P(mode)
 */
import { CELL_VOLTAGES, type Converter, type PowerTree } from "./schema.ts";

export const POWER_CALC_VERSION = "power-calc-v1";
export const DERATE_CURRENT = 0.8;      // warn above 80% of a rated current
export const TJ_MARGIN_C = 25;          // warn within 25 C of Tj(max)
export const DEFAULT_EFFICIENCY = 0.85; // used, with a warning, when a switcher has none

export type Corner = "min" | "nom" | "max";
const CORNERS: Corner[] = ["min", "nom", "max"];
type ByCorner = Record<Corner, number>;

export interface Finding { severity: "error" | "warning" | "info"; code: string; subject: string; message: string }

export interface RailResult {
  id: string; label: string; fedBy: string; voltage: ByCorner;
  current: Record<string, ByCorner>;   // per mode
  peakA: number;
  loads: string[]; converters: string[];
}
export interface ConverterResult {
  id: string; label: string; kind: Converter["kind"]; input: string; output: string;
  vin: { min: number; max: number }; vout: ByCorner;
  ioutA: Record<string, number>; ioutPeakA: number; utilization: number;
  iinA: Record<string, ByCorner>;
  pdissW: Record<string, ByCorner>; pdissMaxW: number;
  tjMaxC: number | null; inrushA: number | null; efficiencyUsed: number | null;
}
export interface SourceResult {
  id: string; label: string; kind: string; voltage: ByCorner; maxCurrentA: number | null;
  currentA: Record<string, ByCorner>; peakA: number; powerW: Record<string, number>;
}
export interface Runtime {
  source: string; energyWh: number;
  perMode: { mode: string; powerW: number; hours: number | null }[];
  dailyEnergyWh: number | null; days: number | null;
}
export interface PowerReport {
  version: string; name: string; title: string;
  ok: boolean; ambientC: { nominal: number; max: number };
  modes: { id: string; label: string; hoursPerDay: number }[];
  sources: SourceResult[]; converters: ConverterResult[]; rails: RailResult[];
  loads: { id: string; label: string; rail: string; currentA: Record<string, number>; peakA: number | null; basis: string }[];
  efficiency: Record<string, number | null>;
  runtime: Runtime[];
  findings: Finding[];
  counts: { errors: number; warnings: number; infos: number };
  basis: Record<string, number>;
}

const r3 = (n: number) => Math.round(n * 1e6) / 1e6;
const fmtA = (a: number) => a >= 1 ? `${r3(a)} A` : `${Math.round(a * 1e5) / 100} mA`;

/** Structural problems (unknown references, duplicate producers, cycles). The calculation needs none. */
export function structuralFindings(t: PowerTree): Finding[] {
  const f: Finding[] = [];
  const err = (code: string, subject: string, message: string) => f.push({ severity: "error", code, subject, message });
  const ids = [...t.sources.map((s) => s.id), ...t.converters.map((c) => c.output_rail)];
  const sourceIds = new Set(t.sources.map((s) => s.id));
  for (const id of new Set(ids)) {
    const producers = [...t.sources.filter((s) => s.id === id).map((s) => s.label), ...t.converters.filter((c) => c.output_rail === id).map((c) => c.id)];
    if (producers.length > 1) {
      err("rail_multiple_producers", id, `rail ${id} is produced by ${producers.join(" and ")}; combining supplies needs an explicit ` +
          "power-path (ideal diode or power mux) modelled as one converter");
    }
  }
  const rails = new Set(ids);
  for (const c of t.converters) {
    if (!rails.has(c.input)) err("unknown_input", c.id, `${c.id} takes input from ${c.input}, which is neither a source nor a converter output (known: ${[...rails].join(", ")})`);
    if (c.input === c.output_rail) err("self_feed", c.id, `${c.id} feeds its own output`);
    if (c.enable_after && !rails.has(c.enable_after)) err("unknown_rail", c.id, `${c.id} is enabled after ${c.enable_after}, which does not exist`);
  }
  for (const r of t.rails) if (!rails.has(r.id)) err("orphan_rail", r.id, `rail ${r.id} is declared but nothing produces it`);
  const modes = new Set(t.modes.map((m) => m.id));
  if (!modes.size) err("no_modes", "modes", "at least one operating mode is needed");
  for (const l of t.loads) {
    if (!rails.has(l.rail)) err("unknown_rail", l.id, `load ${l.id} draws from ${l.rail}, which is not a rail (known: ${[...rails].join(", ")})`);
    for (const m of Object.keys(l.current_a)) if (!modes.has(m)) err("unknown_mode", l.id, `load ${l.id} gives a current for mode ${m}, which is not defined`);
    for (const m of modes) if (!(m in l.current_a)) f.push({ severity: "warning", code: "mode_missing", subject: l.id, message: `load ${l.id} has no current for mode ${m}; counted as 0 A` });
    if (Object.values(l.current_a).some((a) => a < 0) || (l.peak_a ?? 0) < 0) err("negative_current", l.id, `load ${l.id} has a negative current`);
  }
  for (const s of t.sequencing) for (const r of [s.before, s.after]) if (!rails.has(r)) err("unknown_rail", `${s.before}->${s.after}`, `sequencing names ${r}, which is not a rail`);
  // Cycles: follow inputs upward.
  const producerOf = new Map(t.converters.map((c) => [c.output_rail, c]));
  for (const c of t.converters) {
    const seen = new Set<string>();
    let cur: string | undefined = c.input;
    while (cur && producerOf.has(cur) && !sourceIds.has(cur)) {
      if (seen.has(cur)) { err("cycle", c.id, `converters form a loop through ${[...seen].join(" -> ")}`); break; }
      seen.add(cur);
      cur = producerOf.get(cur)!.input;
    }
  }
  return f;
}

export function calculate(t: PowerTree): PowerReport {
  const findings = structuralFindings(t);
  const add = (severity: Finding["severity"], code: string, subject: string, message: string) => findings.push({ severity, code, subject, message });
  const modes = t.modes.map((m) => m.id);
  const errorsBefore = findings.some((x) => x.severity === "error");
  const empty: PowerReport = {
    version: POWER_CALC_VERSION, name: t.name, title: t.title, ok: false, ambientC: t.ambient_c,
    modes: t.modes.map((m) => ({ id: m.id, label: m.label, hoursPerDay: m.hours_per_day })),
    sources: [], converters: [], rails: [], loads: [], efficiency: {}, runtime: [], findings,
    counts: { errors: 0, warnings: 0, infos: 0 }, basis: {},
  };
  if (errorsBefore) return finish(empty, t);

  // 1. Voltages, top-down.
  const voltage = new Map<string, ByCorner>();
  for (const s of t.sources) voltage.set(s.id, { ...s.voltage });
  const order: Converter[] = [];
  const pending = [...t.converters];
  while (pending.length) {
    const i = pending.findIndex((c) => voltage.has(c.input));
    if (i < 0) break;
    const c = pending.splice(i, 1)[0]!;
    const vin = voltage.get(c.input)!;
    voltage.set(c.output_rail, c.kind === "load_switch" ? { ...vin } : { min: c.vout, nom: c.vout, max: c.vout });
    order.push(c);
  }

  // 2. Currents, bottom-up, per mode and corner (plus a worst-case "peak" pseudo-mode).
  const loadsOn = (rail: string) => t.loads.filter((l) => l.rail === rail);
  const peakOf = (l: PowerTree["loads"][number]) => Math.max(l.peak_a ?? 0, ...modes.map((m) => l.current_a[m] ?? 0));
  const efficiency = (c: Converter) => {
    if (c.kind === "ldo" || c.kind === "load_switch") return null;
    return c.efficiency && c.efficiency > 0 && c.efficiency <= 1 ? c.efficiency : DEFAULT_EFFICIENCY;
  };
  const scenarios = [...modes, "__peak"];
  const demand = new Map<string, Record<string, ByCorner>>();          // rail -> scenario -> corner -> A
  const iin = new Map<string, Record<string, ByCorner>>();             // converter -> scenario -> corner
  const pdiss = new Map<string, Record<string, ByCorner>>();
  const railDemand = (rail: string, sc: string, corner: Corner): number => {
    const loads = loadsOn(rail).reduce((s, l) => s + (sc === "__peak" ? peakOf(l) : l.current_a[sc] ?? 0), 0);
    const downstream = order.filter((c) => c.input === rail).reduce((s, c) => s + iin.get(c.id)![sc]![corner], 0);
    return loads + downstream;
  };
  for (const c of [...order].reverse()) {
    const ins: Record<string, ByCorner> = {};
    const ps: Record<string, ByCorner> = {};
    for (const sc of scenarios) {
      ins[sc] = { min: 0, nom: 0, max: 0 };
      ps[sc] = { min: 0, nom: 0, max: 0 };
      for (const k of CORNERS) {
        const iout = railDemand(c.output_rail, sc, k);
        const vin = voltage.get(c.input)![k];
        const vout = voltage.get(c.output_rail)![k];
        const eta = efficiency(c);
        let i: number, p: number;
        if (c.kind === "ldo") { i = iout + c.quiescent_a; p = Math.max(0, vin - vout) * iout + vin * c.quiescent_a; }
        else if (c.kind === "load_switch") { i = iout + c.quiescent_a; p = iout * iout * (c.ron_ohm ?? 0) + vin * c.quiescent_a; }
        else { const pin = (vout * iout) / eta! + vin * c.quiescent_a; i = vin > 0 ? pin / vin : 0; p = pin - vout * iout; }
        ins[sc]![k] = i;
        ps[sc]![k] = p;
      }
    }
    iin.set(c.id, ins);
    pdiss.set(c.id, ps);
  }
  for (const rail of voltage.keys()) {
    const rec: Record<string, ByCorner> = {};
    for (const sc of scenarios) rec[sc] = { min: railDemand(rail, sc, "min"), nom: railDemand(rail, sc, "nom"), max: railDemand(rail, sc, "max") };
    demand.set(rail, rec);
  }
  const maxOf = (b: ByCorner) => Math.max(b.min, b.nom, b.max);
  const steadyMax = (rec: Record<string, ByCorner>) => Math.max(0, ...modes.map((m) => maxOf(rec[m]!)));

  // 3. Converter checks.
  const converters: ConverterResult[] = order.map((c) => {
    const vin = voltage.get(c.input)!;
    const out = demand.get(c.output_rail)!;
    const ioutA = Object.fromEntries(modes.map((m) => [m, r3(maxOf(out[m]!))]));
    const ioutPeak = maxOf(out.__peak!);
    const steadyOut = Math.max(0, ...Object.values(ioutA));
    const p = pdiss.get(c.id)!;
    const pMax = steadyMax(p);
    const tj = c.theta_ja_c_per_w != null ? t.ambient_c.max + pMax * c.theta_ja_c_per_w : null;
    const s = c.id;

    if (ioutPeak > c.max_output_a) add("error", "converter_overcurrent", s, `${s} must supply ${fmtA(ioutPeak)} at peak; rated ${fmtA(c.max_output_a)}`);
    else if (steadyOut > DERATE_CURRENT * c.max_output_a) {
      add("warning", "converter_near_limit", s, `${s} runs at ${Math.round((steadyOut / c.max_output_a) * 100)}% of its ${fmtA(c.max_output_a)} rating (above ${DERATE_CURRENT * 100}%)`);
    }
    if (c.vin_range && (vin.min < c.vin_range.min || vin.max > c.vin_range.max)) {
      add("error", "vin_out_of_range", s, `${s} sees ${vin.min}-${vin.max} V on ${c.input}; rated input ${c.vin_range.min}-${c.vin_range.max} V`);
    }
    if (c.kind === "ldo") {
      if (vin.min < c.vout) add("error", "ldo_input_below_output", s, `${s} cannot make ${c.vout} V from ${vin.min} V (${c.input} minimum)`);
      else if (c.dropout_v == null) add("warning", "ldo_dropout_unknown", s, `${s} has no dropout voltage; headroom at ${vin.min} V is ${r3(vin.min - c.vout)} V`);
      else if (vin.min - c.vout < c.dropout_v) {
        add("error", "ldo_dropout", s, `${s} needs ${c.dropout_v} V headroom (dropout) but has ${r3(vin.min - c.vout)} V at ${c.input} minimum ${vin.min} V`);
      }
    }
    if (c.kind === "buck") {
      if (vin.min <= c.vout) add("error", "buck_no_headroom", s, `${s} is a buck (step-down) but its input falls to ${vin.min} V, at or below ${c.vout} V out; use a buck-boost or raise the input`);
      else if (vin.min < c.vout * 1.1) add("warning", "buck_low_headroom", s, `${s} has under 10% headroom at ${vin.min} V in; check its maximum duty cycle`);
    }
    if (c.kind === "boost" && vin.max >= c.vout) {
      add("error", "boost_input_above_output", s, `${s} is a boost (step-up) but its input reaches ${vin.max} V, at or above ${c.vout} V out; it cannot regulate down`);
    }
    if ((c.kind === "buck" || c.kind === "boost" || c.kind === "buck_boost") && !(c.efficiency && c.efficiency > 0 && c.efficiency <= 1)) {
      add("warning", "efficiency_assumed", s, `${s} has no efficiency; ${DEFAULT_EFFICIENCY * 100}% assumed`);
    }
    if (tj === null) {
      add(pMax > 0.05 ? "warning" : "info", "no_thermal_data", s,
          `${s} dissipates up to ${r3(pMax)} W but has no theta-JA, so its temperature is not checked`);
    }
    else if (tj > c.tj_max_c) add("error", "overtemperature", s, `${s} reaches ${Math.round(tj)} C junction (${r3(pMax)} W x ${c.theta_ja_c_per_w} C/W at ${t.ambient_c.max} C ambient); limit ${c.tj_max_c} C`);
    else if (tj > c.tj_max_c - TJ_MARGIN_C) add("warning", "thermal_margin", s, `${s} reaches ${Math.round(tj)} C junction, within ${TJ_MARGIN_C} C of its ${c.tj_max_c} C limit`);

    let inrush: number | null = null;
    const railCap = t.rails.find((r) => r.id === c.output_rail)?.capacitance_uf;
    if (railCap && c.soft_start_ms) {
      inrush = (railCap * 1e-6 * voltage.get(c.output_rail)!.max) / (c.soft_start_ms * 1e-3);
      if (inrush + steadyOut > c.max_output_a) {
        add("warning", "inrush", s, `${s} start-up: ${fmtA(inrush)} to charge ${railCap} uF in ${c.soft_start_ms} ms on top of ${fmtA(steadyOut)} exceeds its ${fmtA(c.max_output_a)} rating`);
      }
    }
    return {
      id: c.id, label: c.label, kind: c.kind, input: c.input, output: c.output_rail, vin: { min: vin.min, max: vin.max },
      vout: voltage.get(c.output_rail)!, ioutA, ioutPeakA: r3(ioutPeak), utilization: r3(Math.max(ioutPeak, steadyOut) / c.max_output_a),
      iinA: Object.fromEntries(modes.map((m) => [m, roundCorner(iin.get(c.id)![m]!)])),
      pdissW: Object.fromEntries(modes.map((m) => [m, roundCorner(p[m]!)])), pdissMaxW: r3(pMax),
      tjMaxC: tj === null ? null : Math.round(tj * 10) / 10, inrushA: inrush === null ? null : r3(inrush), efficiencyUsed: efficiency(c),
    };
  });

  // 4. Sources.
  const sources: SourceResult[] = t.sources.map((src) => {
    const d = demand.get(src.id)!;
    const steady = steadyMax(d);
    const peak = maxOf(d.__peak!);
    if (src.max_current_a == null) add("info", "source_limit_unknown", src.id, `${src.label} has no current limit, so it is not checked`);
    else if (peak > src.max_current_a) add("error", "source_overcurrent", src.id, `${src.label} must deliver ${fmtA(peak)} at peak; limit ${fmtA(src.max_current_a)}`);
    else if (steady > DERATE_CURRENT * src.max_current_a) {
      add("warning", "source_near_limit", src.id, `${src.label} runs at ${Math.round((steady / src.max_current_a) * 100)}% of its ${fmtA(src.max_current_a)} limit`);
    }
    if (src.battery) {
      const cell = CELL_VOLTAGES[src.battery.chemistry];
      const n = src.battery.cells_series;
      if (cell.nom > 0 && (Math.abs(src.voltage.min - cell.min * n) > 0.1 * cell.min * n || Math.abs(src.voltage.max - cell.max * n) > 0.1 * cell.max * n)) {
        add("warning", "battery_voltage_unusual", src.id, `${src.label}: ${src.voltage.min}-${src.voltage.max} V differs from a typical ${n}S ` +
            `${src.battery.chemistry} pack (${r3(cell.min * n)}-${r3(cell.max * n)} V)`);
      }
    }
    return {
      id: src.id, label: src.label, kind: src.kind, voltage: src.voltage, maxCurrentA: src.max_current_a,
      currentA: Object.fromEntries(modes.map((m) => [m, roundCorner(d[m]!)])), peakA: r3(peak),
      powerW: Object.fromEntries(modes.map((m) => [m, r3(src.voltage.nom * d[m]!.nom)])),
    };
  });

  // 5. Sequencing: the later rail must be enabled by the earlier one, or be derived from it.
  const producer = new Map(order.map((c) => [c.output_rail, c]));
  const ancestors = (rail: string): Set<string> => {
    const out = new Set<string>();
    let cur = producer.get(rail);
    while (cur) { out.add(cur.input); cur = producer.get(cur.input); }
    return out;
  };
  for (const s of t.sequencing) {
    const conv = producer.get(s.after);
    const ok = conv && (conv.enable_after === s.before || ancestors(s.after).has(s.before));
    if (!ok) add("warning", "sequencing_unenforced", `${s.before}->${s.after}`,
                 `${s.before} must be up before ${s.after} (${s.reason}), but nothing enforces it: enable ${conv?.id ?? s.after} from ${s.before}'s power-good`);
  }
  for (const [rail] of voltage) {
    if (!loadsOn(rail).length && !order.some((c) => c.input === rail)) add("info", "unused_rail", rail, `${rail} has no loads`);
  }

  // 6. Efficiency and runtime.
  const loadPower = (m: string) => t.loads.reduce((s, l) => s + (l.current_a[m] ?? 0) * (voltage.get(l.rail)?.nom ?? 0), 0);
  const sourcePower = (m: string) => sources.reduce((s, src) => s + src.powerW[m]!, 0);
  const eff = Object.fromEntries(modes.map((m) => [m, sourcePower(m) > 0 ? r3(loadPower(m) / sourcePower(m)) : null]));
  const runtime: Runtime[] = t.sources.filter((s) => s.battery).map((s) => {
    const b = s.battery!;
    const energy = (s.voltage.nom * b.capacity_mah * b.cells_parallel / 1000) * b.usable_fraction;
    const sr = sources.find((x) => x.id === s.id)!;
    const perMode = t.modes.map((m) => ({ mode: m.id, powerW: sr.powerW[m.id]!, hours: sr.powerW[m.id]! > 0 ? Math.round((energy / sr.powerW[m.id]!) * 10) / 10 : null }));
    const daily = t.modes.reduce((acc, m) => acc + sr.powerW[m.id]! * m.hours_per_day, 0);
    return { source: s.id, energyWh: r3(energy), perMode, dailyEnergyWh: daily > 0 ? r3(daily) : null,
             days: daily > 0 ? Math.round((energy / daily) * 10) / 10 : null };
  });

  const rails: RailResult[] = [...voltage.keys()].map((id) => ({
    id, label: t.rails.find((r) => r.id === id)?.label ?? t.sources.find((s) => s.id === id)?.label ?? id,
    fedBy: producer.get(id)?.id ?? id, voltage: voltage.get(id)!,
    current: Object.fromEntries(modes.map((m) => [m, roundCorner(demand.get(id)![m]!)])), peakA: r3(maxOf(demand.get(id)!.__peak!)),
    loads: loadsOn(id).map((l) => l.id), converters: order.filter((c) => c.input === id).map((c) => c.id),
  }));
  return finish({
    ...empty, sources, converters, rails, efficiency: eff, runtime,
    loads: t.loads.map((l) => ({ id: l.id, label: l.label, rail: l.rail, currentA: l.current_a, peakA: l.peak_a, basis: `${l.basis.kind}: ${l.basis.ref}` })),
  }, t);
}

function roundCorner(b: ByCorner): ByCorner { return { min: r3(b.min), nom: r3(b.nom), max: r3(b.max) }; }

function finish(r: PowerReport, t: PowerTree): PowerReport {
  const basis: Record<string, number> = {};
  for (const x of [...t.sources, ...t.converters, ...t.loads]) basis[x.basis.kind] = (basis[x.basis.kind] ?? 0) + 1;
  const counts = {
    errors: r.findings.filter((f) => f.severity === "error").length,
    warnings: r.findings.filter((f) => f.severity === "warning").length,
    infos: r.findings.filter((f) => f.severity === "info").length,
  };
  return { ...r, findings: r.findings, counts, basis, ok: counts.errors === 0 };
}
