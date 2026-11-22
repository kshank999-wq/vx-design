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
  /** Called with each piece of output text as it streams (the structured output's JSON, in order). */
  onText?: (delta: string) => void;
  /** Output budget for this call (thinking and the answer share it); defaults to the model's setting. */
  maxTokens?: number;
  /** Reasoning effort for this call; defaults to the model's setting. */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
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

export class ModelOutputError extends Error {
  /** The tokens the failed call used (it is billed), when the model ran. */
  usage?: Usage;
  constructor(message: string, usage?: Usage) { super(message); this.usage = usage; }
}

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
    const maxTokens = req.maxTokens ?? this.maxTokens;
    const stream = this.client.beta.messages.stream({
      model: this.model,
      max_tokens: maxTokens,
      // Server-side refusal fallback where the model offers it (Haiku 5.5 does not).
      ...(/haiku/.test(this.model) ? {} : { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }),
      thinking: { type: "adaptive" },
      output_config: { effort: req.effort ?? this.effort, format: betaZodOutputFormat(req.schema) },
      // The system prompt is identical across calls of the same purpose: cache it.
      system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
      messages: req.messages,
    });
    if (req.onText) stream.on("text", (delta) => req.onText!(delta));
    let message;
    try {
      message = await stream.finalMessage();
    } catch (e) {
      // A reply cut off at the token limit arrives as JSON that will not parse: say what happened.
      if (/parse structured output|Unterminated|Unexpected end of JSON/i.test((e as Error).message)) {
        throw new ModelOutputError(`${req.purpose}: the reply was cut off at the ${maxTokens}-token limit (the model's reasoning and its answer share it), so it could not be read.`);
      }
      throw e;
    }

    const usage: Usage = {
      model: message.model,
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
    };
    if (message.stop_reason === "refusal") {
      const details = message.stop_details;
      throw new ModelOutputError(`${req.purpose}: the model declined (${details?.category ?? "no category"}).`, usage);
    }
    if (message.stop_reason === "max_tokens") {
      throw new ModelOutputError(`${req.purpose}: the reply was cut off at the ${maxTokens}-token limit (the model's reasoning and its answer share it).`, usage);
    }
    if (message.parsed_output == null) {
      throw new ModelOutputError(`${req.purpose}: response did not match the expected schema.`, usage);
    }
    return {
      output: message.parsed_output as T,
      assistantMessage: { role: "assistant", content: message.content },
      usage,
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
