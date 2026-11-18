/**
 * Trade studies (S2): compare options against weighted criteria and rank them. Deterministic: numeric criteria are
 * normalised across the options (best = 1, worst = 0), ratings (1–5) map to 0–1, and "must" criteria rule an option
 * out when not met. Every value carries its basis (where the number came from). A sensitivity check reports whether
 * the winner changes when any one weight is halved or doubled, so a close call is visible as such.
 */

export type CriterionKind = "lower" | "higher" | "rating" | "must";
export interface Criterion { key: string; label: string; kind: CriterionKind; weight: number; unit?: string; requirement_ref?: string }
export interface TradeOption { key: string; name: string; description?: string; mpn?: string; manufacturer?: string }
export interface Score { value: number | boolean | null; basis?: string; source?: "manual" | "catalog"; observed_at?: string }
export type Scores = Record<string, Record<string, Score>>;   // option key -> criterion key -> score

export interface RankedOption {
  key: string; name: string; total: number | null; excluded: string[]; missing: string[];
  parts: Record<string, number | null>;   // criterion key -> normalised 0..1 contribution before weighting
}
export interface TradeResult {
  ranking: RankedOption[];
  winner: string | null;
  robust: boolean;
  /** Weight changes (halving or doubling one criterion) that change the winner. */
  sensitive_to: { criterion: string; change: "halved" | "doubled"; winner: string }[];
  complete: boolean;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function score(criteria: Criterion[], options: TradeOption[], scores: Scores): RankedOption[] {
  const ranked = options.map((o) => ({ key: o.key, name: o.name, total: 0 as number | null, excluded: [] as string[], missing: [] as string[],
                                       parts: {} as Record<string, number | null> }));
  for (const c of criteria) {
    const vals = options.map((o) => scores[o.key]?.[c.key]?.value ?? null);
    if (c.kind === "must") {
      vals.forEach((v, i) => {
        if (v === false) ranked[i]!.excluded.push(c.label);
        else if (v !== true) ranked[i]!.missing.push(c.label);
      });
      continue;
    }
    const nums = vals.filter(isNum);
    const lo = Math.min(...nums), hi = Math.max(...nums);
    vals.forEach((v, i) => {
      if (!isNum(v)) { ranked[i]!.missing.push(c.label); ranked[i]!.parts[c.key] = null; return; }
      let p: number;
      if (c.kind === "rating") p = Math.min(1, Math.max(0, (v - 1) / 4));
      else if (hi === lo) p = 1;
      else p = c.kind === "lower" ? (hi - v) / (hi - lo) : (v - lo) / (hi - lo);
      ranked[i]!.parts[c.key] = Math.round(p * 1000) / 1000;
    });
  }
  return ranked;
}

function totals(criteria: Criterion[], ranked: RankedOption[], weights: Record<string, number>): RankedOption[] {
  const weighted = criteria.filter((c) => c.kind !== "must" && (weights[c.key] ?? 0) > 0);
  const sum = weighted.reduce((s, c) => s + weights[c.key]!, 0);
  return ranked.map((r) => ({
    ...r,
    total: r.excluded.length || !sum ? null
      : Math.round((100 * weighted.reduce((s, c) => s + (r.parts[c.key] ?? 0) * weights[c.key]!, 0)) / sum * 10) / 10,
  })).sort((a, b) => (b.total ?? -1) - (a.total ?? -1) || a.name.localeCompare(b.name));
}

export function rankOptions(criteria: Criterion[], options: TradeOption[], scores: Scores): TradeResult {
  const base = score(criteria, options, scores);
  const weights = Object.fromEntries(criteria.map((c) => [c.key, Math.max(0, c.weight)]));
  const ranking = totals(criteria, base, weights);
  const winner = ranking[0]?.total != null ? ranking[0].key : null;
  const sensitive_to: TradeResult["sensitive_to"] = [];
  if (winner) {
    for (const c of criteria.filter((x) => x.kind !== "must" && x.weight > 0)) {
      for (const [change, factor] of [["halved", 0.5], ["doubled", 2]] as const) {
        const w = totals(criteria, base, { ...weights, [c.key]: weights[c.key]! * factor });
        if (w[0]?.total != null && w[0].key !== winner && w[0].total > (w.find((x) => x.key === winner)?.total ?? -1)) {
          sensitive_to.push({ criterion: c.label, change, winner: w[0].name });
        }
      }
    }
  }
  return { ranking, winner, robust: !!winner && sensitive_to.length === 0, sensitive_to,
           complete: ranking.every((r) => r.missing.length === 0) };
}

/** Starting criteria for common studies. Weights 0–10. */
export const TRADE_TEMPLATES: Record<string, { label: string; criteria: Criterion[]; options: TradeOption[] }> = {
  module_vs_custom: {
    label: "Module vs custom design",
    criteria: [
      { key: "meets_requirements", label: "Meets the requirements", kind: "must", weight: 0 },
      { key: "unit_cost", label: "Unit cost at the target quantity", kind: "lower", weight: 8, unit: "USD" },
      { key: "nre", label: "Up-front cost (NRE, certification)", kind: "lower", weight: 6, unit: "USD" },
      { key: "time_to_prototype", label: "Time to a working prototype", kind: "lower", weight: 6, unit: "weeks" },
      { key: "certification_effort", label: "Certification effort (5 = least)", kind: "rating", weight: 5 },
      { key: "board_area", label: "Board area", kind: "lower", weight: 3, unit: "mm²" },
      { key: "supply_risk", label: "Supply security (5 = safest)", kind: "rating", weight: 5 },
    ],
    options: [{ key: "module", name: "Pre-certified module" }, { key: "custom", name: "Custom design (chip-down)" }],
  },
  component_choice: {
    label: "Component choice",
    criteria: [
      { key: "meets_requirements", label: "Meets the requirements", kind: "must", weight: 0 },
      { key: "unit_cost", label: "Unit cost at the target quantity", kind: "lower", weight: 7, unit: "USD" },
      { key: "availability", label: "Stock across distributors", kind: "higher", weight: 5, unit: "pcs" },
      { key: "lifecycle", label: "Lifecycle (5 = active, 1 = obsolete)", kind: "rating", weight: 6 },
      { key: "performance", label: "Key performance figure", kind: "higher", weight: 6 },
      { key: "second_source", label: "Second source (5 = drop-in available)", kind: "rating", weight: 4 },
    ],
    options: [],
  },
  blank: { label: "Blank (define your own)", criteria: [], options: [] },
};

/** Lifecycle wording from the parts catalog as a 1–5 rating. */
export const LIFECYCLE_RATING: Record<string, number> = { active: 5, nrnd: 2, last_time_buy: 1, obsolete: 1, unknown: 3 };
