/**
 * Plan revision: an existing plan updated with what changed since it was made, instead of planning from scratch.
 * The model sees the current plan's tasks, the inputs, and only the requirements that are new or changed; it returns
 * just the tasks to add or change and the keys to remove. The merged plan gets the same checks as a new one (every
 * requirement covered or deferred, real inputs cited, every chosen part and committed earlier work addressed, no
 * cycles), so a revision can never leave a requirement or a part behind.
 */
import { z } from "zod";
import type { LanguageModel, Usage } from "./llm/model.ts";
import { autoFixPlan } from "./plan-autofix.ts";
import { normalizePlan, PLAN_SYSTEM, PlanOutput, PlanValidationError, validatePlan, type CapabilityInput, type PlanProblem, type PlanResult, type RequirementInput } from "./plan.ts";

export const PLAN_REVISE_PROMPT_VERSION = "plan-revise-v1";
const MAX_REPAIR_ROUNDS = 2;
type Task = PlanOutput["tasks"][number];

export interface PreviousPlan {
  version: number;
  summary: string;
  tasks: Task[];
  deferred: { ref: string; reason: string }[];
  assumptions: string[];
}

export const PlanRevision = z.object({
  summary: z.string().describe("The summary of the whole revised plan, ending with one sentence on what this revision changed and why"),
  changed_tasks: z.array(PlanOutput.shape.tasks.element).describe("Every task to add or to change, complete. A task with an existing key replaces that task; a new key adds one. Leave out tasks that stay as they are."),
  removed_tasks: z.array(z.object({ key: z.string(), reason: z.string() })).describe("Tasks the changes make unnecessary; empty if none"),
  deferred_requirements: z.array(z.object({ ref: z.string(), reason: z.string() })).describe("Newly deferred requirements only"),
  assumptions: z.array(z.string()).describe("New assumptions only"),
});
export type PlanRevision = z.infer<typeof PlanRevision>;

const REVISE = `${PLAN_SYSTEM}

You are revising an existing plan, not writing a new one. The plan below was made before the listed changes. Work the changes into it with as few edits as possible: keep every task that still holds exactly as it is (leave it out of your answer), change only the tasks the changes affect (return them complete, with the same key), add tasks for new work, and remove tasks the changes make unnecessary. New requirements must each be covered by a task (an existing task you return changed, or a new one) or deferred with a reason. Parts the team has chosen (PT-n) must each be cited in the basis of the task that uses them. Keep task keys stable so work already done stays linked.`;

const one = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
const reqLine = (r: RequirementInput) => `- ${r.refCode} [${r.kind}, ${r.priority}${r.status === "ambiguous" ? ", AMBIGUOUS" : ""}] ${one(r.text)}` +
  `${r.acceptanceCriteria ? ` — accepted when: ${one(r.acceptanceCriteria)}` : ""}${r.notes ? ` (open: ${one(r.notes)})` : ""}`;

/** The previous plan, the revision applied: removed tasks and links to them dropped, changed tasks replaced, new ones added. */
export function applyRevision(prev: PreviousPlan, rev: PlanRevision, activeRefs: string[]): { plan: PlanOutput; adjustments: string[]; summary: Omit<NonNullable<PlanResult["revision"]>, "new_requirements"> } {
  const adjustments: string[] = [];
  const live = new Set(activeRefs);
  const removed = new Map(rev.removed_tasks.map((r) => [r.key, r.reason]));
  const byKey = new Map(prev.tasks.filter((t) => !removed.has(t.key)).map((t) => [t.key, structuredClone(t)]));
  const changed: string[] = [], added: string[] = [];
  for (const t of rev.changed_tasks) {
    (byKey.has(t.key) ? changed : added).push(t.key);
    removed.delete(t.key);
    byKey.set(t.key, t);
  }
  for (const t of byKey.values()) {
    const gone = t.upstream_keys.filter((k) => !byKey.has(k));
    if (gone.length) { t.upstream_keys = t.upstream_keys.filter((k) => byKey.has(k)); adjustments.push(`"${t.key}": dropped its link to removed task(s) ${gone.join(", ")}`); }
    const old = t.requirement_refs.filter((r) => !live.has(r));
    if (old.length) { t.requirement_refs = t.requirement_refs.filter((r) => live.has(r)); adjustments.push(`"${t.key}": dropped requirement(s) no longer active: ${old.join(", ")}`); }
  }
  const covered = new Set([...byKey.values()].flatMap((t) => t.requirement_refs));
  const deferred = [...prev.deferred.filter((d) => live.has(d.ref) && !covered.has(d.ref)), ...rev.deferred_requirements]
    .filter((d, i, a) => a.findIndex((x) => x.ref === d.ref) === i);
  return {
    plan: { summary: rev.summary, tasks: [...byKey.values()], deferred_requirements: deferred, assumptions: [...prev.assumptions, ...rev.assumptions] },
    adjustments,
    summary: { from_version: prev.version, changed, added, removed: rev.removed_tasks.filter((r) => !byKey.has(r.key)) },
  };
}

export async function revisePlan(
  previous: PreviousPlan,
  requirements: RequirementInput[],
  model: LanguageModel,
  opts: { changes: string[]; changedRefs?: string[]; capabilities?: CapabilityInput[]; projectContext?: string; inputIds?: string[];
          mustAddress?: { id: string; label: string }[]; maxTokens?: number },
): Promise<PlanResult> {
  const active = requirements.filter((r) => r.status !== "rejected");
  const refs = active.map((r) => r.refCode);
  const known = new Set([...previous.tasks.flatMap((t) => t.requirement_refs), ...previous.deferred.map((d) => d.ref)]);
  const changedRefs = new Set(opts.changedRefs ?? []);
  const fresh = active.filter((r) => !known.has(r.refCode) || changedRefs.has(r.refCode));
  const usage: Usage[] = [];
  const caps = (opts.capabilities ?? []).map((c) => `- ${c.toolName}.${c.operation}: ${c.status}`).join("\n") || "- (no capability data yet)";
  const must = opts.mustAddress ?? [];
  const tasks = previous.tasks.map((t) => `TASK ${JSON.stringify(t)}`).join("\n");
  const messages: Parameters<LanguageModel["generate"]>[0]["messages"] = [{
    role: "user",
    content: `${opts.projectContext ? `Project context:\n${opts.projectContext}\n\n` : ""}` +
      `Tool capabilities:\n${caps}\n\n` +
      `What changed since plan version ${previous.version}:\n${opts.changes.length ? opts.changes.map((c) => `- ${one(c)}`).join("\n") : "- (see the project context)"}\n\n` +
      `Current plan (version ${previous.version}): ${previous.summary}\nOne task per line as JSON:\n${tasks}\n` +
      `${previous.deferred.length ? `Deferred: ${previous.deferred.map((d) => `${d.ref} (${one(d.reason)})`).join("; ")}\n` : ""}\n` +
      `Requirements that are new or changed since then (${fresh.length}; the other ${active.length - fresh.length} are already covered by the plan):\n` +
      `${fresh.length ? fresh.map(reqLine).join("\n") : "- none"}\n\n` +
      `${must.length ? `Inputs that some task must cite in its basis: ${must.map((m) => m.id).join(", ")}\n\n` : ""}` +
      "Return the revision: only the tasks to add or change (complete), the keys to remove, and new deferrals and assumptions.",
  }];
  for (let attempt = 1; ; attempt++) {
    const r = await model.generate({ purpose: attempt === 1 ? "revise_plan" : "repair_revise_plan", system: REVISE, messages, schema: PlanRevision, maxTokens: opts.maxTokens });
    usage.push(r.usage);
    const merged = applyRevision(previous, r.output, refs);
    // Tasks from a plan made before there were inputs to build on have no basis; unchanged, they start fresh.
    if ((opts.inputIds ?? []).length) for (const t of merged.plan.tasks) if (!t.basis) {
      t.basis = { mode: "new", sources: [], reason: "Kept from the previous plan; nothing earlier to build on.", concerns: [], alternatives: [] };
      merged.adjustments.push(`"${t.key}": kept as new work (no basis in the previous plan)`);
    }
    let problems: PlanProblem[] = validatePlan(merged.plan, refs, opts.inputIds ?? [], must);
    // Mechanical failures are fixed in code; the model is asked again only for what code cannot decide.
    if (problems.length) {
      const f = autoFixPlan(merged.plan, { requirements: active, inputIds: opts.inputIds ?? [], mustAddress: must });
      const left = validatePlan(f.plan, refs, opts.inputIds ?? [], must);
      if (left.length < problems.length) { merged.plan = f.plan; merged.adjustments.push(...f.fixes); problems = left; }
    }
    if (!problems.length) {
      const { tasks: ordered, adjustments } = normalizePlan(merged.plan);
      return {
        promptVersion: PLAN_REVISE_PROMPT_VERSION, summary: merged.plan.summary, tasks: ordered, deferred: merged.plan.deferred_requirements,
        assumptions: merged.plan.assumptions, attempts: attempt, adjustments: [...merged.adjustments, ...adjustments], usage,
        revision: { ...merged.summary, new_requirements: fresh.length },
      };
    }
    if (attempt > MAX_REPAIR_ROUNDS) throw new PlanValidationError(problems, attempt);
    messages.push(r.assistantMessage, { role: "user", content: "The revised plan failed validation:\n" + problems.map((p) => `- ${p.message}`).join("\n") +
      "\n\nReturn the complete corrected revision (all tasks to add or change, the keys to remove)." });
  }
}
