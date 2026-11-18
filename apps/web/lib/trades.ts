import type { Criterion, Scores, TradeOption, TradeResult } from "@vx/planning";

export const DECISION_CLASSES = ["component_selection", "processor_family", "power_architecture", "battery_chemistry",
  "board_dimensions", "layer_stackup", "connector_assignment", "mechanical", "bom_budget", "manufacturing", "other"] as const;
export const KINDS: Record<Criterion["kind"], string> = {
  lower: "lower is better", higher: "higher is better", rating: "rating 1–5 (5 best)", must: "must have (yes/no)",
};
export interface Study {
  id: string; project_id: string; study_no: number; question: string; context: string | null; stage: string; decision_class: string;
  requirement_refs: string[]; criteria: Criterion[]; options: TradeOption[]; scores: Scores; result: TradeResult | null;
  status: "draft" | "decided" | "withdrawn"; chosen_option: string | null; decision_id: string | null; decision_note: string | null;
  decided_at: string | null; created_at: string;
}
export const studyCode = (n: number) => `TS-${String(n).padStart(3, "0")}`;
export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || "x";
