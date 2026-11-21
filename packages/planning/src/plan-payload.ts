import type { PlanResult } from "./plan.ts";

/** What the planner was given, as stored with a plan request and read back by the worker. */
export interface PlanRequestPayload {
  requirements: { refCode: string; kind: string; priority: string; status: string; text: string; notes?: string | null; acceptanceCriteria?: string | null }[];
  context: string;
  input_ids: string[];
  inputs: { id: string; kind: string; label: string; ref?: string }[];
  capabilities: { toolName: string; operation: string; status: string }[];
  supervision_mode: string;
}

/** A generated plan as public.create_plan_version takes it (the same shape whether the web app or a worker made it). */
export function planPayload(plan: PlanResult, opts: { model: string; offline: boolean; supervisionMode: string; inputs: unknown[]; requestId?: string }) {
  return {
    summary: plan.summary,
    supervision_mode: opts.supervisionMode,
    generator: { model: opts.model, offline: opts.offline, prompt_version: plan.promptVersion, attempts: plan.attempts, adjustments: plan.adjustments,
                 usage: plan.usage, ...(opts.requestId ? { request_id: opts.requestId } : {}) },
    assumptions: plan.assumptions,
    deferred: plan.deferred,
    inputs: opts.inputs,
    tasks: plan.tasks.map((t) => ({
      key: t.key, title: t.title, discipline: t.discipline, description: t.description ?? "", upstream_keys: t.upstreamKeys,
      requirement_refs: t.requirementRefs, required_tools: t.requiredTools, acceptance_tests: t.acceptanceTests, risk_level: t.riskLevel,
      approval_required: t.approvalRequired, approval_reason: t.approvalReason, estimated_hours: t.estimatedHours, basis: t.basis,
    })),
  };
}
