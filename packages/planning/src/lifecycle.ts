/**
 * S8 lifecycle: deterministic risk for each BOM part from catalog facts (lifecycle, notices, distributor offers),
 * price history from offer observations, and what changed between two revisions (files and BOM). No model: the same
 * records give the same answer, and every rating lists its reasons.
 */

export type Risk = "high" | "medium" | "low" | "none";
export interface NoticeFact { kind: string; title: string; issued_on?: string | null; effective_on?: string | null; last_order_on?: string | null; recorded_at: string }
export interface OfferFact { seller: string; stock: number | null; currency: string | null; prices: { quantity: number; unit_price: number }[]; observed_at: string; data_status?: string }
export interface PartFacts { lifecycle: string; notices: NoticeFact[]; offers: OfferFact[]; need: number }
export interface PartRisk { risk: Risk; reasons: string[]; days_to_last_order: number | null; stock: number | null; sellers_in_stock: number }

const RANK: Record<Risk, number> = { none: 0, low: 1, medium: 2, high: 3 };
const DAY = 86400e3;
const days = (a: string, b: Date) => Math.ceil((Date.parse(a) - b.getTime()) / DAY);

/** The latest observation from each seller. */
export function latestOffers(offers: OfferFact[]): OfferFact[] {
  const by = new Map<string, OfferFact>();
  for (const o of offers) {
    const prev = by.get(o.seller);
    if (!prev || o.observed_at > prev.observed_at) by.set(o.seller, o);
  }
  return [...by.values()];
}

/** Unit price at a quantity: the largest price break not above it, or the smallest break when it is below them all. */
export function unitPriceAt(prices: { quantity: number; unit_price: number }[], qty: number): number | null {
  const sorted = [...prices].filter((p) => Number.isFinite(p.unit_price) && p.unit_price > 0).sort((a, b) => a.quantity - b.quantity);
  if (!sorted.length) return null;
  let pick = sorted[0]!;
  for (const p of sorted) if (p.quantity <= qty) pick = p;
  return pick.unit_price;
}

export function assessPart(f: PartFacts, now = new Date()): PartRisk {
  let risk: Risk = "none";
  const reasons: string[] = [];
  const raise = (r: Risk, why: string) => { if (RANK[r] > RANK[risk]) risk = r; reasons.push(why); };
  const eol = f.notices.filter((n) => (n.kind === "eol" || n.kind === "last_time_buy") && n.last_order_on)
    .sort((a, b) => (a.last_order_on! < b.last_order_on! ? -1 : 1))[0];
  const left = eol ? days(eol.last_order_on!, now) : null;

  if (f.lifecycle === "obsolete") raise("high", "obsolete");
  else if (f.lifecycle === "last_time_buy") raise("high", left == null ? "last-time buy" : left < 0 ? `last-time buy closed ${-left} days ago` : `last-time buy closes in ${left} days`);
  else if (f.lifecycle === "nrnd") raise("medium", "not recommended for new designs");
  else if (f.lifecycle === "unknown") raise("low", "lifecycle unknown");
  if (eol && f.lifecycle !== "last_time_buy" && f.lifecycle !== "obsolete") raise("high", `end-of-life notice: last order ${eol.last_order_on}`);
  for (const n of f.notices.filter((x) => x.kind === "pcn" && Date.parse(x.issued_on ?? x.recorded_at) > now.getTime() - 180 * DAY)) {
    raise("medium", `change notice to review: ${n.title}${n.effective_on ? ` (effective ${n.effective_on})` : ""}`);
  }
  if (f.notices.some((n) => n.kind === "counterfeit_alert")) raise("medium", "counterfeit alert: buy from authorised distributors only");

  const latest = latestOffers(f.offers);
  const inStock = latest.filter((o) => (o.stock ?? 0) > 0);
  const stock = latest.length ? latest.reduce((s, o) => s + (o.stock ?? 0), 0) : null;
  if (!latest.length) raise("low", "no distributor data");
  else if ((stock ?? 0) === 0) raise("high", "no distributor stock");
  else {
    if ((stock ?? 0) < f.need) raise("medium", `distributor stock ${stock} is below the ${f.need} needed`);
    if (inStock.length === 1) raise("low", `stocked by one distributor only (${inStock[0]!.seller})`);
  }
  const h = priceHistory(f.offers, Math.max(1, f.need));
  if (h.change_pct != null && h.change_pct >= 25) raise("low", `price up ${h.change_pct}% since ${h.points[0]!.date}`);
  return { risk, reasons, days_to_last_order: left, stock, sellers_in_stock: inStock.length };
}

export interface PricePoint { date: string; unit_price: number; seller: string; currency: string }
/** Best unit price at the quantity on each day offers were observed, and the change from the first day to the last. */
export function priceHistory(offers: OfferFact[], qty: number): { points: PricePoint[]; change_pct: number | null } {
  const byDay = new Map<string, PricePoint>();
  for (const o of offers) {
    const p = unitPriceAt(o.prices, qty);
    if (p == null) continue;
    const date = o.observed_at.slice(0, 10);
    const cur = byDay.get(date);
    if (!cur || p < cur.unit_price) byDay.set(date, { date, unit_price: p, seller: o.seller, currency: o.currency ?? "USD" });
  }
  const points = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
  const first = points[0], last = points[points.length - 1];
  return { points, change_pct: points.length > 1 && first!.currency === last!.currency
    ? Math.round(((last!.unit_price - first!.unit_price) / first!.unit_price) * 1000) / 10 : null };
}

export interface ManifestEntry { artifact: string; kind: string; version: number; sha256: string }
export interface ManifestDiff { added: ManifestEntry[]; removed: ManifestEntry[]; changed: { artifact: string; from: number; to: number }[]; unchanged: number }
export function diffManifests(a: ManifestEntry[], b: ManifestEntry[]): ManifestDiff {
  const A = new Map(a.map((x) => [x.artifact, x])), B = new Map(b.map((x) => [x.artifact, x]));
  const out: ManifestDiff = { added: [], removed: [], changed: [], unchanged: 0 };
  for (const x of b) {
    const old = A.get(x.artifact);
    if (!old) out.added.push(x);
    else if (old.sha256 !== x.sha256) out.changed.push({ artifact: x.artifact, from: old.version, to: x.version });
    else out.unchanged++;
  }
  for (const x of a) if (!B.has(x.artifact)) out.removed.push(x);
  return out;
}

export interface BomLineFact { refs: string[]; mpn: string | null; manufacturer?: string | null }
export interface BomChange { kind: "added" | "removed" | "changed"; refs: string[]; from: string | null; to: string | null }
/** BOM changes by reference designator, grouped by what each set of references changed from and to. */
export function diffBoms(a: BomLineFact[], b: BomLineFact[]): BomChange[] {
  const map = (lines: BomLineFact[]) => {
    const m = new Map<string, string | null>();
    for (const l of lines) for (const r of l.refs) m.set(r, l.mpn ? `${l.mpn}${l.manufacturer ? ` (${l.manufacturer})` : ""}` : null);
    return m;
  };
  const A = map(a), B = map(b);
  const groups = new Map<string, BomChange>();
  const add = (kind: BomChange["kind"], ref: string, from: string | null, to: string | null) => {
    const key = `${kind}|${from}|${to}`;
    const g = groups.get(key) ?? { kind, refs: [], from, to };
    g.refs.push(ref); groups.set(key, g);
  };
  for (const [ref, to] of B) {
    if (!A.has(ref)) add("added", ref, null, to);
    else if (A.get(ref) !== to) add("changed", ref, A.get(ref)!, to);
  }
  for (const [ref, from] of A) if (!B.has(ref)) add("removed", ref, from, null);
  const natural = (x: string, y: string) => x.localeCompare(y, undefined, { numeric: true });
  return [...groups.values()].map((g) => ({ ...g, refs: g.refs.sort(natural) }))
    .sort((x, y) => x.kind.localeCompare(y.kind) || natural(x.refs[0]!, y.refs[0]!));
}
