/**
 * Token prices (USD per million tokens), Anthropic first-party API, as published November 2026. 5-minute cache writes
 * cost 1.25x input; cache reads 0.05x input on the 5.5 models. Unknown models are charged at the most expensive listed
 * rate, so budgets fail safe. Update this table when prices change; every cost in the app is computed from it.
 */
import type { Usage } from "./model.ts";

export interface Price { input: number; output: number; cacheRead: number; cacheWrite: number }

export const PRICES: Record<string, Price> = {
  "claude-fable-5-2": { input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
};
const FALLBACK = PRICES["claude-fable-5-2"]!;

export function priceFor(model: string): { price: Price; known: boolean } {
  const p = PRICES[model] ?? PRICES[model.replace(/-\d{8}$/, "")];
  return { price: p ?? FALLBACK, known: !!p };
}

/** Cost of one model call in USD. Offline and scripted stand-ins cost nothing. */
export function usageCost(u: Usage): number {
  if (u.model === "offline-heuristic" || u.model === "scripted" || u.model === "offline") return 0;
  const { price } = priceFor(u.model);
  return (u.inputTokens * price.input + u.outputTokens * price.output + u.cacheReadTokens * price.cacheRead + u.cacheWriteTokens * price.cacheWrite) / 1_000_000;
}
