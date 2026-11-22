/**
 * Language-model boundary for planning. The pipeline only depends on this
 * interface, so tests can script responses and production uses Claude.
 */
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { toJSONSchema as zToJson, type z } from "zod";

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
  /**
   * "follow-up": another call with the same opening message is likely within minutes (a repair loop that usually
   * runs more than once), so the opening message is cached (written at 1.25x, read back at 0.05x) and each repair
   * round caches what it sends for the next. Leave unset for calls that usually stand alone (plans and specification
   * reading, whose mistakes are now mostly fixed in code): the cache write would rarely be read back.
   */
  cache?: "follow-up";
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

/** A message with a cache breakpoint on its last block that can carry one (thinking blocks cannot). */
function withBreakpoint(m: Anthropic.Beta.BetaMessageParam): Anthropic.Beta.BetaMessageParam {
  if (m.role !== "user" && m.role !== "assistant") return m;
  const content = m.content as string | Anthropic.Beta.BetaContentBlockParam[];
  const blocks: Anthropic.Beta.BetaContentBlockParam[] = typeof content === "string" ? [{ type: "text", text: content }] : [...content];
  if (blocks.some((b) => "cache_control" in b && b.cache_control)) return m;     // the caller placed its own
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]!;
    if (b.type === "thinking" || b.type === "redacted_thinking") continue;
    blocks[i] = { ...b, cache_control: { type: "ephemeral" } } as Anthropic.Beta.BetaContentBlockParam;
    break;
  }
  return { ...m, content: blocks } as Anthropic.Beta.BetaMessageParam;
}

/**
 * Where to cache in this call, when a follow-up is expected: the opening message, and the latest message of a repair
 * round, so the next round reads everything before it from the cache. Breakpoints a caller placed itself (the chat's
 * project context) are kept as they are.
 */
export function cacheBreakpoints(messages: Anthropic.Beta.BetaMessageParam[], cache?: "follow-up"): Anthropic.Beta.BetaMessageParam[] {
  // A call that usually stands alone writes no cache: the 25% write premium would rarely be read back.
  if (cache !== "follow-up") return messages;
  return messages.map((m, i) => ((i === 0 && cache === "follow-up") || (i === messages.length - 1 && messages.length > 1) ? withBreakpoint(m) : m));
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

  /**
   * One call, with two recoveries instead of failing the task:
   *  - a reply cut off at the token limit is asked again once with the full 128K output and one step less reasoning
   *    effort (thinking and the answer share the limit);
   *  - a schema too large for the API's constrained decoding ("compiled grammar is too large") is asked again with
   *    the JSON Schema in the instructions, and the reply is checked against the same schema here.
   * Tokens of the failed attempt are added to the usage reported, so the cost stays complete.
   */
  async generate<T>(req: GenerateRequest<T>): Promise<GenerateResult<T>> {
    let maxTokens = req.maxTokens ?? this.maxTokens;
    let effort = req.effort ?? this.effort;
    let constrained = true;
    let spent: Usage | undefined;
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await this.once(req, maxTokens, effort, constrained);
        return spent ? { ...r, usage: addUsage(spent, r.usage) } : r;
      } catch (e) {
        const u = (e as ModelOutputError).usage;
        if (u) spent = spent ? addUsage(spent, u) : u;
        if (attempt >= 2) throw withUsage(e, spent);
        if (e instanceof CutOffError && maxTokens < MAX_OUTPUT) {
          maxTokens = MAX_OUTPUT;
          effort = LOWER_EFFORT[effort];
          continue;
        }
        if (constrained && /compiled grammar is too large|schema is too complex|too many (strict|optional)/i.test((e as Error).message)) {
          constrained = false;
          continue;
        }
        throw withUsage(e, spent);
      }
    }
  }

  private async once<T>(req: GenerateRequest<T>, maxTokens: number, effort: NonNullable<ClaudeOptions["effort"]>, constrained: boolean): Promise<GenerateResult<T>> {
    const system = constrained ? req.system : `${req.system}\n\n${schemaInstructions(req.schema)}`;
    const stream = this.client.beta.messages.stream({
      model: this.model,
      max_tokens: maxTokens,
      // Server-side refusal fallback where the model offers it (Haiku 5.5 does not).
      ...(/haiku/.test(this.model) ? {} : { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }),
      thinking: { type: "adaptive" },
      output_config: constrained ? { effort, format: betaZodOutputFormat(req.schema) } : { effort },
      // The system prompt is identical across calls of the same purpose: cache it.
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: cacheBreakpoints(req.messages, req.cache),
    });
    if (req.onText) stream.on("text", (delta) => req.onText!(delta));
    let message;
    try {
      message = await stream.finalMessage();
    } catch (e) {
      // A reply cut off at the token limit arrives as JSON that will not parse: say what happened.
      if (/parse structured output|Unterminated|Unexpected end of JSON/i.test((e as Error).message)) {
        throw new CutOffError(`${req.purpose}: the reply was cut off at the ${maxTokens}-token limit (the model's reasoning and its answer share it), so it could not be read.`);
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
      throw new CutOffError(`${req.purpose}: the reply was cut off at the ${maxTokens}-token limit (the model's reasoning and its answer share it).`, usage);
    }
    let output: unknown = message.parsed_output;
    if (!constrained) {
      const text = message.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
      const parsed = req.schema.safeParse(parseJsonReply(text));
      if (!parsed.success) throw new ModelOutputError(`${req.purpose}: the reply did not match the expected format (${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}).`, usage);
      output = parsed.data;
    }
    if (output == null) {
      throw new ModelOutputError(`${req.purpose}: response did not match the expected schema.`, usage);
    }
    return {
      output: output as T,
      assistantMessage: { role: "assistant", content: message.content },
      usage,
    };
  }
}

const MAX_OUTPUT = 128000;
const LOWER_EFFORT: Record<NonNullable<ClaudeOptions["effort"]>, NonNullable<ClaudeOptions["effort"]>> = { max: "high", xhigh: "high", high: "medium", medium: "low", low: "low" };

class CutOffError extends ModelOutputError {}

function addUsage(a: Usage, b: Usage): Usage {
  return { model: b.model || a.model, inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens, cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens };
}
function withUsage(e: unknown, u: Usage | undefined): unknown {
  if (u && e instanceof ModelOutputError) e.usage = u;
  return e;
}

/** The output format, written into the instructions for a schema too large for constrained decoding. */
export function schemaInstructions(schema: z.ZodType<unknown>): string {
  return "Reply with one JSON object and nothing else (no prose, no code fences). It must match this JSON Schema exactly:\n" +
    JSON.stringify(zodToJsonSchema(schema));
}
function zodToJsonSchema(schema: z.ZodType<unknown>): unknown {
  return zToJson(schema);
}

/** The JSON object in a reply, tolerating code fences or a sentence around it. */
export function parseJsonReply(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(t); } catch { /* look for the outermost object */ }
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch { /* fall through */ } }
  return undefined;
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
