/**
 * BOM resolution: turns a circuit's components into sourced lines with offers from every configured
 * distributor, prices at production quantities, LCSC numbers for JLCPCB assembly and risk flags.
 *
 * Parts with an MPN are looked up by part number on every configured provider (primary first) and the
 * identity is checked. Generic passives (no MPN) are chosen by rules from keyword results: same value,
 * same package, adequate voltage rating, preferring parts with an LCSC offer, then stock, then price.
 * Rule-chosen parts are labelled as such: they are proposals for review, not verified selections.
 */
import { matchIdentity, normalizeManufacturer, normalizeMpn, packageFromFootprint, parseValue, sameValue, valuesInText,
         type IdentityMatch } from "./normalize.ts";
import { ProviderError, type DataStatus, type Lifecycle, type Offer, type PartRecord, type ProviderAttempt, type ProviderId, type SourcingProvider } from "./types.ts";

export const BOM_RESOLVER_VERSION = "bom-v1";
export const DEFAULT_QUANTITIES = [1, 10, 100, 1000];

export interface BomComponent {
  ref: string;
  symbol: string;
  value: string;
  footprint: string;
  mpn: string | null;
  manufacturer: string | null;
  purpose?: string | null;
}

export interface BomInput {
  components: BomComponent[];
  nets: { name: string; pins: string[] }[];
  quantities?: number[];
  currency?: string;
}

export type PartClass = "capacitor" | "resistor" | "led" | "connector" | "other";

export interface Flag { code: string; severity: "error" | "warning" | "info"; message: string }

export interface SelectedPart {
  mpn: string;
  manufacturer: string;
  description: string | null;
  lifecycle: Lifecycle;
  datasheetUrl: string | null;
  productUrl: string | null;
  identity: IdentityMatch | "rule_selected";
  providers: ProviderId[];
  cad: { has3dModel: boolean; downloadUrl: string | null; source: string } | null;
}

export interface PricePoint {
  boards: number;
  need: number;
  choice: { provider: ProviderId; seller: string; sku: string | null; unitPrice: number; buyQty: number; extended: number;
            stock: number | null } | null;
  note: string | null;
}

export interface ResolvedLine {
  key: string;
  refs: string[];
  quantityPerBoard: number;
  class: PartClass;
  wanted: { mpn: string | null; manufacturer: string | null; value: string; footprint: string; package: string | null;
            requirements: string[] };
  selected: SelectedPart | null;
  lcsc: string | null;
  offers: Offer[];
  pricing: PricePoint[];
  alternates: { mpn: string; manufacturer: string; description: string | null; lcsc: string | null; stock: number | null }[];
  flags: Flag[];
  attempts: ProviderAttempt[];
}

export interface BomResolution {
  version: string;
  generatedAt: string;
  currency: string;
  quantities: number[];
  dataStatus: DataStatus | "mixed" | "none";
  providers: { id: ProviderId; label: string; role: string; configured: boolean; terms: string }[];
  lines: ResolvedLine[];
  totals: { boards: number; perBoard: number | null; total: number | null; missingLines: string[] }[];
  counts: { lines: number; sourced: number; unsourced: number; errors: number; warnings: number; withLcsc: number };
}

export function classify(c: BomComponent): PartClass {
  const lib = c.symbol.split(":").pop() ?? "";
  if (/^C(_|$|_Small|_Polarized)/.test(lib) || /^CP/.test(lib) || (/^C\d/.test(c.ref) && /Capacitor/.test(c.footprint))) return "capacitor";
  if (/^R(_|$|_Small)/.test(lib) || (/^R\d/.test(c.ref) && /Resistor/.test(c.footprint))) return "resistor";
  if (/^LED/.test(lib)) return "led";
  if (/^Conn|Connector/.test(c.symbol) || /^J\d/.test(c.ref)) return "connector";
  return "other";
}

/** Rail voltage implied by a net name (+3V3 -> 3.3, +5V -> 5, 12V -> 12), else null. */
export function netVoltage(name: string): number | null {
  const m = /^\+?(\d+)V(\d*)$/i.exec(name.replace(/^\//, ""));
  return m ? Number(`${m[1]}.${m[2] || "0"}`) : null;
}

const CAP_RATINGS = [6.3, 10, 16, 25, 35, 50, 100];

function requiredCapVoltage(c: BomComponent, nets: BomInput["nets"]): { min: number; note: string } {
  const volts = nets.filter((n) => n.pins.some((p) => p.split(".")[0] === c.ref)).map((n) => netVoltage(n.name))
    .filter((v): v is number => v !== null);
  if (!volts.length) return { min: 16, note: "rail voltage unknown from net names: required 16 V or more" };
  const need = Math.max(...volts) * 2;
  const rating = CAP_RATINGS.find((r) => r >= need) ?? 100;
  return { min: rating, note: `on a ${Math.max(...volts)} V rail: rated ${rating} V or more (2x derating)` };
}

function keywordQuery(c: BomComponent, cls: PartClass, pkg: string | null, minV: number | null): string {
  if (cls === "capacitor") return `capacitor ceramic ${c.value} ${pkg ?? ""} ${minV ? `${minV}V` : ""} X7R X5R`.replace(/\s+/g, " ").trim();
  if (cls === "resistor") return `resistor ${c.value} ${pkg ?? ""} 1%`.replace(/\s+/g, " ").trim();
  if (cls === "led") return `LED ${c.value} ${pkg ?? ""}`.replace(/\s+/g, " ").trim();
  const header = /PinHeader_(\d)x(\d+)_P([\d.]+)mm_(Vertical|Horizontal)/.exec(c.footprint);
  if (header) return `pin header ${header[1]}x${Number(header[2])} ${header[3]}mm ${header[4]!.toLowerCase()} through hole`;
  return `${c.value} ${pkg ?? ""}`.trim();
}

/** Does a keyword candidate meet the line's value/package/voltage needs? Returns reasons it fails. */
export function candidateProblems(p: PartRecord, cls: PartClass, c: BomComponent, pkg: string | null, minV: number | null): string[] {
  const text = `${p.description ?? ""} ${Object.entries(p.specs).map(([k, v]) => `${k} ${v}`).join(" ")} ${p.package ?? ""}`;
  const found = valuesInText(text);
  const out: string[] = [];
  if (pkg && !new RegExp(`\\b${pkg}\\b`).test(text)) out.push(`package ${pkg} not stated`);
  if (cls === "capacitor") {
    const want = parseValue(c.value, "F");
    if (want === null || !found.farads.some((f) => sameValue(f, want))) out.push(`capacitance ${c.value} not stated`);
    if (minV !== null && !found.volts.some((v) => v >= minV)) out.push(`no voltage rating of ${minV} V or more stated`);
  } else if (cls === "resistor") {
    const want = parseValue(c.value, "Ω");
    if (want === null || !found.ohms.some((o) => sameValue(o, want))) out.push(`resistance ${c.value} not stated`);
  } else if (cls === "led") {
    if (!new RegExp(c.value, "i").test(text)) out.push(`colour ${c.value} not stated`);
  } else if (cls === "connector") {
    const header = /PinHeader_(\d)x(\d+)_P([\d.]+)mm/.exec(c.footprint);
    if (header && !text.includes(header[3]!)) out.push(`pitch ${header[3]} mm not stated`);
    if (header && !new RegExp(`\\b(${Number(header[2])}|${header[2]})\\b`).test(text)) out.push(`${Number(header[2])} positions not stated`);
  }
  return out;
}

function lcscOf(offers: Offer[]): string | null {
  const o = offers.find((x) => /lcsc/i.test(x.seller) && x.sku && /^C\d+$/.test(x.sku));
  return o?.sku ?? null;
}

function mergeOffers(records: PartRecord[]): Offer[] {
  const seen = new Set<string>();
  const out: Offer[] = [];
  for (const r of records) for (const o of r.offers) {
    const k = `${o.provider}|${o.seller}|${o.sku}`;
    if (!seen.has(k)) { seen.add(k); out.push(o); }
  }
  return out;
}

/** Cheapest purchase that covers `need` from one offer (honouring MOQ, multiples and price breaks). */
export function priceFor(offer: Offer, need: number): { unitPrice: number; buyQty: number; extended: number } | null {
  if (!offer.prices.length) return null;
  const breaks = [...offer.prices].sort((a, b) => a.quantity - b.quantity);
  let buy = Math.max(need, offer.moq ?? 1, breaks[0]!.quantity);
  const mult = offer.multiple && offer.multiple > 1 ? offer.multiple : 1;
  buy = Math.ceil(buy / mult) * mult;
  // Buying up to the next break can be cheaper overall; check each break at or above `buy`.
  let best: { unitPrice: number; buyQty: number; extended: number } | null = null;
  for (const qty of [buy, ...breaks.map((b) => Math.ceil(b.quantity / mult) * mult).filter((q) => q > buy)]) {
    const unit = [...breaks].reverse().find((b) => b.quantity <= qty)?.unitPrice;
    if (unit === undefined) continue;
    const ext = Math.round(unit * qty * 1e6) / 1e6;
    if (!best || ext < best.extended) best = { unitPrice: unit, buyQty: qty, extended: ext };
  }
  return best;
}

/** Best single-offer purchase per board quantity (stock permitting), as the sourced BOM prices a line. */
export function pricing(offers: Offer[], perBoard: number, quantities: number[], currency: string): PricePoint[] {
  const usable = offers.filter((o) => o.currency === currency && o.prices.length);
  return quantities.map((boards) => {
    const need = perBoard * boards;
    let choice: PricePoint["choice"] = null;
    for (const o of usable) {
      if (o.stock !== null && o.stock < need) continue;
      const p = priceFor(o, need);
      if (p && (!choice || p.extended < choice.extended)) {
        choice = { provider: o.provider, seller: o.seller, sku: o.sku, stock: o.stock, ...p };
      }
    }
    const note = choice ? (choice.buyQty > need ? `buy ${choice.buyQty} (MOQ, multiple or price break) for ${need} needed` : null)
      : usable.length ? `no single ${currency} offer has ${need} in stock` : `no ${currency} offers`;
    return { boards, need, choice, note };
  });
}

/**
 * A provider that refuses us outright (bad key, plan limit used up, an anti-bot page) gives the same answer for every
 * line: after the first such refusal it is skipped for the rest of the list, with the reason, instead of being asked
 * again for each part.
 */
let refusals = new Map<SourcingProvider, string>();   // reset for each parts list

/** The provider's error in plain words where we recognise it. */
export function plainProviderError(message: string): string {
  if (/<!DOCTYPE|<html|Just a moment|cf-chl|challenge/i.test(message)) return message.replace(/HTTP (\d+):[\s\S]*/, "HTTP $1: blocked by the provider's anti-bot firewall (a browser check page instead of the API answer)");
  return message;
}
function isRefusal(e: unknown): boolean {
  const m = (e as Error).message ?? "";
  return (e instanceof ProviderError && e.kind === "auth") || /exceeded your part limit|upgrade your plan|invalid unique identifier|api key/i.test(m);
}

async function attempt<T>(p: SourcingProvider, fn: () => Promise<T[]>): Promise<{ attempt: ProviderAttempt; results: T[] }> {
  if (!p.configured()) return { attempt: { provider: p.id, outcome: "not_configured", results: 0, ms: 0 }, results: [] };
  const refused = refusals.get(p);
  if (refused) return { attempt: { provider: p.id, outcome: "error", results: 0, ms: 0, error: `skipped: ${refused}` }, results: [] };
  const t0 = Date.now();
  try {
    const results = await fn();
    return { attempt: { provider: p.id, outcome: results.length ? "ok" : "no_match", results: results.length, ms: Date.now() - t0 }, results };
  } catch (e) {
    const error = plainProviderError((e as Error).message).slice(0, 300);
    if (isRefusal(e)) refusals.set(p, error);
    return { attempt: { provider: p.id, outcome: "error", results: 0, ms: Date.now() - t0, error }, results: [] };
  }
}

/** Providers billed per part looked up: asked only when the free ones found nothing for a line. */
const PAID = new Set<string>(["nexar"]);

const RANK = { primary: 0, fallback_a: 1, fallback_b: 2, fixture: 3 } as const;

export async function resolveBom(input: BomInput, providers: SourcingProvider[]): Promise<BomResolution> {
  refusals = new Map();
  const quantities = input.quantities ?? DEFAULT_QUANTITIES;
  const currency = input.currency ?? "USD";
  const ordered = [...providers].sort((a, b) => RANK[a.role] - RANK[b.role]);

  // Group identical parts into lines.
  const groups = new Map<string, BomComponent[]>();
  for (const c of input.components) {
    const key = c.mpn ? `mpn:${normalizeMpn(c.mpn)}|${normalizeManufacturer(c.manufacturer)}`
                      : `generic:${classify(c)}|${c.value}|${c.footprint}`;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }

  const lines: ResolvedLine[] = [];
  for (const [key, comps] of groups) {
    const c = comps[0]!;
    const cls = classify(c);
    const pkg = packageFromFootprint(c.footprint);
    const flags: Flag[] = [];
    const attempts: ProviderAttempt[] = [];
    const requirements: string[] = [];
    let selected: SelectedPart | null = null;
    let records: PartRecord[] = [];
    let alternates: ResolvedLine["alternates"] = [];

    if (c.mpn) {
      const found: { rec: PartRecord; id: IdentityMatch }[] = [];
      for (const p of ordered) {
        if (PAID.has(p.id) && found.length) continue;   // the free distributors already found it
        const r = await attempt(p, () => p.searchMpn(c.mpn!, c.manufacturer));
        attempts.push(r.attempt);
        for (const rec of r.results) {
          const id = matchIdentity({ mpn: c.mpn, manufacturer: c.manufacturer }, rec);
          if (id !== "different") found.push({ rec, id });
        }
      }
      found.sort((a, b) => (a.id === "exact" ? 0 : 1) - (b.id === "exact" ? 0 : 1));
      if (found.length) {
        const first = found[0]!;
        records = found.filter((f) => normalizeMpn(f.rec.mpn) === normalizeMpn(first.rec.mpn)).map((f) => f.rec);
        const lifecycles = [...new Set(records.map((r) => r.lifecycle).filter((l) => l !== "unknown"))];
        selected = {
          mpn: first.rec.mpn, manufacturer: first.rec.manufacturer, description: records.find((r) => r.description)?.description ?? null,
          lifecycle: lifecycles[0] ?? "unknown", datasheetUrl: records.find((r) => r.datasheetUrl)?.datasheetUrl ?? null,
          productUrl: first.rec.productUrl, identity: first.id, providers: [...new Set(records.map((r) => r.provider))],
          cad: records.find((r) => r.cad?.has3dModel)?.cad ?? null,
        };
        if (first.id === "packaging_variant") {
          flags.push({ code: "packaging_variant", severity: "info",
                       message: `found as ${first.rec.mpn} (ordering/packaging variant of ${c.mpn})` });
        }
        if (lifecycles.length > 1) {
          flags.push({ code: "lifecycle_disagreement", severity: "warning",
                       message: `providers disagree on lifecycle: ${records.map((r) => `${r.provider} ${r.lifecycleRaw ?? r.lifecycle}`).join(", ")}` });
        }
        const mfrs = [...new Set(records.map((r) => normalizeManufacturer(r.manufacturer)))];
        if (mfrs.length > 1) flags.push({ code: "manufacturer_disagreement", severity: "warning", message: `manufacturer written as ${mfrs.join(" / ")}` });
      }
    } else {
      let minV: number | null = null;
      if (cls === "capacitor") {
        // Every part on the line must meet the strictest requirement (C1 on 5 V and C2 on 3.3 V -> the 5 V rating).
        const v = comps.map((x) => requiredCapVoltage(x, input.nets)).sort((a, b) => b.min - a.min)[0]!;
        minV = v.min;
        requirements.push(`${c.value}, ${pkg ?? "footprint package"}, ${v.note}, X5R/X7R dielectric preferred`);
      } else if (cls === "resistor") requirements.push(`${c.value}, ${pkg ?? "footprint package"}, 1% preferred`);
      else if (cls === "led") requirements.push(`${c.value} LED, ${pkg ?? "footprint package"}`);
      else requirements.push(`matches footprint ${c.footprint}`);
      const query = keywordQuery(c, cls, pkg, minV);
      const pool: PartRecord[] = [];
      for (const p of ordered) {
        if (PAID.has(p.id) && pool.length) continue;
        const r = await attempt(p, () => p.searchKeyword(query, 25));
        attempts.push(r.attempt);
        pool.push(...r.results);
      }
      const byMpn = new Map<string, PartRecord[]>();
      for (const rec of pool) {
        if (candidateProblems(rec, cls, c, pkg, minV).length) continue;
        const k = `${normalizeMpn(rec.mpn)}|${normalizeManufacturer(rec.manufacturer)}`;
        byMpn.set(k, [...(byMpn.get(k) ?? []), rec]);
      }
      const need100 = comps.length * 100;
      const ranked = [...byMpn.values()].map((recs) => {
        const offers = mergeOffers(recs);
        const stock = Math.max(0, ...offers.map((o) => o.stock ?? 0));
        const p100 = pricing(offers, comps.length, [100], currency)[0]!.choice?.extended ?? Number.POSITIVE_INFINITY;
        const active = recs.every((r) => r.lifecycle === "active" || r.lifecycle === "unknown");
        return { recs, offers, lcsc: lcscOf(offers), stock, p100, active };
      }).sort((a, b) => Number(b.active) - Number(a.active) || Number(!!b.lcsc) - Number(!!a.lcsc)
        || Number(b.stock >= need100) - Number(a.stock >= need100) || a.p100 - b.p100);
      if (ranked.length) {
        const top = ranked[0]!;
        records = top.recs;
        const r0 = top.recs[0]!;
        selected = {
          mpn: r0.mpn, manufacturer: r0.manufacturer, description: r0.description, lifecycle: r0.lifecycle,
          datasheetUrl: top.recs.find((r) => r.datasheetUrl)?.datasheetUrl ?? null, productUrl: r0.productUrl,
          identity: "rule_selected", providers: [...new Set(top.recs.map((r) => r.provider))],
          cad: top.recs.find((r) => r.cad?.has3dModel)?.cad ?? null,
        };
        alternates = ranked.slice(1, 4).map((x) => ({ mpn: x.recs[0]!.mpn, manufacturer: x.recs[0]!.manufacturer,
          description: x.recs[0]!.description, lcsc: x.lcsc, stock: x.stock || null }));
        flags.push({ code: "rule_selected", severity: "info",
                     message: `chosen by rules from ${pool.length} search result(s) (query "${query}"): ${requirements.join("; ")}. Review before ordering.` });
      } else if (pool.length) {
        flags.push({ code: "no_candidate", severity: "error",
                     message: `${pool.length} search result(s) for "${query}" but none states all of: ${requirements.join("; ")}` });
      }
    }

    const offers = mergeOffers(records);
    const lcsc = lcscOf(offers);
    const configured = attempts.filter((a) => a.outcome !== "not_configured");
    if (!configured.length) flags.push({ code: "no_provider", severity: "error", message: "no sourcing provider is configured" });
    else if (!selected && !flags.some((f) => f.code === "no_candidate")) {
      const errors = configured.filter((a) => a.outcome === "error");
      flags.push({ code: "not_found", severity: "error",
                   message: errors.length === configured.length ? `every provider failed: ${errors.map((e) => e.error).join("; ")}`
                     : `${c.mpn ?? c.value} not found by ${configured.map((a) => a.provider).join(", ")}` });
    }
    for (const a of attempts.filter((x) => x.outcome === "error")) {
      flags.push({ code: "provider_error", severity: "warning", message: `${a.provider} failed: ${a.error}` });
    }
    if (selected) {
      if (selected.lifecycle === "obsolete") flags.push({ code: "obsolete", severity: "error", message: "part is obsolete" });
      if (selected.lifecycle === "nrnd" || selected.lifecycle === "last_time_buy") {
        flags.push({ code: "not_for_new_designs", severity: "warning", message: `lifecycle: ${selected.lifecycle.replace(/_/g, " ")}` });
      }
      if (selected.lifecycle === "unknown") flags.push({ code: "lifecycle_unknown", severity: "info", message: "no provider reported a lifecycle status" });
      const sellers100 = new Set(offers.filter((o) => (o.stock ?? 0) >= comps.length * 100).map((o) => o.seller.toLowerCase()));
      if (sellers100.size < 2) {
        flags.push({ code: "single_source", severity: "warning",
                     message: sellers100.size ? `only ${[...sellers100][0]} stocks enough for 100 boards` : "no seller stocks enough for 100 boards" });
      }
      if (!lcsc) flags.push({ code: "no_lcsc", severity: "warning", message: "no LCSC offer found: JLCPCB cannot assemble this line from its catalog" });
    }
    const price = pricing(offers, comps.length, quantities, currency);
    for (const pp of price) {
      if (selected && !pp.choice) flags.push({ code: "no_price", severity: pp.boards >= 1000 ? "warning" : "error", message: `${pp.boards} board(s): ${pp.note}` });
    }
    lines.push({
      key, refs: comps.map((x) => x.ref).sort(naturalRef), quantityPerBoard: comps.length, class: cls,
      wanted: { mpn: c.mpn, manufacturer: c.manufacturer, value: c.value, footprint: c.footprint, package: pkg, requirements },
      selected, lcsc, offers, pricing: price, alternates, flags, attempts,
    });
  }
  lines.sort((a, b) => naturalRef(a.refs[0]!, b.refs[0]!));

  const totals = quantities.map((boards) => {
    const missing = lines.filter((l) => !l.pricing.find((p) => p.boards === boards)?.choice).map((l) => l.refs.join(","));
    const sum = lines.reduce((s, l) => s + (l.pricing.find((p) => p.boards === boards)?.choice?.extended ?? 0), 0);
    return { boards, total: missing.length ? null : round(sum), perBoard: missing.length ? null : round(sum / boards), missingLines: missing };
  });
  const statuses = new Set(lines.flatMap((l) => l.offers.map((o) => o.status)));
  const all = lines.flatMap((l) => l.flags);
  return {
    version: BOM_RESOLVER_VERSION, generatedAt: new Date().toISOString(), currency, quantities,
    dataStatus: statuses.size === 0 ? "none" : statuses.size > 1 ? "mixed" : [...statuses][0]!,
    providers: ordered.map((p) => ({ id: p.id, label: p.label, role: p.role, configured: p.configured(), terms: p.terms })),
    lines, totals,
    counts: {
      lines: lines.length, sourced: lines.filter((l) => l.selected).length, unsourced: lines.filter((l) => !l.selected).length,
      errors: all.filter((f) => f.severity === "error").length, warnings: all.filter((f) => f.severity === "warning").length,
      withLcsc: lines.filter((l) => l.lcsc).length,
    },
  };
}

function round(n: number): number { return Math.round(n * 100) / 100; }

function naturalRef(a: string, b: string): number {
  const [, pa = "", na = "0"] = /^([A-Z]+)(\d+)/.exec(a) ?? [];
  const [, pb = "", nb = "0"] = /^([A-Z]+)(\d+)/.exec(b) ?? [];
  return pa.localeCompare(pb) || Number(na) - Number(nb);
}
