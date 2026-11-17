/**
 * Token prices used to charge AI usage against run budgets (USD per million tokens).
 * Source: Anthropic published pricing as of 2026-11. Cache reads on Opus 5.5 / Sonnet 5.5
 * are 0.05x input; 5-minute cache writes are 1.25x input.
 * Unknown models are charged at the most expensive listed rate so budgets fail safe.
 */
import type { Usage } from "@vx/planning";

interface Price { input: number; output: number; cacheRead: number; cacheWrite: number }

const PRICES: Record<string, Price> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
};
const FALLBACK = PRICES["claude-opus-5-5"]!;

export function priceFor(model: string): { price: Price; known: boolean } {
  const p = PRICES[model] ?? PRICES[model.replace(/-\d{8}$/, "")];
  return { price: p ?? FALLBACK, known: !!p };
}

/** Cost of one model call in USD. Offline and scripted stand-ins cost nothing. */
export function usageCost(u: Usage): number {
  if (u.model === "offline-heuristic" || u.model === "scripted") return 0;
  const { price } = priceFor(u.model);
  return (u.inputTokens * price.input + u.outputTokens * price.output +
          u.cacheReadTokens * price.cacheRead + u.cacheWriteTokens * price.cacheWrite) / 1_000_000;
}
