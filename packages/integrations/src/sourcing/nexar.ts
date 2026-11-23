/**
 * Nexar (Octopart data), the primary sourcing provider. GraphQL; OAuth2 client credentials with scope
 * supply.domain (24 h tokens). Field names are from the live schema (introspection, Nov 2026).
 * Nexar bills by parts returned, so lookups ask for few results.
 */
import { clientCredentials, request, short, TokenCache, type Fetch } from "./http.ts";
import { ProviderError, type Lifecycle, type PartRecord, type SourcingProvider } from "./types.ts";

export const NEXAR_TOKEN_URL = "https://identity.nexar.com/connect/token";
export const NEXAR_GRAPHQL_URL = "https://api.nexar.com/graphql";

const PART_FIELDS = `
  mpn
  manufacturer { name }
  shortDescription
  bestDatasheet { url }
  octopartUrl
  cad { has3dModel downloadUrlKicad }
  specs { attribute { shortname name } value displayValue }
  sellers(authorizedOnly: false, includeBrokers: false) {
    company { name }
    isAuthorized
    offers { sku inventoryLevel moq orderMultiple packaging clickUrl updated
             prices { quantity price currency convertedPrice convertedCurrency } }
  }`;

export const NEXAR_MPN_QUERY = `query PartByMpn($q: String!, $country: String!, $currency: String!, $limit: Int) {
  supSearchMpn(q: $q, country: $country, currency: $currency, limit: $limit) { hits results { part { ${PART_FIELDS} } } }
}`;
export const NEXAR_SEARCH_QUERY = `query PartSearch($q: String!, $country: String!, $currency: String!, $limit: Int) {
  supSearch(q: $q, country: $country, currency: $currency, limit: $limit) { hits results { part { ${PART_FIELDS} } } }
}`;

interface NexarPart {
  mpn: string; manufacturer: { name: string }; shortDescription: string; bestDatasheet: { url: string } | null; octopartUrl: string;
  cad?: { has3dModel: boolean | null; downloadUrlKicad: string | null } | null;
  specs: { attribute: { shortname: string; name: string }; value: string; displayValue: string }[];
  sellers: { company: { name: string }; isAuthorized: boolean;
             offers: { sku: string; inventoryLevel: number; moq: number | null; orderMultiple: number | null; packaging: string | null;
                       clickUrl: string; updated: string;
                       prices: { quantity: number; price: number; currency: string; convertedPrice: number; convertedCurrency: string }[] }[] }[];
}

/** Octopart lifecycle wording (from the lifecyclestatus spec) to our states. */
export function nexarLifecycle(raw: string | null): Lifecycle {
  if (!raw) return "unknown";
  const r = raw.toLowerCase();
  if (/obsolete|discontinued|eol|end of life/.test(r)) return "obsolete";
  if (/nrnd|not recommended/.test(r)) return "nrnd";
  if (/last time buy/.test(r)) return "last_time_buy";
  if (/production|active|new/.test(r)) return "active";
  return "unknown";
}

export function mapNexarPart(p: NexarPart, currency: string, observedAt: string): PartRecord {
  const spec = (s: string) => p.specs.find((x) => x.attribute.shortname === s)?.displayValue ?? null;
  const lifecycleRaw = spec("lifecyclestatus");
  return {
    provider: "nexar", mpn: p.mpn, manufacturer: p.manufacturer.name, description: p.shortDescription || null,
    lifecycle: nexarLifecycle(lifecycleRaw), lifecycleRaw, datasheetUrl: p.bestDatasheet?.url ?? null, productUrl: p.octopartUrl,
    package: spec("case_package"),
    cad: p.cad ? { has3dModel: !!p.cad.has3dModel, downloadUrl: p.cad.downloadUrlKicad ?? null, source: "Octopart CAD (via Nexar)" } : null,
    specs: Object.fromEntries(p.specs.map((s) => [s.attribute.name, s.displayValue])),
    offers: p.sellers.flatMap((s) => s.offers.map((o) => ({
      provider: "nexar" as const, seller: s.company.name, sku: o.sku || null,
      stock: o.inventoryLevel >= 0 ? o.inventoryLevel : null,     // negative values have meant "unknown" on Octopart
      moq: o.moq, multiple: o.orderMultiple, packaging: o.packaging, currency,
      prices: o.prices.filter((x) => x.convertedCurrency === currency).map((x) => ({ quantity: x.quantity, unitPrice: x.convertedPrice })),
      url: o.clickUrl || null, observedAt: o.updated || observedAt, status: "live" as const,
    }))),
  };
}

export class NexarProvider implements SourcingProvider {
  readonly id = "nexar" as const;
  readonly label = "Nexar (Octopart)";
  readonly role = "fallback_b" as const;   // paid per part: asked only when the free distributors find nothing
  readonly terms = "Nexar API terms: usage billed per part returned; check caching and display rights for your plan.";
  private readonly tokens: TokenCache;
  private readonly clientId: string | undefined;
  private readonly secret: string | undefined;
  private readonly fetchFn: Fetch;
  private readonly currency: string;
  private readonly country: string;

  constructor(clientId: string | undefined, secret: string | undefined, opts: { fetch?: Fetch; currency?: string; country?: string } = {}) {
    this.clientId = clientId;
    this.secret = secret;
    this.fetchFn = opts.fetch ?? fetch;
    this.currency = opts.currency ?? "USD";
    this.country = opts.country ?? "US";
    this.tokens = new TokenCache("nexar", () => clientCredentials("nexar", this.fetchFn, NEXAR_TOKEN_URL, {
      grant_type: "client_credentials", client_id: this.clientId ?? "", client_secret: this.secret ?? "", scope: "supply.domain",
    }));
  }

  configured(): boolean { return !!(this.clientId && this.secret); }

  private async query(query: string, q: string, limit: number): Promise<PartRecord[]> {
    const run = async () => request("nexar", this.fetchFn, NEXAR_GRAPHQL_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${await this.tokens.get()}` },
      body: JSON.stringify({ query, variables: { q, country: this.country, currency: this.currency, limit } }),
    });
    let r = await run();
    const errs = (r.body as { errors?: { message: string; extensions?: { code?: string } }[] })?.errors;
    if (errs?.some((e) => e.extensions?.code === "AuthExpiredToken")) { this.tokens.clear(); r = await run(); }
    const body = r.body as { data?: Record<string, { results: { part: NexarPart }[] | null }>; errors?: { message: string }[] };
    if (body?.errors?.length) {
      const msg = body.errors.map((e) => e.message).join("; ");
      throw new ProviderError("nexar", /token/i.test(msg) ? "auth" : "http", msg);
    }
    if (r.status !== 200 || !body?.data) throw new ProviderError("nexar", "http", `HTTP ${r.status}: ${short(r.body)}`);
    const set = Object.values(body.data)[0];
    const now = new Date().toISOString();
    return (set?.results ?? []).map((x) => mapNexarPart(x.part, this.currency, now));
  }

  searchMpn(mpn: string): Promise<PartRecord[]> { return this.query(NEXAR_MPN_QUERY, mpn, 3); }
  searchKeyword(query: string, limit: number): Promise<PartRecord[]> { return this.query(NEXAR_SEARCH_QUERY, query, Math.min(limit, 10)); }
}
