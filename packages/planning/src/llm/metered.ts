/**
 * Every AI call, priced and recorded. Wraps a model: each call is timed, its tokens priced from the price table, and
 * the result handed to a sink (the database), including calls that fail after the model has run (a refusal, a reply
 * cut off), which are billed too. A sink that fails never fails the work. An optional guard runs before each call and
 * returns a reason to stop it (the account's balance or allowance is used up), so no call is made that cannot be paid for.
 */
import type { GenerateRequest, GenerateResult, LanguageModel, Usage } from "./model.ts";
import { ModelOutputError } from "./model.ts";
import { usageCost } from "./pricing.ts";

export interface AiCallEvent {
  purpose: string;
  usage: Usage;
  costUsd: number;
  durationMs: number;
  failed: boolean;
}
export type AiCallSink = (e: AiCallEvent) => Promise<void> | void;
/** Returns why the call may not be made, or null. */
export type AiCallGuard = (purpose: string) => Promise<string | null> | string | null;

/** An AI call refused before it was made (nothing was spent). */
export class SpendStoppedError extends Error {
  constructor(reason: string) { super(`AI work is paused: ${reason}.`); this.name = "SpendStoppedError"; }
}

export class MeteredModel implements LanguageModel {
  private readonly inner: LanguageModel;
  private readonly sink: AiCallSink;
  private readonly guard: AiCallGuard | undefined;
  constructor(inner: LanguageModel, sink: AiCallSink, guard?: AiCallGuard) { this.inner = inner; this.sink = sink; this.guard = guard; }

  async generate<T>(req: GenerateRequest<T>): Promise<GenerateResult<T>> {
    // A check that cannot run (the database is unreachable) lets the call through, like a sink that fails; work started
    // from a run or plan request is checked again in the database.
    let stop: string | null = null;
    try { stop = this.guard ? await this.guard(req.purpose) : null; }
    catch (e) { console.error(`AI spend check (${req.purpose}) failed: ${(e as Error).message}`); }
    if (stop) throw new SpendStoppedError(stop);
    const t0 = Date.now();
    const send = async (usage: Usage, failed: boolean) => {
      try { await this.sink({ purpose: req.purpose, usage, costUsd: usageCost(usage), durationMs: Date.now() - t0, failed }); }
      catch (e) { console.error(`AI cost record (${req.purpose}) failed: ${(e as Error).message}`); }
    };
    try {
      const r = await this.inner.generate(req);
      await send(r.usage, false);
      return r;
    } catch (e) {
      if (e instanceof ModelOutputError && e.usage) await send(e.usage, true);
      throw e;
    }
  }
}
