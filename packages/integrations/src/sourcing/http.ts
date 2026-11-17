/** Small HTTP helpers shared by the distributor adapters: timeouts, rate-limit errors, token caching. */
import { ProviderError, type ProviderId } from "./types.ts";

export type Fetch = typeof fetch;

export async function request(provider: ProviderId, fetchFn: Fetch, url: string, init: RequestInit,
                              timeoutMs = 20_000): Promise<{ status: number; body: unknown; headers: Headers }> {
  let res: Response;
  try {
    res = await fetchFn(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new ProviderError(provider, "network", (e as Error).message);
  }
  const text = await res.text();
  let body: unknown = text;
  try { body = text ? JSON.parse(text) : null; } catch { /* keep text */ }
  if (res.status === 429) {
    const retry = Number(res.headers.get("retry-after"));
    throw new ProviderError(provider, "rate_limit", `rate limited (HTTP 429)${retry ? `; retry after ${retry}s` : ""}`, retry || null);
  }
  if (res.status === 401 || res.status === 403) throw new ProviderError(provider, "auth", `HTTP ${res.status}: ${short(body)}`);
  return { status: res.status, body, headers: res.headers };
}

export function short(body: unknown): string {
  return (typeof body === "string" ? body : JSON.stringify(body)).slice(0, 300);
}

/** OAuth2 client-credentials token, cached until shortly before it expires. */
export class TokenCache {
  private token: string | null = null;
  private expires = 0;
  private readonly provider: ProviderId;
  private readonly fetchToken: () => Promise<{ token: string; expiresIn: number }>;
  constructor(provider: ProviderId, fetchToken: () => Promise<{ token: string; expiresIn: number }>) {
    this.provider = provider;
    this.fetchToken = fetchToken;
  }
  async get(): Promise<string> {
    if (this.token && Date.now() < this.expires) return this.token;
    const t = await this.fetchToken();
    if (!t.token) throw new ProviderError(this.provider, "auth", "token endpoint returned no access_token");
    this.token = t.token;
    this.expires = Date.now() + Math.max(30, t.expiresIn - 60) * 1000;
    return this.token;
  }
  clear(): void { this.token = null; }
}

export async function clientCredentials(provider: ProviderId, fetchFn: Fetch, url: string, form: Record<string, string>):
    Promise<{ token: string; expiresIn: number }> {
  const r = await request(provider, fetchFn, url, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
  const b = r.body as { access_token?: string; expires_in?: number; error?: string; ErrorMessage?: string } | null;
  if (r.status !== 200 || !b?.access_token) {
    throw new ProviderError(provider, "auth", `token request failed (HTTP ${r.status}): ${b?.error ?? b?.ErrorMessage ?? short(r.body)}`);
  }
  return { token: b.access_token, expiresIn: Number(b.expires_in) || 600 };
}
