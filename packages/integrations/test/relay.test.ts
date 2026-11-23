import { test } from "node:test";
import assert from "node:assert/strict";
import { DigiKeyRelayProvider, ProviderError } from "../src/index.ts";

test("relay sends the token and the Vercel bypass, and returns the website's records", async () => {
  let seen: { url: string; headers: Record<string, string>; body: unknown } | null = null;
  const fake = (async (url: string, init: RequestInit) => {
    seen = { url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) };
    return new Response(JSON.stringify({ records: [{ mpn: "ABC" }] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const p = new DigiKeyRelayProvider("https://site/api/sourcing/digikey", "t".repeat(30), fake, "bypass123");
  const recs = await p.searchMpn("ABC", "TI");
  assert.equal(recs.length, 1);
  assert.equal(seen!.headers.authorization, `Bearer ${"t".repeat(30)}`);
  assert.equal(seen!.headers["x-vercel-protection-bypass"], "bypass123");
  assert.deepEqual(seen!.body, { op: "mpn", mpn: "ABC", manufacturer: "TI" });
});

test("relay explains Vercel's sign-in page when no bypass is set", async () => {
  const fake = (async () => new Response("Authentication Required", { status: 401, headers: { server: "Vercel", "content-type": "text/html" } })) as unknown as typeof fetch;
  const p = new DigiKeyRelayProvider("https://site/x", "t".repeat(30), fake);
  await assert.rejects(p.searchKeyword("regulator", 5), (e: unknown) => e instanceof ProviderError && /VX_PARTS_RELAY_BYPASS/.test(e.message));
});

test("relay maps a wrong token to an auth error", async () => {
  const fake = (async () => new Response(JSON.stringify({ error: "wrong token" }), { status: 401, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  const p = new DigiKeyRelayProvider("https://site/x", "t".repeat(30), fake, "b");
  await assert.rejects(p.searchMpn("X"), (e: unknown) => e instanceof ProviderError && e.kind === "auth");
});
