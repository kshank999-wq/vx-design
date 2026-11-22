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

export const RequirementKind = z.enum([
  "functional", "electrical", "power", "mechanical", "thermal", "interface",
  "environmental", "regulatory", "manufacturing", "cost", "other",
]);
export type RequirementKind = z.infer<typeof RequirementKind>;

export const RequirementPriority = z.enum(["must", "should", "may"]);

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
export const TaskBasis = z.object({
  mode: z.enum(["reuse", "adapt", "replace", "new"]),
  sources: z.array(z.string()).default([]),
  reason: z.string().default(""),
  /** Problems found with the earlier work this task builds on or replaces. */
  concerns: z.array(z.string()).default([]),
  /** Alternatives to consider where earlier work has a problem (parts, approaches), with a word on why. */
  alternatives: z.array(z.string()).default([]),
});
export type TaskBasis = z.infer<typeof TaskBasis>;

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
  /** Human approval gate before the task's output is committed (spec §7). */
  approvalRequired: z.boolean().default(false),
  approvalReason: z.string().nullable().default(null),
  estimatedHours: z.number().nonnegative().nullable().default(null),
  /** What the task builds on: reuse or adapt prior work and references (cited by input id), or start fresh. */
  basis: TaskBasis.nullable().default(null),
  /** The circuit board this task works on (schematic, layout, board power); tasks of one board build on each other. */
  board: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).nullable().default(null),
});
export type PlannedTask = z.infer<typeof PlannedTask>;

export const RunStatus = z.enum(["pending", "running", "paused", "completed", "stopped", "failed", "canceled"]);
export type RunStatus = z.infer<typeof RunStatus>;
export const ExecutionStatus = z.enum(["queued", "running", "succeeded", "failed", "canceled", "timed_out", "interrupted"]);
export type ExecutionStatus = z.infer<typeof ExecutionStatus>;

/** What a worker is told when it renews its lease (public.heartbeat_execution). */
export const HeartbeatDirective = z.enum(["continue", "yield", "lost"]);
export type HeartbeatDirective = z.infer<typeof HeartbeatDirective>;

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

// --- RFQ manifest (M-RFQ, spec §12). Stored in rfqs.manifest; public.rfq_missing() checks the required parts. ---

export const ManufacturingCategory = z.enum([
  "bare_pcb", "pcba", "sheet_metal", "cnc", "printing_casting", "injection_molding", "silicone_overmolding",
  "displays", "battery_packs", "harnesses", "finishing_assembly", "compliance_labs",
]);
export type ManufacturingCategory = z.infer<typeof ManufacturingCategory>;

export const CATEGORY_LABEL: Record<ManufacturingCategory, string> = {
  bare_pcb: "Bare PCB", pcba: "PCB assembly (SMT) and test", sheet_metal: "Sheet metal and finishing", cnc: "CNC machining",
  printing_casting: "3D printing and urethane casting", injection_molding: "Injection molding and tooling",
  silicone_overmolding: "Silicone and overmolding", displays: "Displays and optical bonding",
  battery_packs: "Battery packs, BMS and testing", harnesses: "Harnesses and flex cables",
  finishing_assembly: "Finishing, packaging and final assembly", compliance_labs: "Compliance and environmental labs",
};

const text = (max = 2000) => z.string().trim().max(max);
export const RfqManifest = z.object({
  project_code: text(40).regex(/^[A-Za-z0-9-]*$/, "letters, digits and hyphens only").default(""),
  buyer: z.object({ company: text(200).default(""), contact_name: text(200).optional(), contact_email: text(320).optional() }).default({ company: "" }),
  classification: text(500).default(""),
  quantities: z.object({
    prototype: z.number().int().min(0).max(10_000_000).default(0),
    production: z.number().int().min(0).max(100_000_000).optional(),
    forecast_annual: z.number().int().min(0).max(1_000_000_000).optional(),
  }).default({ prototype: 0 }),
  materials: z.array(text(300)).max(30).default([]),
  finish: text(500).optional(),
  ctq_dimensions: z.array(z.object({ feature: text(200), nominal: text(60), tolerance: text(60) })).max(50).default([]),
  drawing_revision: text(40).optional(),
  standards: z.array(text(200)).max(30).default([]),
  compliance: text(1000).optional(),
  tests_inspection: text(2000).optional(),
  tooling_ownership: z.enum(["buyer", "supplier", "not_applicable", ""]).default("buyer"),
  shipping_terms: text(200).default(""),
  quote_breakdown: z.array(text(200)).max(20).default([]),
  requirement_refs: z.array(text(60)).max(200).default([]),
  notes: text(4000).optional(),
});
export type RfqManifest = z.infer<typeof RfqManifest>;

export const SharingScope = z.enum(["summary_only", "drawings", "full_design"]);
export const SHARING_SCOPE_LABEL: Record<z.infer<typeof SharingScope>, string> = {
  summary_only: "Summary only (no files)",
  drawings: "Drawings and files needed to quote",
  full_design: "Full design (needs a signed NDA with each supplier)",
};
