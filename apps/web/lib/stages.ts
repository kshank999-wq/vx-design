export const STAGES = ["S0", "S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8"] as const;
export type Stage = (typeof STAGES)[number];
export const STAGE_NAME: Record<Stage, string> = {
  S0: "Intake and feasibility", S1: "Concept and industrial design", S2: "System architecture", S3: "Detailed design",
  S4: "Sourcing and DFM", S5: "Prototype packages and RFQs", S6: "Build and validation", S7: "Compliance and production",
  S8: "Lifecycle",
};
export const RISK_CATEGORIES = ["technical", "safety", "regulatory", "supply", "cost", "schedule", "requirements", "platform"] as const;
export const RISK_STATUSES = ["open", "mitigating", "accepted", "closed"] as const;

export interface StageRow {
  stage: Stage; status: "open" | "signed_off" | "reopened"; current: boolean; unlocked: boolean;
  tasks_total: number; tasks_done: number; tasks_ready: number; risks_open: number;
  blockers: { kind: string; text: string }[]; note: string | null; waived: { kind: string; text: string }[];
  signed_at: string | null; reopen_reason: string | null;
}
