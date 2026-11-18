/**
 * Mechanical checks (deterministic, no model): tolerance stacks, gasket compression and groove fill, and a first-order
 * enclosure thermal estimate. Every input carries its basis, and inputs that are assumptions rather than a supplier's
 * or datasheet's figure are marked, so a result that rests on assumptions says so.
 */

// ---------------------------------------------------------------------------
// Tolerance stacks
// ---------------------------------------------------------------------------
export interface Contributor {
  name: string;
  nominal: number;        // mm
  plus: number;           // upper tolerance, mm (≥ 0)
  minus: number;          // lower tolerance, mm (≥ 0)
  sign: 1 | -1;           // +1 adds to the gap, -1 takes from it
  basis?: string;
  assumed?: boolean;
}
export interface StackInput { contributors: Contributor[]; min_gap?: number | null; max_gap?: number | null }
export interface StackResult {
  nominal: number;
  worst: { min: number; max: number };
  rss: { min: number; max: number };   // statistical, each tolerance taken as ±3σ
  verdict: "pass" | "pass_statistical" | "fail" | "no_limit";
  shares: { name: string; pct: number }[];   // share of the variance, largest first
  assumed: string[];
  problems: string[];
}

const r4 = (x: number) => Math.round(x * 10000) / 10000;

export function stackProblems(i: StackInput): string[] {
  const p: string[] = [];
  if (!i.contributors.length) p.push("add at least one contributor");
  i.contributors.forEach((c, n) => {
    const label = c.name || `contributor ${n + 1}`;
    if (!c.name?.trim()) p.push(`contributor ${n + 1} needs a name`);
    for (const k of ["nominal", "plus", "minus"] as const) if (!Number.isFinite(c[k])) p.push(`${label}: ${k} is not a number`);
    if (c.plus < 0 || c.minus < 0) p.push(`${label}: tolerances are given as positive amounts`);
    if (c.sign !== 1 && c.sign !== -1) p.push(`${label}: direction must be + or −`);
  });
  if (i.min_gap != null && i.max_gap != null && i.min_gap > i.max_gap) p.push("the minimum gap is above the maximum");
  return p;
}

export function stack(i: StackInput): StackResult {
  const problems = stackProblems(i);
  const cs = problems.length ? [] : i.contributors;
  let nominal = 0, wMin = 0, wMax = 0, mean = 0, variance = 0;
  const vars: { name: string; v: number }[] = [];
  for (const c of cs) {
    nominal += c.sign * c.nominal;
    // A contributor's own range is [nominal − minus, nominal + plus]; its sign flips which end narrows the gap.
    const lo = c.nominal - c.minus, hi = c.nominal + c.plus;
    wMin += c.sign > 0 ? lo : -hi;
    wMax += c.sign > 0 ? hi : -lo;
    mean += c.sign * (c.nominal + (c.plus - c.minus) / 2);
    const half = (c.plus + c.minus) / 2;
    variance += half * half;
    vars.push({ name: c.name, v: half * half });
  }
  const half = Math.sqrt(variance);
  const worst = { min: r4(wMin), max: r4(wMax) }, rss = { min: r4(mean - half), max: r4(mean + half) };
  const within = (lo: number, hi: number) => (i.min_gap == null || lo >= i.min_gap - 1e-9) && (i.max_gap == null || hi <= i.max_gap + 1e-9);
  const verdict: StackResult["verdict"] = problems.length || (i.min_gap == null && i.max_gap == null) ? "no_limit"
    : within(worst.min, worst.max) ? "pass" : within(rss.min, rss.max) ? "pass_statistical" : "fail";
  return {
    nominal: r4(nominal), worst, rss, verdict,
    shares: vars.map((x) => ({ name: x.name, pct: variance ? Math.round((1000 * x.v) / variance) / 10 : 0 })).sort((a, b) => b.pct - a.pct),
    assumed: cs.filter((c) => c.assumed).map((c) => c.name), problems,
  };
}

// ---------------------------------------------------------------------------
// Gasket compression and groove fill
// ---------------------------------------------------------------------------
export interface GasketPreset { key: string; label: string; kind: "oring" | "foam"; min_pct: number; max_pct: number; max_fill_pct: number | null; basis: string }
/** Typical design-guide ranges; the gasket supplier's data sheet overrides them. */
export const GASKET_PRESETS: GasketPreset[] = [
  { key: "oring_face_static", label: "O-ring, static face seal", kind: "oring", min_pct: 15, max_pct: 30, max_fill_pct: 85,
    basis: "typical design-guide range for static face seals; confirm with the O-ring supplier" },
  { key: "foam_closed_cell", label: "Closed-cell foam strip (silicone, EPDM sponge)", kind: "foam", min_pct: 25, max_pct: 50, max_fill_pct: null,
    basis: "typical range for closed-cell sponge gaskets; confirm with the foam supplier's compression-set data" },
];

export interface GasketInput {
  kind: "oring" | "foam";
  section: { nominal: number; plus: number; minus: number };   // O-ring cross-section, or uncompressed foam thickness
  gap: { nominal: number; plus: number; minus: number };       // groove depth (or the closed gap the gasket sits in)
  groove_width?: { nominal: number; plus: number; minus: number } | null;   // O-ring groove width, for gland fill
  min_pct: number; max_pct: number; max_fill_pct?: number | null;
  basis?: string;
}
export interface GasketResult {
  compression_pct: { min: number; nominal: number; max: number };
  fill_pct: number | null;   // worst case: largest section in the smallest groove
  verdict: "pass" | "fail";
  findings: string[];
}
const pct1 = (x: number) => Math.round(x * 1000) / 10;

export function gasket(i: GasketInput): GasketResult {
  const d = i.section, h = i.gap;
  const comp = (dd: number, hh: number) => (dd - hh) / dd;
  const min = pct1(comp(d.nominal - d.minus, h.nominal + h.plus));
  const max = pct1(comp(d.nominal + d.plus, h.nominal - h.minus));
  const nominal = pct1(comp(d.nominal, h.nominal));
  const findings: string[] = [];
  if (min < i.min_pct) findings.push(`compression can fall to ${min}% (thinnest gasket in the deepest gap), below the ${i.min_pct}% minimum: it may not seal`);
  if (max > i.max_pct) findings.push(`compression can reach ${max}% (thickest gasket in the shallowest gap), above the ${i.max_pct}% maximum: overstress or lid will not close`);
  let fill: number | null = null;
  if (i.kind === "oring" && i.groove_width) {
    const dmax = d.nominal + d.plus;
    fill = pct1((Math.PI * dmax * dmax / 4) / ((h.nominal - h.minus) * (i.groove_width.nominal - i.groove_width.minus)));
    if (i.max_fill_pct != null && fill > i.max_fill_pct) findings.push(`groove fill reaches ${fill}%, above ${i.max_fill_pct}%: widen or deepen the groove`);
  } else if (i.kind === "oring") findings.push("groove width not given, so gland fill is not checked");
  const hard = findings.filter((f) => !f.startsWith("groove width not given"));
  return { compression_pct: { min, nominal, max }, fill_pct: fill, verdict: hard.length ? "fail" : "pass", findings };
}

// ---------------------------------------------------------------------------
// Enclosure thermal estimate
// ---------------------------------------------------------------------------
export interface HeatSource { name: string; watts: number; theta_ja?: number | null; tj_max?: number | null; basis?: string }
export interface ThermalInput {
  /** Total heat released inside the box, W (all electrical input power except what leaves as light, sound or through cables). */
  power_w: number;
  /** Outer box size in mm; the whole outer surface is counted. */
  box_mm: { x: number; y: number; z: number };
  /** Combined convection and radiation coefficient, W/m²·K. */
  h_w_m2k: number;
  ambient_max_c: number;
  sources: HeatSource[];
  /** Hottest internal air temperature allowed (e.g. a battery's charge limit), °C. */
  air_limit_c?: number | null;
  basis?: string;
}
export interface ThermalResult {
  area_m2: number;
  air_rise_c: number;
  air_c: number;
  sources: { name: string; tj_c: number | null; margin_c: number | null; ok: boolean | null }[];
  verdict: "pass" | "fail";
  findings: string[];
}
export const DEFAULT_H_W_M2K = 5;
export const H_BASIS = "rule of thumb for a sealed plastic box in still air (natural convection plus radiation); replace with a measurement when one exists";

export function thermal(i: ThermalInput): ThermalResult {
  const { x, y, z } = i.box_mm;
  const area = 2 * (x * y + y * z + x * z) / 1e6;
  const rise = area > 0 && i.h_w_m2k > 0 ? i.power_w / (i.h_w_m2k * area) : Infinity;
  const air = i.ambient_max_c + rise;
  const findings: string[] = [];
  const sources = i.sources.map((s) => {
    if (s.theta_ja == null) return { name: s.name, tj_c: null, margin_c: null, ok: null };
    const tj = Math.round((air + s.watts * s.theta_ja) * 10) / 10;
    const margin = s.tj_max == null ? null : Math.round((s.tj_max - tj) * 10) / 10;
    const ok = margin == null ? null : margin >= 0;
    if (ok === false) findings.push(`${s.name} reaches ${tj} °C inside the box, over its ${s.tj_max} °C limit`);
    else if (margin != null && margin < 10) findings.push(`${s.name} reaches ${tj} °C inside the box, within 10 °C of its ${s.tj_max} °C limit`);
    return { name: s.name, tj_c: tj, margin_c: margin, ok };
  });
  if (i.air_limit_c != null && air > i.air_limit_c) findings.push(`internal air reaches ${Math.round(air * 10) / 10} °C, above the ${i.air_limit_c} °C limit`);
  const failed = sources.some((s) => s.ok === false) || (i.air_limit_c != null && air > i.air_limit_c);
  return { area_m2: Math.round(area * 10000) / 10000, air_rise_c: Math.round(rise * 10) / 10, air_c: Math.round(air * 10) / 10, sources,
           verdict: failed ? "fail" : "pass", findings };
}

// ---------------------------------------------------------------------------
// Starting points from the committed enclosure fit report
// ---------------------------------------------------------------------------
export interface FitReportFacts {
  process?: { name: string; label?: string };
  dimensions_mm?: { x: number; y: number; z: number };
  board?: { thickness_mm: number };
  spec?: { edge_gap_mm?: number; top_clearance_mm?: number; standoff_height_mm?: number; wall_mm?: number;
           openings?: { ref: string; kind: string; margin_mm?: number }[] };
  levels_mm?: { board_top: number; lid_inner: number };
}
/** The process tolerance and where it came from: a supplier's process rules, or an assumption to replace. */
export interface ProcessTolerance { tolerance_mm: number; basis: string; assumed: boolean }

export interface StackTemplate { title: string; note: string; input: StackInput }

/**
 * Starting stacks for an enclosure: board to wall, components to lid, connector to its opening. Board tolerances
 * (outline ±0.1 mm, thickness ±10%) are typical PCB-fab figures, marked as assumptions; the enclosure tolerance
 * comes from a supplier's process rules when there are any.
 */
export function enclosureStacks(f: FitReportFacts, proc: ProcessTolerance): StackTemplate[] {
  const out: StackTemplate[] = [];
  const t = f.board?.thickness_mm ?? 1.6;
  const tp = { plus: proc.tolerance_mm, minus: proc.tolerance_mm, basis: proc.basis, assumed: proc.assumed };
  const outline = { plus: 0.1, minus: 0.1, basis: "typical PCB routing tolerance; confirm with the board fab", assumed: true };
  const gap = f.spec?.edge_gap_mm;
  if (gap != null) out.push({ title: "Board edge to enclosure wall", note: "Per side: the cavity is board + 2 × gap; the board can sit off-centre by the mounting-hole clearance.",
    input: { min_gap: 0, max_gap: null, contributors: [
      { name: "Designed gap (per side)", nominal: gap, plus: 0, minus: 0, sign: 1, basis: "enclosure spec" },
      { name: "Cavity width (half, per side)", nominal: 0, ...tp, sign: 1 },
      { name: "Board outline (half, per side)", nominal: 0, ...outline, sign: -1 },
      { name: "Board shift on its screws", nominal: 0, plus: 0.2, minus: 0.2, sign: -1, basis: "mounting-hole clearance around the screw (assumed 0.2 mm); set from the hole and screw sizes", assumed: true },
    ] } });
  const top = f.spec?.top_clearance_mm, stand = f.spec?.standoff_height_mm;
  if (top != null && stand != null) out.push({ title: "Tallest component to lid", note: "Lid inner surface minus standoff height, board thickness and the tallest part.",
    input: { min_gap: 0.2, max_gap: null, contributors: [
      { name: "Designed clearance", nominal: top, plus: 0, minus: 0, sign: 1, basis: "enclosure spec" },
      { name: "Lid inner height (base + lid parts)", nominal: 0, ...tp, sign: 1 },
      { name: "Standoff height", nominal: 0, ...tp, sign: -1 },
      { name: "Board thickness", nominal: 0, plus: Math.round(t * 0.1 * 100) / 100, minus: Math.round(t * 0.1 * 100) / 100, sign: -1,
        basis: "typical ±10% PCB thickness tolerance; confirm with the board fab", assumed: true },
      { name: "Tallest component height", nominal: 0, plus: 0.1, minus: 0.1, sign: -1, basis: "datasheet height tolerance (assumed ±0.1 mm); set from the part's drawing", assumed: true },
    ] } });
  for (const o of (f.spec?.openings ?? []).filter((x) => x.kind === "edge")) {
    out.push({ title: `${o.ref} opening alignment`, note: "Opening margin around the connector body, against where the board and opening can end up.",
      input: { min_gap: 0, max_gap: null, contributors: [
        { name: "Opening margin (per side)", nominal: o.margin_mm ?? 0.5, plus: 0, minus: 0, sign: 1, basis: "enclosure spec" },
        { name: "Opening position", nominal: 0, ...tp, sign: -1 },
        { name: "Board shift on its screws", nominal: 0, plus: 0.2, minus: 0.2, sign: -1, basis: "mounting-hole clearance (assumed 0.2 mm)", assumed: true },
        { name: `${o.ref} placement on the board`, nominal: 0, plus: 0.1, minus: 0.1, sign: -1, basis: "typical assembly placement and footprint tolerance (assumed)", assumed: true },
      ] } });
  }
  return out;
}

export interface PowerFacts {
  ambientC?: { max: number };
  sources?: { powerW: Record<string, number> }[];
  converters?: { label: string; pdissMaxW: number; tjMaxC: number | null }[];
}
/** Thermal inputs from the power budget and fit report: the heaviest mode's input power, converters with their θJA. */
export function thermalFromReports(power: PowerFacts, fit: FitReportFacts): ThermalInput | null {
  if (!fit.dimensions_mm || !power.sources?.length) return null;
  const modes = new Set(power.sources.flatMap((s) => Object.keys(s.powerW)));
  const total = Math.max(0, ...[...modes].map((m) => power.sources!.reduce((sum, s) => sum + (s.powerW[m] ?? 0), 0)));
  const ta = power.ambientC?.max ?? 40;
  return {
    power_w: Math.round(total * 1000) / 1000, box_mm: fit.dimensions_mm, h_w_m2k: DEFAULT_H_W_M2K, ambient_max_c: ta, air_limit_c: null,
    basis: `heaviest operating mode of the power budget; ${H_BASIS}`,
    sources: (power.converters ?? []).filter((c) => c.pdissMaxW > 0).map((c) => ({
      name: c.label, watts: c.pdissMaxW,
      // The budget computed Tj at the outside ambient; θJA is recovered from it.
      theta_ja: c.tjMaxC != null && c.pdissMaxW > 0 ? Math.round(((c.tjMaxC - ta) / c.pdissMaxW) * 10) / 10 : null,
      tj_max: 125, basis: "dissipation from the power budget; Tj limit assumed 125 °C unless the datasheet says otherwise",
    })),
  };
}
