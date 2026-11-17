/**
 * Language-model boundary for planning. The pipeline only depends on this
 * interface, so tests can script responses and production uses Claude.
 */
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";

export interface Usage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface GenerateRequest<T> {
  /** Short label for logs and cost events, e.g. "extract_requirements". */
  purpose: string;
  system: string;
  messages: Anthropic.Beta.BetaMessageParam[];
  schema: z.ZodType<T>;
}

export interface GenerateResult<T> {
  output: T;
  /** Assistant turn exactly as returned, for appending in multi-turn repair loops. */
  assistantMessage: Anthropic.Beta.BetaMessageParam;
  usage: Usage;
}

export interface LanguageModel {
  generate<T>(req: GenerateRequest<T>): Promise<GenerateResult<T>>;
}

export class ModelOutputError extends Error {}

export const DEFAULT_MODEL = "claude-opus-5-5";

export interface ClaudeOptions {
  client?: Anthropic;
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  maxTokens?: number;
}

/**
 * Claude via the Messages API with structured outputs. Uses streaming (long documents
 * and plans can take minutes), adaptive thinking, and the server-side refusal fallback.
 */
export class ClaudeModel implements LanguageModel {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly effort: NonNullable<ClaudeOptions["effort"]>;
  private readonly maxTokens: number;

  constructor(opts: ClaudeOptions = {}) {
    this.client = opts.client ?? new Anthropic();
    this.model = opts.model ?? process.env.VX_PLANNING_MODEL ?? DEFAULT_MODEL;
    this.effort = opts.effort ?? "high";
    this.maxTokens = opts.maxTokens ?? 64000;
  }

  async generate<T>(req: GenerateRequest<T>): Promise<GenerateResult<T>> {
    const stream = this.client.beta.messages.stream({
      model: this.model,
      max_tokens: this.maxTokens,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: { effort: this.effort, format: betaZodOutputFormat(req.schema) },
      // The system prompt is identical across calls of the same purpose: cache it.
      system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
      messages: req.messages,
    });
    const message = await stream.finalMessage();

    if (message.stop_reason === "refusal") {
      const details = message.stop_details;
      throw new ModelOutputError(`${req.purpose}: the model declined (${details?.category ?? "no category"}).`);
    }
    if (message.stop_reason === "max_tokens") {
      throw new ModelOutputError(`${req.purpose}: output hit the ${this.maxTokens}-token limit; the document may need to be split.`);
    }
    if (message.parsed_output == null) {
      throw new ModelOutputError(`${req.purpose}: response did not match the expected schema.`);
    }
    return {
      output: message.parsed_output as T,
      assistantMessage: { role: "assistant", content: message.content },
      usage: {
        model: message.model,
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
      },
    };
  }
}

/** Scripted model for tests and offline development. Each call consumes the next handler. */
export class ScriptedModel implements LanguageModel {
  readonly calls: GenerateRequest<unknown>[] = [];
  private readonly handlers: Array<(req: GenerateRequest<unknown>) => unknown>;

  constructor(handlers: Array<(req: GenerateRequest<unknown>) => unknown>) {
    this.handlers = [...handlers];
  }

  async generate<T>(req: GenerateRequest<T>): Promise<GenerateResult<T>> {
    this.calls.push(req as GenerateRequest<unknown>);
    const handler = this.handlers.shift();
    if (!handler) throw new Error(`ScriptedModel: no response scripted for call ${this.calls.length} (${req.purpose})`);
    const output = req.schema.parse(handler(req as GenerateRequest<unknown>));
    return {
      output,
      assistantMessage: { role: "assistant", content: JSON.stringify(output) },
      usage: { model: "scripted", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
  }
}
