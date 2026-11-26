"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { fail, requireUser } from "@/lib/auth";
import { checkPlanAgainstConcepts } from "@/lib/chat";

const RISK = ["low", "medium", "high", "critical"];

export async function updateTask(projectId: string, planId: string, taskId: string, form: FormData) {
  const path = `/projects/${projectId}/plans/${planId}`;
  const { supabase } = await requireUser();
  const title = String(form.get("title") ?? "").trim();
  const risk = String(form.get("risk_level"));
  const hours = String(form.get("estimated_hours") ?? "").trim();
  if (!title) fail(path, "Task title is required.");
  if (!RISK.includes(risk)) fail(path, "Invalid risk level.");
  const approvalRequired = form.get("approval_required") === "on" || risk === "high" || risk === "critical";
  const { error } = await supabase.from("tasks").update({
    title,
    description: String(form.get("description") ?? ""),
    risk_level: risk,
    estimated_hours: hours === "" ? null : Number(hours),
    approval_policy: { required: approvalRequired, reason: String(form.get("approval_reason") ?? "").trim() || null },
  }).eq("id", taskId);
  if (error) fail(path, error);
  const stage = String(form.get("stage") ?? "");
  if (stage) {
    const { data: cur } = await supabase.from("tasks").select("stage").eq("id", taskId).single();
    if (cur && cur.stage !== stage) {
      const { error: e2 } = await supabase.rpc("set_task_stage", { p_task: taskId, p_stage: stage });
      if (e2) fail(path, e2);
    }
  }
  revalidatePath(path);
  redirect(`${path}?notice=${encodeURIComponent(`Saved "${title}".`)}#task-${taskId}`);
}

export async function submitPlan(projectId: string, planId: string) {
  const path = `/projects/${projectId}/plans/${planId}`;
  const { supabase, userId } = await requireUser();
  // The first time a plan is submitted, the agent checks it against the concepts and mock-ups. Differences hold the
  // submission so they are settled first; submitting again goes ahead.
  const { data: checked } = await supabase.from("project_messages").select("id").eq("project_id", projectId).eq("data->>concept_check_plan", planId).limit(1);
  if (!checked?.length) {
    const r = await checkPlanAgainstConcepts(supabase, userId, projectId, planId);
    if (!r.error && r.found > 0) {
      revalidatePath(path);
      redirect(`${path}?notice=${encodeURIComponent(`Not submitted yet: the agent found ${r.found} difference(s) between this plan and the concepts or mock-ups. Read them in the chat (bottom right, or the Workspace), then press "Yes, update the plan" to fix them, or submit again to go ahead as it is.`)}`);
    }
  }
  const { error } = await supabase.rpc("submit_plan", { p_plan_id: planId });
  if (error) fail(path, error);
  revalidatePath(path);
}

/**
 * The owner's one decision on a plan: "Approve this plan" (and optionally start the run on it straight away). The owner
 * approves; the AI never does. It submits the draft and approves it in one go. The first time, the design agent checks
 * the plan against the concepts and mock-ups; if it finds differences they are shown on this page and the owner chooses
 * "Approve anyway" or "Fix them in a new version". Drafts the agent made itself are not checked again, so this never loops.
 */
/** The stored review of a just-approved plan, against the plan it replaced. */
async function reviewPlanImpactAfter(supabase: Awaited<ReturnType<typeof requireUser>>["supabase"], projectId: string, planId: string) {
  const { data: stored } = await supabase.from("plan_impact_reviews").select("review").eq("plan_id", planId).maybeSingle();
  const review = stored?.review as { steps?: { key: string; redo: boolean; why: string }[] } | null;
  return { impact: review ? { kept: (review.steps ?? []).filter((s) => !s.redo).map((s) => ({ key: s.key })) } : null };
}

export async function approvePlanNow(projectId: string, planId: string, start: boolean, form?: FormData) {
  const path = `/projects/${projectId}/plans/${planId}`;
  const { supabase, userId } = await requireUser();
  const anyway = form?.get("anyway") === "1";
  const { data: plan } = await supabase.from("plans").select("id, version, status, generator").eq("id", planId).maybeSingle();
  if (!plan) fail(path, "Plan not found.");
  const fromAgent = !!(plan.generator as { chat_message_id?: string } | null)?.chat_message_id;
  if (!anyway && !fromAgent) {
    const { data: checked } = await supabase.from("project_messages").select("id").eq("project_id", projectId).eq("data->>concept_check_plan", planId).limit(1);
    if (!checked?.length) {
      const r = await checkPlanAgainstConcepts(supabase, userId, projectId, planId);
      if (!r.error && r.found > 0) {
        revalidatePath(path);
        redirect(`${path}?notice=${encodeURIComponent(`Not approved yet: the design agent found ${r.found} difference(s) with your concepts and mock-ups. They are listed at the top of this page: approve anyway, or fix them in a new version.`)}#concept-check`);
      }
    }
  }
  if (plan.status === "draft") {
    const { error } = await supabase.rpc("submit_plan", { p_plan_id: planId });
    if (error) fail(path, error);
  }
  // The run on the plan in use stops first: only one plan is worked on at a time.
  const { data: active } = await supabase.from("runs").select("id, plan_id").eq("project_id", projectId).in("status", ["pending", "running", "paused"]);
  for (const r of active ?? []) if (r.plan_id !== planId) await supabase.rpc("control_run", { p_run_id: r.id, p_action: "cancel" });
  const { error } = await supabase.rpc("decide_plan", { p_plan_id: planId, p_approve: true, p_note: "Approved by the project owner." });
  if (error) {
    if (/running tasks/.test(error.message)) fail(path, "The current run is still finishing a step. It has been told to stop: press Approve again in a minute.");
    fail(path, error);
  }
  // Steps the design agent found unaffected keep their finished work (unless the owner ticked "redo anyway").
  const { impact } = await reviewPlanImpactAfter(supabase, projectId, planId);
  const forced = (form?.getAll("redo") ?? []).map(String);
  const keep = (impact?.kept ?? []).map((k) => k.key).filter((k) => !forced.includes(k));
  if (keep.length) await supabase.rpc("keep_finished_work", { p_plan: planId, p_keys: keep, p_reason: "The design agent found the plan change does not affect this step." });
  revalidatePath(`/projects/${projectId}`, "layout");
  if (!start) redirect(`${path}?notice=${encodeURIComponent(`Plan v${plan.version} approved: it is the plan in use now. Start the run below when you are ready.`)}#start-run`);
  // Start the run with the settings of the last run (budget, supervision, risk levels, overnight).
  const { data: last } = await supabase.from("runs").select("mode, max_ai_spend_usd, max_compute_spend_usd, allowed_risk_levels, max_retries_per_task, stop_conditions")
    .eq("project_id", projectId).order("created_at", { ascending: false }).limit(1).maybeSingle();
  const { data: runId, error: e2 } = await supabase.rpc("authorize_run", {
    p_plan_id: planId, p_mode: last?.mode ?? "guided", p_max_ai_spend_usd: Number(last?.max_ai_spend_usd ?? 25),
    p_max_compute_spend_usd: Number(last?.max_compute_spend_usd ?? 10), p_allowed_risk_levels: last?.allowed_risk_levels ?? ["low", "medium", "high"],
    p_max_retries_per_task: last?.max_retries_per_task ?? 2, p_task_ids: null, p_stop_conditions: last?.stop_conditions ?? {}, p_name: `Run on plan v${plan.version}`,
  });
  if (e2) fail(path, e2);
  redirect(`/projects/${projectId}/runs/${runId}?notice=${encodeURIComponent(`Plan v${plan.version} approved and its run started. Finished steps that did not change are reused.`)}`);
}

/** Removes a draft nobody will approve (for example one made before a newer plan was approved). */
export async function discardPlan(projectId: string, planId: string) {
  const path = `/projects/${projectId}/plans/${planId}`;
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("discard_plan_draft", { p_plan: planId });
  if (error) fail(path, error);
  revalidatePath(`/projects/${projectId}`, "layout");
  redirect(`/projects/${projectId}?tab=plans&notice=${encodeURIComponent("The out-of-date draft was discarded.")}`);
}

export async function decidePlan(projectId: string, planId: string, approve: boolean, form: FormData) {
  const path = `/projects/${projectId}/plans/${planId}`;
  const { supabase } = await requireUser();
  const note = String(form.get("note") ?? "").trim() || null;
  if (!approve && !note) fail(path, "Say what needs to change when returning a plan.");
  const { error } = await supabase.rpc("decide_plan", { p_plan_id: planId, p_approve: approve, p_note: note });
  if (error) fail(path, error);
  revalidatePath(path);
  redirect(`${path}?notice=${encodeURIComponent(approve ? "Plan approved: it is now the project baseline." : "Plan returned to draft.")}`);
}

export async function revisePlan(projectId: string, planId: string) {
  const path = `/projects/${projectId}/plans/${planId}`;
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc("revise_plan", { p_plan_id: planId });
  if (error) fail(path, error);
  redirect(`/projects/${projectId}/plans/${data}?notice=${encodeURIComponent("New draft created from this plan.")}`);
}

const MODES = ["guided", "professional", "autonomous"];

export async function authorizeRun(projectId: string, planId: string, form: FormData) {
  const path = `/projects/${projectId}/plans/${planId}`;
  const { supabase } = await requireUser();
  const mode = String(form.get("mode"));
  const ai = Number(form.get("max_ai_spend_usd"));
  const compute = Number(form.get("max_compute_spend_usd"));
  const retries = Number(form.get("max_retries_per_task"));
  const risks = form.getAll("risk").map(String).filter((r) => RISK.includes(r));
  if (!MODES.includes(mode)) fail(path, "Choose a supervision mode.");
  if (!(ai >= 0) || !(compute >= 0)) fail(path, "Budgets must be zero or more dollars.");
  if (!Number.isInteger(retries) || retries < 0 || retries > 5) fail(path, "Retries per task must be between 0 and 5.");
  if (!risks.length) fail(path, "Allow at least one risk level.");
  const { data, error } = await supabase.rpc("authorize_run", {
    p_plan_id: planId,
    p_mode: mode,
    p_max_ai_spend_usd: ai,
    p_max_compute_spend_usd: compute,
    p_allowed_risk_levels: risks,
    p_max_retries_per_task: retries,
    p_task_ids: null,
    p_stop_conditions: { stop_on_failure: form.get("stop_on_failure") === "on", auto_approve: form.get("auto_approve") === "on" },
    p_name: String(form.get("name") ?? "").trim() || null,
  });
  if (error) fail(path, error);
  redirect(`/projects/${projectId}/runs/${data}?notice=${encodeURIComponent("Run authorized. A worker will pick it up; you can close this page.")}`);
}

/** Runs a reused task (and the reused work after it) afresh. */
export async function redoTask(projectId: string, planId: string, taskId: string) {
  const path = `/projects/${projectId}/plans/${planId}`;
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc("redo_task", { p_task_id: taskId });
  if (error) fail(path, error);
  revalidatePath(path);
  redirect(`${path}?notice=${encodeURIComponent(`${data} task(s) will run again in the next run.`)}#task-${taskId}`);
}
