/**
 * Distributor-neutral part and offer records. Every provider adapter maps its API response onto
 * these, and every value says where it came from and when.
 */

export type ProviderId = "nexar" | "digikey" | "mouser" | "fixture";
export type ProviderRole = "primary" | "fallback_a" | "fallback_b" | "fixture";

/** live: returned by the provider in this run. fixture: offline stand-in data, never real. */
export type DataStatus = "live" | "fixture";
export type Lifecycle = "active" | "nrnd" | "last_time_buy" | "obsolete" | "unknown";

export interface PriceBreak { quantity: number; unitPrice: number }

export interface Offer {
  provider: ProviderId;
  /** Distributor that sells it (Nexar aggregates many: DigiKey, Mouser, LCSC, ...). */
  seller: string;
  sku: string | null;
  stock: number | null;
  moq: number | null;
  multiple: number | null;
  packaging: string | null;
  currency: string;
  prices: PriceBreak[];
  url: string | null;
  observedAt: string;
  status: DataStatus;
}

export interface PartRecord {
  provider: ProviderId;
  mpn: string;
  manufacturer: string;
  description: string | null;
  lifecycle: Lifecycle;
  lifecycleRaw: string | null;
  datasheetUrl: string | null;
  productUrl: string | null;
  package: string | null;
  specs: Record<string, string>;
  offers: Offer[];
}

export class ProviderError extends Error {
  readonly provider: ProviderId;
  readonly kind: "auth" | "rate_limit" | "http" | "network" | "parse";
  readonly retryAfterSeconds: number | null;
  constructor(provider: ProviderId, kind: ProviderError["kind"], message: string, retryAfterSeconds: number | null = null) {
    super(`${provider}: ${message}`);
    this.provider = provider;
    this.kind = kind;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface SourcingProvider {
  readonly id: ProviderId;
  readonly label: string;
  readonly role: ProviderRole;
  /** Credentials present (a configured provider can still fail at runtime). */
  configured(): boolean;
  /** What the provider's terms allow us to keep and show; recorded with every result. */
  readonly terms: string;
  /** Exact or near-exact part number lookup. */
  searchMpn(mpn: string, manufacturer?: string | null): Promise<PartRecord[]>;
  /** Free-text search (used for generic passives). */
  searchKeyword(query: string, limit: number): Promise<PartRecord[]>;
}

export interface ProviderAttempt {
  provider: ProviderId;
  outcome: "ok" | "no_match" | "not_configured" | "error";
  results: number;
  ms: number;
  error?: string;
}
