/**
 * DigiKey Product Information API v4, fallback A. OAuth2 client credentials (10 min tokens); field names
 * from DigiKey's Swagger spec (Nov 2026). Prices have no per-price currency: the response's
 * SearchLocaleUsed.Currency applies to all of them.
 */
import { clientCredentials, request, short, TokenCache, type Fetch } from "./http.ts";
import { ProviderError, type Lifecycle, type PartRecord, type SourcingProvider } from "./types.ts";

export const DIGIKEY_TOKEN_URL = "https://api.digikey.com/v1/oauth2/token";
export const DIGIKEY_BASE = "https://api.digikey.com/products/v4";

interface DkProduct {
  ManufacturerProductNumber: string; Manufacturer: { Name: string } | null;
  Description: { ProductDescription: string; DetailedDescription: string } | null;
  QuantityAvailable: number; ProductStatus: { Status: string } | null; DatasheetUrl: string | null; ProductUrl: string | null;
  Discontinued?: boolean; EndOfLife?: boolean;
  Parameters?: { ParameterText: string; ValueText: string }[];
  ProductVariations?: { DigiKeyProductNumber: string; PackageType: { Name: string } | null; MinimumOrderQuantity: number;
                        QuantityAvailableforPackageType: number; StandardPricing: { BreakQuantity: number; UnitPrice: number }[];
                        MarketPlace?: boolean }[];
}

export function digikeyLifecycle(p: DkProduct): { lifecycle: Lifecycle; raw: string | null } {
  const raw = p.ProductStatus?.Status ?? null;
  const r = (raw ?? "").toLowerCase();
  if (p.Discontinued || p.EndOfLife || /obsolete|discontinued/.test(r)) return { lifecycle: "obsolete", raw };
  if (/not for new designs/.test(r)) return { lifecycle: "nrnd", raw };
  if (/last time buy/.test(r)) return { lifecycle: "last_time_buy", raw };
  if (/active/.test(r)) return { lifecycle: "active", raw };
  return { lifecycle: "unknown", raw };
}

export function mapDigikeyProduct(p: DkProduct, currency: string, observedAt: string): PartRecord {
  const { lifecycle, raw } = digikeyLifecycle(p);
  const params = Object.fromEntries((p.Parameters ?? []).map((x) => [x.ParameterText, x.ValueText]));
  return {
    provider: "digikey", mpn: p.ManufacturerProductNumber, manufacturer: p.Manufacturer?.Name ?? "",
    description: [p.Description?.ProductDescription, p.Description?.DetailedDescription].filter(Boolean).join(" — ") || null,
    lifecycle, lifecycleRaw: raw, datasheetUrl: p.DatasheetUrl || null, productUrl: p.ProductUrl || null,
    package: params["Package / Case"] ?? params["Supplier Device Package"] ?? null, specs: params,
    offers: (p.ProductVariations ?? []).filter((v) => !v.MarketPlace).map((v) => ({
      provider: "digikey" as const, seller: "DigiKey", sku: v.DigiKeyProductNumber, stock: v.QuantityAvailableforPackageType,
      moq: v.MinimumOrderQuantity || null, multiple: null, packaging: v.PackageType?.Name ?? null, currency,
      prices: v.StandardPricing.map((b) => ({ quantity: b.BreakQuantity, unitPrice: b.UnitPrice })), url: p.ProductUrl || null,
      observedAt, status: "live" as const,
    })),
  };
}

export class DigiKeyProvider implements SourcingProvider {
  readonly id = "digikey" as const;
  readonly label = "DigiKey";
  readonly role = "fallback_a" as const;
  readonly terms = "DigiKey API terms: daily request quota (see X-RateLimit-Limit); check caching and display rights.";
  private readonly tokens: TokenCache;
  private readonly clientId: string | undefined;
  private readonly secret: string | undefined;
  private readonly site: string;
  private readonly currency: string;
  private readonly fetchFn: Fetch;

  constructor(clientId: string | undefined, secret: string | undefined, site = "US", currency = "USD", opts: { fetch?: Fetch } = {}) {
    this.clientId = clientId;
    this.secret = secret;
    this.site = site || "US";
    this.currency = currency || "USD";
    this.fetchFn = opts.fetch ?? fetch;
    this.tokens = new TokenCache("digikey", () => clientCredentials("digikey", this.fetchFn, DIGIKEY_TOKEN_URL, {
      grant_type: "client_credentials", client_id: this.clientId ?? "", client_secret: this.secret ?? "",
    }));
  }

  configured(): boolean { return !!(this.clientId && this.secret); }

  private async headers(): Promise<Record<string, string>> {
    return { authorization: `Bearer ${await this.tokens.get()}`, "X-DIGIKEY-Client-Id": this.clientId ?? "",
             "X-DIGIKEY-Locale-Site": this.site, "X-DIGIKEY-Locale-Language": "en", "X-DIGIKEY-Locale-Currency": this.currency,
             "content-type": "application/json", "user-agent": "VX-Design/1.0 (electronics design; DigiKey Product Information API v4)",
             accept: "application/json" };
  }

  private currencyOf(body: { SearchLocaleUsed?: { Currency?: string } }): string {
    return body.SearchLocaleUsed?.Currency || this.currency;
  }

  async searchMpn(mpn: string): Promise<PartRecord[]> {
    const r = await request("digikey", this.fetchFn, `${DIGIKEY_BASE}/search/${encodeURIComponent(mpn)}/productdetails`,
                            { method: "GET", headers: await this.headers() });
    if (r.status === 404) return [];
    if (r.status !== 200) throw new ProviderError("digikey", "http", `HTTP ${r.status}: ${short(r.body)}`);
    const body = r.body as { Product?: DkProduct; SearchLocaleUsed?: { Currency?: string } };
    return body.Product ? [mapDigikeyProduct(body.Product, this.currencyOf(body), new Date().toISOString())] : [];
  }

  async searchKeyword(query: string, limit: number): Promise<PartRecord[]> {
    const r = await request("digikey", this.fetchFn, `${DIGIKEY_BASE}/search/keyword`, {
      method: "POST", headers: await this.headers(),
      body: JSON.stringify({ Keywords: query.slice(0, 250), Limit: Math.min(Math.max(limit, 1), 50), Offset: 0,
                             FilterOptionsRequest: { SearchOptions: ["InStock"] },
                             SortOptions: { Field: "QuantityAvailable", SortOrder: "Descending" } }),
    });
    if (r.status !== 200) throw new ProviderError("digikey", "http", `HTTP ${r.status}: ${short(r.body)}`);
    const body = r.body as { Products?: DkProduct[]; ExactMatches?: DkProduct[]; SearchLocaleUsed?: { Currency?: string } };
    const now = new Date().toISOString();
    const seen = new Set<string>();
    return [...(body.ExactMatches ?? []), ...(body.Products ?? [])].filter((p) => {
      const k = p.ManufacturerProductNumber;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }).map((p) => mapDigikeyProduct(p, this.currencyOf(body), now));
  }
}
