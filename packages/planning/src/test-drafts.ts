/**
 * Draft test procedures from requirements (S6). Deterministic: a limit is drafted only from a number written in the
 * requirement or its acceptance criteria ("between 3.2 V and 3.4 V", "at least 8 h", "≤ 50 mA"), and cites that text.
 * When nothing can be read, the draft has a yes/no check instead of an invented limit. Drafts are reviewed and
 * approved by a person before anything is measured against them.
 */
export type TestStage = "incoming_inspection" | "bring_up" | "functional" | "firmware" | "fit_finish" | "environmental" | "other";
export interface MeasurementDraft {
  key: string; label: string; kind: "numeric" | "boolean" | "text"; unit?: string; min?: number; max?: number; expected?: string;
  requirement_ref: string; basis: string;
}
export interface ProcedureDraft { title: string; stage: TestStage; requirement_refs: string[]; steps: string; measurements: MeasurementDraft[] }
export interface RequirementForDraft { ref_code: string; kind: string; text: string; acceptance_criteria?: string | null }

const UNIT = String.raw`(mV|V|µA|uA|mA|A|mW|W|kHz|MHz|GHz|Hz|fps|°C|degC|C|ms|s|min|minutes|h|hours|mm|cm|g|kg|dB|%)`;
const NUM = String.raw`(-?\d+(?:\.\d+)?)`;
const CANON: Record<string, string> = { uA: "µA", degC: "°C", C: "°C", minutes: "min", hours: "h" };
const canon = (u: string) => CANON[u] ?? u;

interface Limit { min?: number; max?: number; unit: string; text: string }

export function readLimits(text: string): Limit[] {
  const out: Limit[] = [];
  const t = text.replace(/≤/g, "<=").replace(/≥/g, ">=");
  const take = (re: RegExp, f: (m: RegExpExecArray) => Limit | null) => {
    for (const m of t.matchAll(new RegExp(re.source, "gi"))) { const l = f(m as RegExpExecArray); if (l) out.push(l); }
  };
  take(new RegExp(String.raw`between\s+${NUM}\s*${UNIT}?\s+and\s+${NUM}\s*${UNIT}`), (m) =>
    ({ min: Number(m[1]), max: Number(m[3]), unit: canon(m[4]!), text: m[0] }));
  take(new RegExp(String.raw`${NUM}\s*(?:±|\+/-)\s*${NUM}\s*${UNIT}`), (m) =>
    ({ min: Number(m[1]) - Number(m[2]), max: Number(m[1]) + Number(m[2]), unit: canon(m[3]!), text: m[0] }));
  take(new RegExp(String.raw`(?:at least|no less than|minimum of|not less than|>=|more than|over)\s*${NUM}\s*${UNIT}`), (m) =>
    ({ min: Number(m[1]), unit: canon(m[2]!), text: m[0] }));
  take(new RegExp(String.raw`(?:at most|no more than|maximum of|not more than|<=|less than|under|below|within)\s*${NUM}\s*${UNIT}`), (m) =>
    ({ max: Number(m[1]), unit: canon(m[2]!), text: m[0] }));
  // Drop a one-sided limit already covered by a range on the same unit.
  return out.filter((l, i) => !(l.min === undefined || l.max === undefined) ||
    !out.some((o, j) => j !== i && o.unit === l.unit && o.min !== undefined && o.max !== undefined));
}

const STAGE: Record<string, TestStage> = {
  power: "bring_up", electrical: "bring_up", interface: "functional", functional: "functional", performance: "functional",
  mechanical: "fit_finish", enclosure: "fit_finish", environmental: "environmental", thermal: "environmental",
  firmware: "firmware", software: "firmware", manufacturing: "incoming_inspection",
};

export function draftProcedures(reqs: RequirementForDraft[], covered: Set<string>): ProcedureDraft[] {
  return reqs.filter((r) => !covered.has(r.ref_code)).map((r) => {
    const slug = r.ref_code.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
    const source = [r.text, r.acceptance_criteria].filter(Boolean).join(" ");
    const limits = readLimits(source);
    const measurements: MeasurementDraft[] = limits.length
      ? limits.map((l, i) => ({ key: `${slug}_${i + 1}`, label: `${r.ref_code}: ${l.text.trim()}`, kind: "numeric", unit: l.unit,
                                ...(l.min !== undefined ? { min: l.min } : {}), ...(l.max !== undefined ? { max: l.max } : {}),
                                requirement_ref: r.ref_code, basis: `read from ${r.ref_code}: "${l.text.trim()}"` }))
      : [{ key: `${slug}_met`, label: `${r.ref_code} met`, kind: "boolean", expected: "yes", requirement_ref: r.ref_code,
           basis: `no measurable limit in ${r.ref_code}: a yes/no check; add a measured value if one applies` }];
    return {
      title: r.text.length > 90 ? `${r.text.slice(0, 87).trimEnd()}…` : r.text,
      stage: STAGE[r.kind] ?? "functional", requirement_refs: [r.ref_code],
      steps: [`Verify ${r.ref_code}: ${r.text}`, r.acceptance_criteria ? `Acceptance criteria (from the specification): ${r.acceptance_criteria}` : null,
              "Record the conditions (temperature, supply, firmware, equipment and calibration dates) with the result."].filter(Boolean).join("\n"),
      measurements,
    };
  });
}
