/** Contract tests for the distributor adapters against documented response shapes (see fixtures/README.md). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DigiKeyProvider, MouserProvider, NexarProvider, ProviderError, parseMouserPrice, sourcingProvidersFromEnv } from "../src/index.ts";

const fx = (n: string) => JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", n), "utf8"));

interface Call { url: string; init: RequestInit }
function fakeFetch(handler: (url: string, init: RequestInit) => { status?: number; body: unknown; headers?: Record<string, string> }) {
  const calls: Call[] = [];
  const fn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const r = handler(url, init);
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), { status: r.status ?? 200, headers: r.headers });
  }) as typeof fetch;
  return { fn, calls };
}

test("nexar: client-credentials token with supply.domain, Bearer GraphQL, offers mapped in USD", async () => {
  const { fn, calls } = fakeFetch((url) => url.includes("identity.nexar.com")
    ? { body: { access_token: "tok", expires_in: 86400, token_type: "Bearer" } }
    : { body: fx("nexar-supSearchMpn.json") });
  const p = new NexarProvider("id", "secret", { fetch: fn });
  const [part] = await p.searchMpn("LM358DR");
  await p.searchMpn("LM358DR");
  assert.equal(calls.filter((c) => c.url.includes("identity")).length, 1, "token cached");
  const form = new URLSearchParams(String(calls[0]!.init.body));
  assert.equal(form.get("grant_type"), "client_credentials");
  assert.equal(form.get("scope"), "supply.domain");
  assert.equal((calls[1]!.init.headers as Record<string, string>).authorization, "Bearer tok");
  const gql = JSON.parse(String(calls[1]!.init.body));
  assert.match(gql.query, /supSearchMpn\(q: \$q/);
  assert.deepEqual(gql.variables, { q: "LM358DR", country: "US", currency: "USD", limit: 3 });
  assert.equal(part!.mpn, "LM358DR");
  assert.equal(part!.manufacturer, "Texas Instruments");
  assert.equal(part!.lifecycle, "active");
  assert.equal(part!.lifecycleRaw, "Production");
  assert.equal(part!.package, "SOIC");
  const o = part!.offers[0]!;
  assert.deepEqual([o.seller, o.sku, o.stock, o.moq, o.currency, o.status], ["DigiKey", "296-1014-1-ND", 125430, 1, "USD", "live"]);
  assert.deepEqual(o.prices[2], { quantity: 100, unitPrice: 0.2316 });
});

test("nexar: an invalid token is an auth error, not an empty result", async () => {
  const { fn } = fakeFetch((url) => url.includes("identity") ? { body: { access_token: "bad", expires_in: 10 } } : { body: fx("nexar-invalid-token.json") });
  await assert.rejects(new NexarProvider("id", "s", { fetch: fn }).searchMpn("X"), (e) => e instanceof ProviderError && e.kind === "auth");
});

test("digikey: client id header and locale, ProductDetails mapped with the response currency", async () => {
  const { fn, calls } = fakeFetch((url) => url.includes("oauth2/token")
    ? { body: { access_token: "dk", expires_in: 599, token_type: "Bearer" } }
    : { body: fx("digikey-productdetails.json") });
  const [part] = await new DigiKeyProvider("cid", "sec", "US", "USD", { fetch: fn }).searchMpn("RC0402FR-0722RL");
  const call = calls[1]!;
  assert.equal(call.url, "https://api.digikey.com/products/v4/search/RC0402FR-0722RL/productdetails");
  const h = call.init.headers as Record<string, string>;
  assert.equal(h["X-DIGIKEY-Client-Id"], "cid");
  assert.equal(h.authorization, "Bearer dk");
  assert.equal(part!.manufacturer, "YAGEO");
  assert.equal(part!.lifecycle, "active");
  assert.match(part!.description!, /RES 22 OHM 1% 1\/16W 0402/);
  assert.equal(part!.offers.length, 2);
  assert.deepEqual([part!.offers[0]!.sku, part!.offers[0]!.stock, part!.offers[0]!.currency], ["311-22.0LRCT-ND", 1553626, "EUR"],
                   "currency comes from SearchLocaleUsed, not assumed");
  assert.equal(part!.offers[1]!.moq, 10000);
});

test("digikey: 404 is no match; 401 is an auth error; 429 carries Retry-After", async () => {
  const token = { body: { access_token: "dk", expires_in: 599 } };
  const nf = fakeFetch((url) => url.includes("token") ? token : { status: 404, body: { title: "Not Found", status: 404 } });
  assert.deepEqual(await new DigiKeyProvider("c", "s", "US", "USD", { fetch: nf.fn }).searchMpn("NOPE"), []);
  const un = fakeFetch((url) => url.includes("token") ? token : { status: 401, body: fx("digikey-401.json") });
  await assert.rejects(new DigiKeyProvider("c", "s", "US", "USD", { fetch: un.fn }).searchMpn("X"), (e) => e instanceof ProviderError && e.kind === "auth");
  const rl = fakeFetch((url) => url.includes("token") ? token : { status: 429, body: { ErrorMessage: "BurstLimit exceeded" }, headers: { "retry-after": "12" } });
  await assert.rejects(new DigiKeyProvider("c", "s", "US", "USD", { fetch: rl.fn }).searchMpn("X"),
                       (e) => e instanceof ProviderError && e.kind === "rate_limit" && e.retryAfterSeconds === 12);
});

test("mouser: key in the query string, string fields parsed, HTTP 200 errors raised", async () => {
  const ok = fakeFetch(() => ({ body: fx("mouser-partnumber.json") }));
  const [part] = await new MouserProvider("KEY", { fetch: ok.fn }).searchMpn("LM317LID");
  assert.equal(ok.calls[0]!.url, "https://api.mouser.com/api/v1/search/partnumber?apiKey=KEY");
  assert.deepEqual(JSON.parse(String(ok.calls[0]!.init.body)), { SearchByPartRequest: { mouserPartNumber: "LM317LID", partSearchOptions: "Exact" } });
  const o = part!.offers[0]!;
  assert.deepEqual([o.sku, o.stock, o.moq, o.multiple, o.packaging, o.currency], ["595-LM317LID", 10476, 1, 1, "Tube", "USD"]);
  assert.deepEqual(o.prices, [{ quantity: 1, unitPrice: 0.98 }, { quantity: 10, unitPrice: 0.707 }, { quantity: 75, unitPrice: 0.545 }]);
  assert.equal(part!.lifecycle, "unknown", "Mouser leaves lifecycle null for ordinary parts");
  const bad = fakeFetch(() => ({ body: fx("mouser-invalid-key.json") }));
  await assert.rejects(new MouserProvider("BAD", { fetch: bad.fn }).searchMpn("X"),
                       (e) => e instanceof ProviderError && e.kind === "auth" && /Invalid unique identifier/.test(e.message));
  assert.equal(parseMouserPrice("$0.100"), 0.1);
  assert.equal(parseMouserPrice("0,903 €"), 0.903);
  assert.equal(parseMouserPrice("$1,234.50"), 1234.5);
});

test("provider chain from the environment: order, configuration and the fixture switch", () => {
  const all = sourcingProvidersFromEnv({ NEXAR_CLIENT_ID: "a", NEXAR_CLIENT_SECRET: "b", MOUSER_API_KEY: "k" });
  assert.deepEqual(all.map((p) => [p.id, p.role, p.configured()]),
                   [["nexar", "primary", true], ["digikey", "fallback_a", false], ["mouser", "fallback_b", true]]);
  assert.deepEqual(sourcingProvidersFromEnv({ VX_SOURCING: "fixture" }).map((p) => p.id), ["fixture"]);
  assert.deepEqual(sourcingProvidersFromEnv({ VX_SOURCING: "off" }), []);
});
