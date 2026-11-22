/**
 * Every AI call, priced and recorded. Wraps a model: each call is timed, its tokens priced from the price table, and
 * the result handed to a sink (the database), including calls that fail after the model has run (a refusal, a reply
 * cut off), which are billed too. A sink that fails never fails the work.
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

export class MeteredModel implements LanguageModel {
  private readonly inner: LanguageModel;
  private readonly sink: AiCallSink;
  constructor(inner: LanguageModel, sink: AiCallSink) { this.inner = inner; this.sink = sink; }

  async generate<T>(req: GenerateRequest<T>): Promise<GenerateResult<T>> {
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
