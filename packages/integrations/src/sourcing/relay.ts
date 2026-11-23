/**
 * DigiKey through the VX Design website: for a worker whose own internet connection DigiKey's firewall blocks, the
 * lookups go to the website (which runs where DigiKey answers), authenticated with a shared token. The website does
 * the DigiKey call with its own DigiKey keys and returns the same part records.
 */
import { ProviderError, type PartRecord, type SourcingProvider } from "./types.ts";

type Fetch = typeof fetch;

export class DigiKeyRelayProvider implements SourcingProvider {
  readonly id = "digikey" as const;
  readonly label = "DigiKey (via the VX Design website)";
  readonly role = "primary" as const;
  readonly terms = "DigiKey Product Information API v4 terms; looked up by the VX Design website for this worker.";
  private readonly url: string | undefined;
  private readonly token: string | undefined;
  private readonly fetchFn: Fetch;
  /** Vercel's "Protection Bypass for Automation" secret, when the website is behind Vercel's own sign-in. */
  private readonly bypass: string | undefined;
  constructor(url: string | undefined, token: string | undefined, fetchFn: Fetch = fetch, bypass?: string) {
    this.url = url; this.token = token; this.fetchFn = fetchFn; this.bypass = bypass || undefined;
  }

  configured(): boolean { return !!(this.url && this.token); }

  private async call(body: Record<string, unknown>): Promise<PartRecord[]> {
    let res: Response;
    try {
      res = await this.fetchFn(this.url!, { method: "POST", headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json",
        ...(this.bypass ? { "x-vercel-protection-bypass": this.bypass } : {}) },
        body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    } catch (e) {
      throw new ProviderError("digikey", "network", `the website relay could not be reached: ${(e as Error).message}`);
    }
    if (res.status === 401 && !this.bypass && /vercel/i.test(res.headers.get("server") ?? "") && !(res.headers.get("content-type") ?? "").includes("json")) {
      throw new ProviderError("digikey", "auth", "website relay: the website is behind Vercel's sign-in; set VX_PARTS_RELAY_BYPASS to its Protection Bypass for Automation secret");
    }
    const data = await res.json().catch(() => null) as { records?: PartRecord[]; error?: string; kind?: string } | null;
    if (res.status === 401 || res.status === 403) throw new ProviderError("digikey", "auth", `website relay: ${data?.error ?? `HTTP ${res.status}`} (check VX_PARTS_RELAY_TOKEN)`);
    if (res.status === 429) throw new ProviderError("digikey", "rate_limit", "website relay: rate limited");
    if (!res.ok || !data) throw new ProviderError("digikey", (data?.kind as ProviderError["kind"]) ?? "http", `website relay: ${data?.error ?? `HTTP ${res.status}`}`);
    return data.records ?? [];
  }

  searchMpn(mpn: string, manufacturer?: string | null): Promise<PartRecord[]> { return this.call({ op: "mpn", mpn, manufacturer: manufacturer ?? null }); }
  searchKeyword(query: string, limit: number): Promise<PartRecord[]> { return this.call({ op: "keyword", query, limit }); }
}
