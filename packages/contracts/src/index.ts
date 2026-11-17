/**
 * Shared, typed contracts for VX Design (spec v0.1 §6–§8).
 * These mirror the Postgres enums and tables in supabase/migrations — keep them in sync
 * (src/contracts.test.ts checks the task state machine against the SQL).
 */
import { z } from "zod";

export const ProjectRole = z.enum(["owner", "engineer", "reviewer", "viewer"]);
export const SupervisionMode = z.enum(["guided", "professional", "autonomous"]);
export const RiskLevel = z.enum(["low", "medium", "high", "critical"]);

export const Discipline = z.enum([
  "architecture", "components", "sourcing", "schematic", "pcb_layout", "power",
  "thermal", "simulation", "mechanical", "enclosure", "verification",
  "manufacturing", "documentation",
]);

export const TaskStatus = z.enum([
  "draft", "ready", "running", "validating", "awaiting_approval", "complete",
  "blocked", "failed", "canceled", "superseded",
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

/** Allowed task transitions — must match public.task_transition_allowed in SQL. */
export const TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  draft: ["ready", "canceled", "superseded"],
  ready: ["running", "blocked", "canceled", "superseded"],
  running: ["validating", "failed", "blocked", "canceled", "ready"],
  validating: ["awaiting_approval", "complete", "failed", "blocked", "ready"],
  awaiting_approval: ["complete", "ready", "blocked", "canceled"],
  blocked: ["ready", "canceled", "superseded"],
  failed: ["ready", "canceled", "superseded"],
  complete: ["superseded"],
  canceled: [],
  superseded: [],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

export const DecisionClass = z.enum([
  "component_selection", "passive_substitution", "processor_family",
  "power_architecture", "battery_chemistry", "board_dimensions", "layer_stackup",
  "connector_assignment", "mechanical", "bom_budget", "manufacturing", "other",
]);

export const EvidenceCategory = z.enum([
  "datasheet_verified", "deterministic_calculation", "simulation", "cad_check",
  "hardware_test", "unverified_assumption",
]);

export const ValidationKind = z.enum([
  "erc", "drc", "bom_check", "footprint_check", "fit_check", "simulation",
  "power_budget", "dfm", "acceptance_test", "other",
]);
export const ValidationResult = z.enum(["pass", "warning", "fail", "error"]);

export const ArtifactKind = z.enum([
  "specification", "requirements", "plan", "kicad_project", "schematic", "pcb",
  "netlist", "bom", "power_budget", "simulation", "step", "stl", "enclosure",
  "fab_package", "report", "other",
]);

export const AcceptanceTest = z.object({
  id: z.string(),
  description: z.string(),
  /** How the test is checked: a validation gate, a calculation, or human review. */
  method: z.enum(["validation", "calculation", "human_review"]),
  validationKind: ValidationKind.optional(),
});

/** Task as produced by the planner, before it is written to the database (§6). */
export const PlannedTask = z.object({
  key: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  title: z.string().min(1),
  discipline: Discipline,
  description: z.string().optional(),
  upstreamKeys: z.array(z.string()).default([]),
  requiredTools: z.array(z.string()).default([]),
  acceptanceTests: z.array(AcceptanceTest).default([]),
  riskLevel: RiskLevel.default("medium"),
  timeoutSeconds: z.number().int().positive().default(3600),
  costBudgetUsd: z.number().nonnegative().optional(),
  requirementRefs: z.array(z.string()).default([]),
});
export type PlannedTask = z.infer<typeof PlannedTask>;

/** Unattended run authorization (§7). */
export const RunAuthorization = z.object({
  mode: SupervisionMode,
  authorizedTaskIds: z.array(z.uuid()).nullable().default(null),
  allowedRiskLevels: z.array(RiskLevel).default(["low", "medium"]),
  maxAiSpendUsd: z.number().nonnegative(),
  maxComputeSpendUsd: z.number().nonnegative(),
  maxRetriesPerTask: z.number().int().nonnegative().default(2),
});
export type RunAuthorization = z.infer<typeof RunAuthorization>;

/**
 * Validates a planned task graph: unique keys, known upstream keys, no cycles.
 * Returns the keys in a valid execution order.
 */
export function topologicalOrder(tasks: readonly PlannedTask[]): string[] {
  const byKey = new Map(tasks.map((t) => [t.key, t]));
  if (byKey.size !== tasks.length) throw new Error("duplicate task keys");
  for (const t of tasks) {
    for (const up of t.upstreamKeys) {
      if (!byKey.has(up)) throw new Error(`task "${t.key}" depends on unknown task "${up}"`);
    }
  }
  const order: string[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (key: string, path: string[]): void => {
    const s = state.get(key);
    if (s === "done") return;
    if (s === "visiting") throw new Error(`dependency cycle: ${[...path, key].join(" -> ")}`);
    state.set(key, "visiting");
    for (const up of byKey.get(key)!.upstreamKeys) visit(up, [...path, key]);
    state.set(key, "done");
    order.push(key);
  };
  for (const t of tasks) visit(t.key, []);
  return order;
}
