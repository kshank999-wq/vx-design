/**
 * Requirements read by two models from the same specification, matched one to one: the same source block and
 * overlapping wording (the excerpt one contains the other's, or most words shared). What one model found and the
 * other did not is listed, and so are differences in kind and priority between matched requirements.
 */
export interface CompareReq { statement: string; kind: string; priority: string; blockId: string; excerpt: string; ambiguity: string | null }

const words = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9.%°±µ]+/g, " ").split(" ").filter((w) => w.length > 1));
const overlap = (a: string, b: string) => {
  const x = words(a), y = words(b);
  if (!x.size || !y.size) return 0;
  const inter = [...x].filter((w) => y.has(w)).length;
  return inter / Math.min(x.size, y.size);
};
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

function score(a: CompareReq, b: CompareReq): number {
  if (a.blockId !== b.blockId) return 0;
  const ea = norm(a.excerpt), eb = norm(b.excerpt);
  const contained = ea && eb && (ea.includes(eb) || eb.includes(ea)) ? 0.5 : 0;
  return contained + overlap(a.statement, b.statement) * 0.5 + overlap(a.excerpt, b.excerpt) * 0.5;
}

export interface Comparison {
  matched: { base: CompareReq; other: CompareReq; kindDiffers: boolean; priorityDiffers: boolean }[];
  onlyBase: CompareReq[];
  onlyOther: CompareReq[];
  /** Share of the baseline's requirements the other model also found. */
  recall: number;
}

export function compareRequirements(base: CompareReq[], other: CompareReq[]): Comparison {
  const pairs: { i: number; j: number; s: number }[] = [];
  base.forEach((a, i) => other.forEach((b, j) => { const s = score(a, b); if (s >= 0.55) pairs.push({ i, j, s }); }));
  pairs.sort((p, q) => q.s - p.s);
  const usedA = new Set<number>(), usedB = new Set<number>();
  const matched: Comparison["matched"] = [];
  for (const p of pairs) {
    if (usedA.has(p.i) || usedB.has(p.j)) continue;
    usedA.add(p.i); usedB.add(p.j);
    const a = base[p.i]!, b = other[p.j]!;
    matched.push({ base: a, other: b, kindDiffers: a.kind !== b.kind, priorityDiffers: a.priority !== b.priority });
  }
  return {
    matched,
    onlyBase: base.filter((_, i) => !usedA.has(i)),
    onlyOther: other.filter((_, j) => !usedB.has(j)),
    recall: base.length ? matched.length / base.length : 1,
  };
}
