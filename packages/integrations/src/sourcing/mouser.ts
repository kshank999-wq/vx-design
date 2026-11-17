/**
 * Mouser Search API v1, fallback B. The API key goes in the query string; errors can come back with
 * HTTP 200 and an Errors array, so every response is checked. Field names from Mouser's Swagger spec
 * (Nov 2026); Min, Mult, AvailabilityInStock and PriceBreaks[].Price are strings.
 */
import { request, short, type Fetch } from "./http.ts";
import { ProviderError, type Lifecycle, type PartRecord, type SourcingProvider } from "./types.ts";

export const MOUSER_BASE = "https://api.mouser.com/api/v1/search";

interface MouserPart {
  ManufacturerPartNumber: string; Manufacturer: string; Description: string; Availability?: string | null;
  AvailabilityInStock?: string | null; Min?: string | null; Mult?: string | null; LifecycleStatus?: string | null;
  DataSheetUrl?: string | null; ProductDetailUrl?: string | null; MouserPartNumber?: string | null; IsDiscontinued?: string | null;
  PriceBreaks?: { Quantity: number; Price: string; Currency: string }[] | null;
  ProductAttributes?: { AttributeName: string; AttributeValue: string }[] | null;
}

/** "$0.100" -> 0.1, "0,903 €" -> 0.903, "1,234.50" -> 1234.5 */
export function parseMouserPrice(s: string): number | null {
  const t = s.replace(/[^\d.,]/g, "");
  if (!t) return null;
  const lastComma = t.lastIndexOf(","), lastDot = t.lastIndexOf(".");
  const normalized = lastComma > lastDot ? t.replace(/\./g, "").replace(",", ".") : t.replace(/,/g, "");
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

function int(s: string | null | undefined): number | null {
  const n = Number(String(s ?? "").replace(/[^\d]/g, ""));
  return String(s ?? "").match(/\d/) ? n : null;
}

export function mouserLifecycle(p: MouserPart): { lifecycle: Lifecycle; raw: string | null } {
  const raw = p.LifecycleStatus ?? null;
  const r = (raw ?? "").toLowerCase();
  if (p.IsDiscontinued === "true" || /obsolete|discontinued|end of life/.test(r)) return { lifecycle: "obsolete", raw };
  if (/not recommended/.test(r)) return { lifecycle: "nrnd", raw };
  if (/last time buy/.test(r)) return { lifecycle: "last_time_buy", raw };
  if (/new/.test(r)) return { lifecycle: "active", raw };
  return { lifecycle: "unknown", raw };   // Mouser leaves LifecycleStatus null for ordinary active parts
}

export function mapMouserPart(p: MouserPart, observedAt: string): PartRecord {
  const { lifecycle, raw } = mouserLifecycle(p);
  const attrs = Object.fromEntries((p.ProductAttributes ?? []).map((a) => [a.AttributeName, a.AttributeValue]));
  const breaks = (p.PriceBreaks ?? []).map((b) => ({ quantity: b.Quantity, unitPrice: parseMouserPrice(b.Price), currency: b.Currency }))
    .filter((b): b is { quantity: number; unitPrice: number; currency: string } => b.unitPrice !== null);
  return {
    provider: "mouser", mpn: p.ManufacturerPartNumber, manufacturer: p.Manufacturer, description: p.Description || null,
    lifecycle, lifecycleRaw: raw, datasheetUrl: p.DataSheetUrl || null, productUrl: p.ProductDetailUrl || null,
    package: attrs["Package / Case"] ?? null, specs: attrs,
    offers: [{
      provider: "mouser", seller: "Mouser", sku: p.MouserPartNumber || null,
      stock: int(p.AvailabilityInStock) ?? (p.Availability && /\d/.test(p.Availability) ? int(p.Availability) : 0),
      moq: int(p.Min), multiple: int(p.Mult), packaging: attrs["Packaging"] ?? null, currency: breaks[0]?.currency ?? "USD",
      prices: breaks.map((b) => ({ quantity: b.quantity, unitPrice: b.unitPrice })), url: p.ProductDetailUrl || null,
      observedAt, status: "live",
    }],
  };
}

export class MouserProvider implements SourcingProvider {
  readonly id = "mouser" as const;
  readonly label = "Mouser";
  readonly role = "fallback_b" as const;
  readonly terms = "Mouser API terms: request limits per key (commonly cited as 30/min, 1000/day; unconfirmed); check display rights.";
  private readonly apiKey: string | undefined;
  private readonly fetchFn: Fetch;

  constructor(apiKey: string | undefined, opts: { fetch?: Fetch } = {}) {
    this.apiKey = apiKey;
    this.fetchFn = opts.fetch ?? fetch;
  }

  configured(): boolean { return !!this.apiKey; }

  private async post(path: string, body: unknown): Promise<PartRecord[]> {
    const r = await request("mouser", this.fetchFn, `${MOUSER_BASE}/${path}?apiKey=${encodeURIComponent(this.apiKey ?? "")}`, {
      method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body),
    });
    const b = r.body as { Errors?: { Code: string; Message: string; PropertyName?: string }[];
                          SearchResults?: { Parts?: MouserPart[] } | null } | null;
    if (b?.Errors?.length) {
      const msg = b.Errors.map((e) => `${e.Code}: ${e.Message}${e.PropertyName ? ` (${e.PropertyName})` : ""}`).join("; ");
      throw new ProviderError("mouser", /key|identifier/i.test(msg) ? "auth" : "http", msg);
    }
    if (r.status !== 200) throw new ProviderError("mouser", "http", `HTTP ${r.status}: ${short(r.body)}`);
    const now = new Date().toISOString();
    return (b?.SearchResults?.Parts ?? []).map((p) => mapMouserPart(p, now));
  }

  searchMpn(mpn: string): Promise<PartRecord[]> {
    return this.post("partnumber", { SearchByPartRequest: { mouserPartNumber: mpn, partSearchOptions: "Exact" } });
  }

  searchKeyword(query: string, limit: number): Promise<PartRecord[]> {
    return this.post("keyword", { SearchByKeywordRequest: { keyword: query, records: Math.min(limit, 50), startingRecord: 0,
                                                             searchOptions: "InStock", searchWithYourSignUpLanguage: "false" } });
  }
}
