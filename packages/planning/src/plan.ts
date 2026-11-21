/**
 * Plan generation (spec §5 "Planning"): requirements -> dependency-ordered task graph.
 * The model proposes; deterministic validation decides what is acceptable.
 */
import { z } from "zod";
import { Discipline, PlannedTask, RiskLevel, ValidationKind, topologicalOrder } from "@vx/contracts";
import type { LanguageModel, Usage } from "./llm/model.ts";

export const PLAN_PROMPT_VERSION = "plan-v2";
const MAX_REPAIR_ROUNDS = 2;

export interface RequirementInput {
  refCode: string;
  kind: string;
  priority: string;
  status: string;
  text: string;
  notes?: string | null;
  acceptanceCriteria?: string | null;
}

export interface CapabilityInput {
  toolName: string;
  operation: string;
  status: string;
}

const PlanOutput = z.object({
  summary: z.string(),
  tasks: z.array(z.object({
    key: z.string().describe("Lowercase slug, unique in the plan, e.g. 'pwr-tree'"),
    title: z.string(),
    discipline: Discipline,
    description: z.string(),
    upstream_keys: z.array(z.string()),
    requirement_refs: z.array(z.string()),
    acceptance_tests: z.array(z.object({
      description: z.string(),
      method: z.enum(["validation", "calculation", "human_review"]),
      validation_kind: ValidationKind.nullable(),
    })),
    risk_level: RiskLevel,
    required_tools: z.array(z.string()),
    approval_required: z.boolean(),
    approval_reason: z.string().nullable(),
    estimated_hours: z.number().nullable(),
    basis: z.object({
      mode: z.enum(["reuse", "adapt", "replace", "new"]).describe("reuse: keep earlier work as it is and check it; adapt: start from it and change it; replace: earlier work exists but has a problem, so do it differently; new: nothing exists"),
      sources: z.array(z.string()).describe("Input ids this task builds on or replaces: PR-n register items, PW-n imports, REF-n references; empty for new"),
      reason: z.string().describe("One sentence: what is taken over and what still has to be done"),
      concerns: z.array(z.string()).describe("Problems with the earlier work (from its recorded issues or your review); empty if none"),
      alternatives: z.array(z.string()).describe("When there are concerns: alternatives to consider (exact parts or approaches) with a word on why; else empty"),
    }).nullable().optional(),
  })),
  deferred_requirements: z.array(z.object({ ref: z.string(), reason: z.string() })),
  assumptions: z.array(z.string()),
});
export type PlanOutput = z.infer<typeof PlanOutput>;

const SYSTEM = `You plan hardware product development for a small engineering team that uses KiCad, ngspice, CadQuery and part-distributor data, driven by an automated task runner.

Turn the requirements into a dependency graph of bounded tasks. Each task should produce a reviewable artifact (a decision record, calculation, schematic, board, model, report) in roughly a day or less of work.

Order the work as an experienced hardware lead would: system and component architecture first; a preliminary power budget and enclosure envelope before schematic capture; schematic before PCB stackup and layout; detailed power and thermal analysis once parts are chosen; mechanical fit after layout; then verification and manufacturing outputs. Make a task depend only on tasks whose outputs it actually needs, so independent work can run in parallel.

For each task:
- reference the requirements it satisfies (requirement_refs), and give acceptance tests a reviewer can check: name a validation_kind when a tool check (ERC, DRC, fit, simulation, BOM, DFM) applies;
- set approval_required for decisions a human must own: processor or SoC family, battery chemistry and charging, board dimensions and layer stackup, major connector assignments, and anything with high or critical risk;
- choose required_tools from the capability list where possible.

Every requirement must be covered by at least one task, or listed in deferred_requirements with a reason. Put open assumptions you relied on in assumptions.

Earlier work comes first. When the context has an earlier-work register (PR-n), most decisions are already made: parts chosen, circuits designed, boards partitioned, layout started. Plan to CONTINUE that work, not to redo it: a task about a subsystem cites the PR items it continues and says whether each is kept (reuse), changed (adapt) or replaced (replace). Do not plan a selection or trade study for something already selected unless the register records a problem with it; then say so in concerns and give alternatives (exact part numbers where you can). Every item that is selected, designed, laid out or verified must be cited by at least one task. Items stated by the owner are decisions: keep them unless they cannot work, and then explain why.

Build on what exists. The project context may list prior work (PW-n: earlier designs imported from other tools, with their parts, boards, decisions and open problems) and references (REF-n: mock-ups, sketches, drawings, datasheets). Do not plan to redo work that exists: plan to take it over, check it and finish it. For every task set basis: "reuse" when prior work or a reference is taken as it is and checked, "adapt" when it is the starting point but must change, "new" when nothing exists; cite the input ids in sources and say in reason what is taken over and what remains. Imported work is never verified: a task that reuses it still needs acceptance tests that re-establish it (ERC, DRC, fit, a review of the earlier decisions). Treat the import audit's open problems and claimed validations as work to plan, not as facts.`;

export interface PlanProblem {
  code: string;
  message: string;
}

export interface PlanResult {
  promptVersion: string;
  summary: string;
  tasks: PlannedTask[];
  deferred: { ref: string; reason: string }[];
  assumptions: string[];
  attempts: number;
  /** Fixes applied by policy rather than by the model (e.g. approval forced on critical tasks). */
  adjustments: string[];
  usage: Usage[];
}

export class PlanValidationError extends Error {
  readonly problems: PlanProblem[];
  readonly attempts: number;
  constructor(problems: PlanProblem[], attempts: number) {
    super(`plan still invalid after ${attempts} attempt(s): ${problems.map((p) => p.message).join("; ")}`);
    this.problems = problems;
    this.attempts = attempts;
  }
}

export async function generatePlan(
  requirements: RequirementInput[],
  model: LanguageModel,
  opts: { capabilities?: CapabilityInput[]; projectContext?: string; inputIds?: string[]; maxTokens?: number;
          /** Register items (selected, designed, laid out, verified) every plan must address. */
          mustAddress?: { id: string; label: string }[] } = {},
): Promise<PlanResult> {
  const inputIds = opts.inputIds ?? [];
  const active = requirements.filter((r) => r.status !== "rejected");
  const usage: Usage[] = [];
  const caps = (opts.capabilities ?? [])
    .map((c) => `- ${c.toolName}.${c.operation}: ${c.status}`).join("\n") || "- (no capability data yet)";
  const reqs = active
    .map((r) => `- ${r.refCode} [${r.kind}, ${r.priority}${r.status === "ambiguous" ? ", AMBIGUOUS" : ""}] ${r.text}` +
      `${r.acceptanceCriteria ? ` — accepted when: ${r.acceptanceCriteria}` : ""}${r.notes ? ` (open: ${r.notes})` : ""}`)
    .join("\n");
  const messages: Parameters<LanguageModel["generate"]>[0]["messages"] = [{
    role: "user",
    content: `${opts.projectContext ? `Project context:\n${opts.projectContext}\n\n` : ""}` +
      `Tool capabilities (verified tools are safe to automate; others need a manual or fallback path):\n${caps}\n\n` +
      `Requirements:\n${reqs}\n\n` +
      (active.length > 150 ? `There are ${active.length} requirements. Keep the plan readable and compact: group related requirements into one task (a task may satisfy many), keep each description to one or two sentences and each acceptance test to one line.\n\n` : "") +
      "Produce the plan.",
  }];

  for (let attempt = 1; ; attempt++) {
    const result = await model.generate({ purpose: attempt === 1 ? "generate_plan" : "repair_plan", system: SYSTEM, messages, schema: PlanOutput, maxTokens: opts.maxTokens });
    usage.push(result.usage);
    const problems = validatePlan(result.output, active.map((r) => r.refCode), inputIds, opts.mustAddress ?? []);
    if (!problems.length) {
      const { tasks, adjustments } = normalizePlan(result.output);
      return {
        promptVersion: PLAN_PROMPT_VERSION,
        summary: result.output.summary,
        tasks,
        deferred: result.output.deferred_requirements,
        assumptions: result.output.assumptions,
        attempts: attempt,
        adjustments,
        usage,
      };
    }
    if (attempt > MAX_REPAIR_ROUNDS) throw new PlanValidationError(problems, attempt);
    messages.push(result.assistantMessage, {
      role: "user",
      content: "The plan failed validation:\n" + problems.map((p) => `- ${p.message}`).join("\n") +
        "\n\nReturn the complete corrected plan.",
    });
  }
}

/** Deterministic checks. An empty list means the plan can be stored for review. */
export function validatePlan(plan: PlanOutput, requirementRefs: string[], inputIds: string[] = [], mustAddress: { id: string; label: string }[] = []): PlanProblem[] {
  const problems: PlanProblem[] = [];
  const known = new Set(requirementRefs);
  const keys = new Set<string>();

  if (!plan.tasks.length) problems.push({ code: "empty", message: "the plan has no tasks" });
  for (const t of plan.tasks) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(t.key)) problems.push({ code: "bad_key", message: `task key "${t.key}" must be a lowercase slug` });
    if (keys.has(t.key)) problems.push({ code: "duplicate_key", message: `task key "${t.key}" is used more than once` });
    keys.add(t.key);
    if (!t.acceptance_tests.length) problems.push({ code: "no_acceptance", message: `task "${t.key}" has no acceptance tests` });
    for (const ref of t.requirement_refs) {
      if (!known.has(ref)) problems.push({ code: "unknown_requirement", message: `task "${t.key}" references unknown requirement ${ref}` });
    }
    // With prior work or references to build on, every task says what it builds on, citing real inputs.
    const ids = new Set(inputIds);
    if (ids.size && !t.basis) problems.push({ code: "no_basis", message: `task "${t.key}" has no basis: say whether it reuses, adapts or starts fresh` });
    if (t.basis) {
      for (const src of t.basis.sources) if (!ids.has(src)) problems.push({ code: "unknown_source", message: `task "${t.key}" cites ${src}, which is not one of the inputs (${[...ids].join(", ") || "none"})` });
      if (t.basis.mode !== "new" && !t.basis.sources.length) problems.push({ code: "basis_without_source", message: `task "${t.key}" ${t.basis.mode}s earlier work but cites no input` });
      if (t.basis.mode === "replace" && (!(t.basis.concerns ?? []).length || !(t.basis.alternatives ?? []).length)) {
        problems.push({ code: "replace_without_reason", message: `task "${t.key}" replaces earlier work: give the concerns and at least one alternative` });
      }
    }
  }
  for (const t of plan.tasks) {
    for (const up of t.upstream_keys) {
      if (!keys.has(up)) problems.push({ code: "unknown_upstream", message: `task "${t.key}" depends on unknown task "${up}"` });
      if (up === t.key) problems.push({ code: "self_dependency", message: `task "${t.key}" depends on itself` });
    }
  }
  // The cycle check needs well-formed, unique keys with resolvable dependencies.
  if (!problems.some((p) => ["unknown_upstream", "duplicate_key", "bad_key", "self_dependency"].includes(p.code))) {
    try {
      topologicalOrder(plan.tasks.map((t) => toContract(t)));
    } catch (e) {
      problems.push({ code: "cycle", message: (e as Error).message });
    }
  }

  // Earlier work already committed to must be addressed: kept, changed or replaced, never silently ignored.
  const cited = new Set(plan.tasks.flatMap((t) => t.basis?.sources ?? []));
  const missed = mustAddress.filter((m) => !cited.has(m.id));
  if (missed.length) problems.push({ code: "prior_work_ignored", message: `earlier work not addressed by any task (cite each in the basis of the task that continues, revises or replaces it): ${missed.slice(0, 40).map((m) => `${m.id} ${m.label}`).join("; ")}${missed.length > 40 ? ` …and ${missed.length - 40} more` : ""}` });

  const covered = new Set(plan.tasks.flatMap((t) => t.requirement_refs));
  const deferred = new Set(plan.deferred_requirements.map((d) => d.ref));
  for (const d of plan.deferred_requirements) {
    if (!known.has(d.ref)) problems.push({ code: "unknown_deferred", message: `deferred requirement ${d.ref} does not exist` });
  }
  for (const ref of requirementRefs) {
    if (!covered.has(ref) && !deferred.has(ref)) {
      problems.push({ code: "uncovered", message: `requirement ${ref} is not covered by any task and not deferred` });
    }
  }
  return problems;
}

function toContract(t: PlanOutput["tasks"][number]): PlannedTask {
  return PlannedTask.parse({
    key: t.key,
    title: t.title,
    discipline: t.discipline,
    description: t.description,
    upstreamKeys: t.upstream_keys,
    requiredTools: t.required_tools,
    acceptanceTests: t.acceptance_tests.map((a, i) => ({
      id: `AT${i + 1}`,
      description: a.description,
      method: a.method,
      ...(a.validation_kind ? { validationKind: a.validation_kind } : {}),
    })),
    riskLevel: t.risk_level,
    requirementRefs: t.requirement_refs,
    approvalRequired: t.approval_required,
    approvalReason: t.approval_reason,
    estimatedHours: t.estimated_hours,
    basis: t.basis ?? null,
  });
}

/** Converts to contract tasks in dependency order and applies the approval policy. */
export function normalizePlan(plan: PlanOutput): { tasks: PlannedTask[]; adjustments: string[] } {
  const adjustments: string[] = [];
  const byKey = new Map(plan.tasks.map((t) => [t.key, toContract(t)]));
  const ordered = topologicalOrder([...byKey.values()]).map((k) => byKey.get(k)!);
  for (const t of ordered) {
    if ((t.riskLevel === "high" || t.riskLevel === "critical") && !t.approvalRequired) {
      t.approvalRequired = true;
      t.approvalReason ??= `${t.riskLevel} risk`;
      adjustments.push(`"${t.key}": approval required because risk is ${t.riskLevel}`);
    }
  }
  return { tasks: ordered, adjustments };
}
