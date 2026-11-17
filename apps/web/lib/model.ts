import "server-only";
import { ClaudeModel, OfflineModel, type LanguageModel } from "@vx/planning";

export interface ModelChoice {
  model: LanguageModel;
  /** Shown in the UI next to generated content. */
  label: string;
  offline: boolean;
}

/**
 * Claude when ANTHROPIC_API_KEY is set; the deterministic offline heuristic when
 * VX_LLM=offline (local development and end-to-end tests).
 */
export function getModel(): ModelChoice {
  if (process.env.VX_LLM === "offline") {
    return { model: new OfflineModel(), label: "Offline heuristic (not AI)", offline: true };
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("No model configured: set ANTHROPIC_API_KEY, or VX_LLM=offline for the offline heuristic.");
  }
  const model = new ClaudeModel();
  return { model, label: process.env.VX_PLANNING_MODEL ?? "claude-opus-5-5", offline: false };
}
