import "server-only";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { isIP } from "node:net";
import { blockedAddress } from "@vx/security";

/**
 * Fetches a public document for the knowledge base without letting a link reach inside the network (SSRF):
 * https only; every address a host name resolves to is checked when the connection is made (so a name cannot be
 * re-pointed between check and connect); redirects are followed by hand, each re-checked; size and time limits.
 */
export const FETCH_LIMITS = { maxBytes: 20 * 1048576, timeoutMs: 20_000, maxRedirects: 5 };

export class FetchRefused extends Error {}

export interface Fetched { bytes: Uint8Array; contentType: string; finalUrl: string }

/** Test-only: lets the end-to-end suite serve documents from a local http server; ignored on Vercel and when unset. */
function testRewrite(url: URL): { url: URL; allowLocal: boolean } {
  const rule = process.env.VX_TEST_FETCH_REWRITE;   // "https://docs.example.test=http://127.0.0.1:4599"
  if (!rule || process.env.VERCEL) return { url, allowLocal: false };
  const [from, to] = rule.split("=");
  if (from && to && url.origin === new URL(from).origin) return { url: new URL(url.pathname + url.search, to), allowLocal: true };
  return { url, allowLocal: false };
}

function once(target: URL): Promise<{ status: number; location: string | null; contentType: string; bytes: Uint8Array }> {
  const { url, allowLocal } = testRewrite(target);
  if (!allowLocal && url.protocol !== "https:") return Promise.reject(new FetchRefused("only https links are fetched"));
  if (!allowLocal && isIP(url.hostname) && blockedAddress(url.hostname)) return Promise.reject(new FetchRefused("that address is not public"));
  const lookup = (host: string, opts: object, cb: (err: Error | null, address: string | LookupAddress[], family?: number) => void) =>
    dnsLookup(host, { ...opts, all: true }, (err, addrs: LookupAddress[]) => {
      if (err) return cb(err, []);
      const bad = addrs.find((a) => blockedAddress(a.address));
      if (bad && !allowLocal) return cb(new FetchRefused(`${host} resolves to a non-public address`), []);
      (opts as { all?: boolean }).all ? cb(null, addrs) : cb(null, addrs[0]!.address, addrs[0]!.family);
    });
  const req = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const r = req(url, { method: "GET", lookup: lookup as never, timeout: FETCH_LIMITS.timeoutMs,
                         headers: { "User-Agent": "VX-Design-knowledge-fetch/1", Accept: "application/pdf,text/html,text/plain;q=0.9,*/*;q=0.5" } }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) { res.resume(); return resolve({ status, location: res.headers.location ?? null, contentType: "", bytes: new Uint8Array() }); }
      const declared = Number(res.headers["content-length"] ?? 0);
      if (declared > FETCH_LIMITS.maxBytes) { res.destroy(); return reject(new FetchRefused("the document is larger than 20 MB")); }
      const parts: Buffer[] = []; let size = 0;
      res.on("data", (c: Buffer) => {
        size += c.length;
        if (size > FETCH_LIMITS.maxBytes) { res.destroy(); reject(new FetchRefused("the document is larger than 20 MB")); } else parts.push(c);
      });
      res.on("end", () => resolve({ status, location: null, contentType: String(res.headers["content-type"] ?? ""), bytes: new Uint8Array(Buffer.concat(parts)) }));
      res.on("error", reject);
    });
    r.on("timeout", () => r.destroy(new FetchRefused("the site did not answer within 20 s")));
    r.on("error", reject);
    r.end();
  });
}

export async function safeFetch(link: string): Promise<Fetched> {
  let url = new URL(link);
  for (let hop = 0; hop <= FETCH_LIMITS.maxRedirects; hop++) {
    const res = await once(url);
    if (res.location) {
      url = new URL(res.location, url);
      if (url.protocol !== "https:") throw new FetchRefused("the link redirects away from https");
      continue;
    }
    if (res.status !== 200) throw new FetchRefused(`the site answered ${res.status}`);
    return { bytes: res.bytes, contentType: res.contentType.split(";")[0]!.trim(), finalUrl: url.toString() };
  }
  throw new FetchRefused("too many redirects");
}
