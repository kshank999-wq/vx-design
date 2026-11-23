/**
 * Builds the distributor chain from the environment: the free distributor APIs first (DigiKey, then Mouser), and
 * Nexar/Octopart last, asked only for parts the free ones do not find (its API is billed per part).
 * VX_SOURCING=fixture swaps in the offline stand-in, which is labelled as fixture data everywhere.
 */
import { FixtureProvider } from "./fixture.ts";
import { DigiKeyProvider } from "./digikey.ts";
import { MouserProvider } from "./mouser.ts";
import { NexarProvider } from "./nexar.ts";
import type { SourcingProvider } from "./types.ts";

/** A key as pasted into an env file: without surrounding spaces, quotes or a Windows line ending. */
export function cleanKey(v: string | undefined): string | undefined {
  const t = v?.replace(/\r/g, "").trim().replace(/^(["'])(.*)\1$/, "$2").trim();
  return t ? t : undefined;
}

export function sourcingProvidersFromEnv(raw: Record<string, string | undefined> = process.env): SourcingProvider[] {
  const env = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, /KEY|SECRET|CLIENT_ID/.test(k) ? cleanKey(v) : v]));
  if (env.VX_SOURCING === "fixture") return [new FixtureProvider()];
  if (env.VX_SOURCING === "off") return [];
  return [
    new DigiKeyProvider(env.DIGIKEY_CLIENT_ID, env.DIGIKEY_CLIENT_SECRET, env.DIGIKEY_LOCALE_SITE, env.DIGIKEY_LOCALE_CURRENCY),
    new MouserProvider(env.MOUSER_API_KEY),
    new NexarProvider(env.NEXAR_CLIENT_ID, env.NEXAR_CLIENT_SECRET),
  ];
}
