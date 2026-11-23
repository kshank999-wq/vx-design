import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { DigiKeyProvider, ProviderError } from "@vx/integrations";

/**
 * DigiKey lookups for workers whose own connection DigiKey's firewall blocks. POST with
 * Authorization: Bearer <VX_PARTS_RELAY_TOKEN> and {op: "mpn", mpn, manufacturer} or {op: "keyword", query, limit}.
 * GET (no token) reports whether DigiKey answers this server, without credentials or part data.
 */
export const runtime = "nodejs";
const clean = (v: string | undefined) => v?.replace(/\r/g, "").trim().replace(/^(["'])(.*)\1$/, "$2") || undefined;
let provider: DigiKeyProvider | null = null;
const dk = () => (provider ??= new DigiKeyProvider(clean(process.env.DIGIKEY_CLIENT_ID), clean(process.env.DIGIKEY_CLIENT_SECRET),
  process.env.DIGIKEY_LOCALE_SITE, process.env.DIGIKEY_LOCALE_CURRENCY));

function authorized(req: Request): boolean {
  const want = clean(process.env.VX_PARTS_RELAY_TOKEN);
  const got = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!want || want.length < 24 || !got) return false;
  const a = Buffer.from(want), b = Buffer.from(got);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "not authorized" }, { status: 401 });
  if (!dk().configured()) return NextResponse.json({ error: "DigiKey keys are not set on the website (DIGIKEY_CLIENT_ID, DIGIKEY_CLIENT_SECRET)", kind: "auth" }, { status: 503 });
  const body = await req.json().catch(() => ({})) as { op?: string; mpn?: string; manufacturer?: string | null; query?: string; limit?: number };
  try {
    const records = body.op === "mpn" && body.mpn ? await dk().searchMpn(String(body.mpn).slice(0, 120))
      : body.op === "keyword" && body.query ? await dk().searchKeyword(String(body.query).slice(0, 250), Math.min(Math.max(Number(body.limit) || 25, 1), 50))
      : null;
    if (!records) return NextResponse.json({ error: "op must be mpn (with mpn) or keyword (with query)" }, { status: 400 });
    return NextResponse.json({ records }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    const kind = e instanceof ProviderError ? e.kind : "http";
    return NextResponse.json({ error: (e as Error).message.slice(0, 500), kind }, { status: kind === "rate_limit" ? 429 : 502 });
  }
}

/** Whether DigiKey answers this server: a sign-in with deliberately wrong keys should come back as a JSON refusal, not a firewall page. */
export async function GET() {
  const r = await fetch("https://api.digikey.com/v1/oauth2/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "client_id=x&client_secret=x&grant_type=client_credentials", signal: AbortSignal.timeout(15_000) }).catch(() => null);
  const text = r ? await r.text() : "";
  const firewall = /Just a moment|cf-chl|challenge-platform/i.test(text);
  return NextResponse.json({ digikey_reachable: !!r && !firewall, firewall_page: firewall, status: r?.status ?? null,
    keys_set: dk().configured(), relay_token_set: (clean(process.env.VX_PARTS_RELAY_TOKEN)?.length ?? 0) >= 24 }, { headers: { "Cache-Control": "no-store" } });
}
