import "server-only";
import { ClaudeModel, MeteredModel, OfflineModel, type AiCallSink, type LanguageModel } from "@vx/planning";
import { createClient } from "@/lib/supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface ModelChoice {
  model: LanguageModel;
  /** Shown in the UI next to generated content. */
  label: string;
  offline: boolean;
}

/** Records each AI call for the project under the signed-in member (see record_ai_call). */
export function projectCostSink(projectId: string): AiCallSink {
  return async (e) => {
    const supabase = await createClient();
    const { error } = await supabase.rpc("record_ai_call", {
      p_project: projectId, p_execution: null, p_purpose: e.purpose, p_model: e.usage.model,
      p_input: e.usage.inputTokens, p_output: e.usage.outputTokens, p_cache_read: e.usage.cacheReadTokens, p_cache_write: e.usage.cacheWriteTokens,
      p_cost_usd: e.costUsd, p_duration_ms: e.durationMs, p_failed: e.failed,
    });
    if (error) throw new Error(error.message);
  };
}

/**
 * Claude when ANTHROPIC_API_KEY is set; the deterministic offline heuristic when VX_LLM=offline (local development and
 * end-to-end tests). With a project, every call is priced and recorded against it.
 */
export function getModel(projectId?: string): ModelChoice {
  const meter = (m: LanguageModel) => (projectId ? new MeteredModel(m, projectCostSink(projectId)) : m);
  if (process.env.VX_LLM === "offline") {
    return { model: meter(new OfflineModel()), label: "Offline heuristic (not AI)", offline: true };
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("No model configured: set ANTHROPIC_API_KEY, or VX_LLM=offline for the offline heuristic.");
  }
  return { model: meter(new ClaudeModel()), label: process.env.VX_PLANNING_MODEL ?? "claude-opus-5-5", offline: false };
}

/** Models a project can read its specifications and datasheets with, cheapest last. */
export const READING_MODELS: [string, string][] = [
  ["claude-opus-5-5", "Claude Opus 5.5 ($4 / $20 per million tokens)"],
  ["claude-sonnet-5-5", "Claude Sonnet 5.5 ($2 / $10)"],
  ["claude-haiku-5-5", "Claude Haiku 5.5 ($0.10 / $0.50)"],
];

/** A given Claude model, metered for the project; purposes get a prefix (e.g. "compare:") to tell such calls apart. */
export function modelFor(projectId: string, model: string, prefix = ""): ModelChoice {
  if (process.env.VX_LLM === "offline") {
    return { model: new MeteredModel(new OfflineModel(), withPrefix(projectCostSink(projectId), prefix)), label: `Offline heuristic (stand-in for ${model})`, offline: true };
  }
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("No model configured: set ANTHROPIC_API_KEY, or VX_LLM=offline for the offline heuristic.");
  return { model: new MeteredModel(new ClaudeModel({ model }), withPrefix(projectCostSink(projectId), prefix)), label: model, offline: false };
}
const withPrefix = (sink: AiCallSink, prefix: string): AiCallSink => (prefix ? (e) => sink({ ...e, purpose: `${prefix}${e.purpose}` }) : sink);

/** The model the project reads specifications and datasheets with (its setting, else the planning model). */
export async function getReadingModel(supabase: SupabaseClient, projectId: string): Promise<ModelChoice> {
  const { data } = await supabase.from("projects").select("reading_model").eq("id", projectId).maybeSingle();
  return data?.reading_model ? modelFor(projectId, data.reading_model) : getModel(projectId);
}
