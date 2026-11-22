/**
 * Plan generation job: plans that are too large for the web server's request limit (hundreds of requirements) are
 * made here. The request carries everything the planner reads, recorded by the web app when it was asked; the plan is
 * stored as a new draft version with the same checks as a plan made on the web.
 */
import { generatePlan, planPayload, revisePlan, PlanValidationError, type LanguageModel, type PlanRequestPayload } from "@vx/planning";
import type { WorkerDb } from "./db.ts";

/** The model's full output budget (Claude Opus 5.5: 128K tokens), shared by its reasoning and the plan. */
const PLAN_MAX_TOKENS = Number(process.env.VX_PLAN_MAX_TOKENS ?? 128000);

export async function processPlanRequest(db: WorkerDb, model: { model: LanguageModel; label: string; offline: boolean }, workerId: string): Promise<number> {
  const req = await db.claimPlanRequest(workerId);
  if (!req) return 0;
  const tag = `[${workerId}] plan request ${req.id.slice(0, 8)} (${req.requirements} requirements)`;
  console.log(`${tag}: ${(req.payload as PlanRequestPayload).revise_from ? `revising plan v${(req.payload as PlanRequestPayload).revise_from!.version}` : "generating"}`);
  const p = req.payload as PlanRequestPayload;
  try {
    // An update of the latest plan when the request carries it (much less work than planning from scratch).
    const plan = p.revise_from
      ? await revisePlan(p.revise_from, p.requirements, model.model, { changes: p.changes ?? [], changedRefs: p.changed_refs ?? [], capabilities: p.capabilities,
                                                                       projectContext: p.context, inputIds: p.input_ids, mustAddress: p.must_address ?? [], maxTokens: PLAN_MAX_TOKENS })
      : await generatePlan(p.requirements, model.model, { capabilities: p.capabilities, projectContext: p.context, inputIds: p.input_ids, mustAddress: p.must_address ?? [],
                                                         maxTokens: PLAN_MAX_TOKENS });
    for (const u of plan.usage) if (u.inputTokens || u.outputTokens) await db.recordProjectCost(req.project_id, "ai_tokens", "anthropic", u.model, u.inputTokens + u.outputTokens, "tokens");
    const payload = planPayload(plan, { model: model.label, offline: model.offline, supervisionMode: p.supervision_mode, inputs: p.inputs, requestId: req.id });
    const planId = await db.completePlanRequest(req.id, workerId, payload, model.label, null);
    console.log(`${tag}: plan ${planId} with ${plan.tasks.length} tasks (${plan.attempts} attempt(s))`);
  } catch (e) {
    const message = e instanceof PlanValidationError
      ? `the generated plan failed validation after ${e.attempts} attempts: ${e.problems.slice(0, 20).map((x) => x.message).join("; ")}`
      : (e as Error).message;
    console.error(`${tag}: failed: ${message}`);
    await db.completePlanRequest(req.id, workerId, null, model.label, message);
  }
  return 1;
}
