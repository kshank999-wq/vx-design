"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { fail, requireUser } from "@/lib/auth";
import { askAndPost } from "@/lib/chat";

const ACTIONS = ["pause", "resume", "cancel"] as const;
const DONE: Record<string, string> = { pause: "Paused: running steps finish, then work stops.", resume: "Resumed.", cancel: "Canceled. In-flight work stops at its next checkpoint." };

export async function controlRun(projectId: string, runId: string, action: string) {
  const path = `/projects/${projectId}/runs/${runId}`;
  const { supabase } = await requireUser();
  if (!ACTIONS.includes(action as never)) fail(path, "Unknown action.");
  const { error } = await supabase.rpc("control_run", { p_run_id: runId, p_action: action });
  if (error) fail(path, error);
  revalidatePath(path);
  redirect(`${path}?notice=${encodeURIComponent(DONE[action]!)}`);
}

export async function decideTask(projectId: string, runId: string, taskId: string, approve: boolean, form: FormData) {
  const path = `/projects/${projectId}/runs/${runId}`;
  const { supabase } = await requireUser();
  const note = String(form.get("note") ?? "").trim() || null;
  if (!approve && !note) fail(path, "Say what needs to change before returning the task.");
  const { error } = await supabase.rpc("decide_task", { p_task_id: taskId, p_approve: approve, p_note: note });
  if (error) fail(path, error);
  revalidatePath(path);
  redirect(`${path}?notice=${encodeURIComponent(approve ? "Approved: outputs committed and downstream tasks unblocked." : "Returned for rework with your note.")}`);
}

/** Start a new run of the same plan with the same limits (e.g. after approving gated tasks). */
export async function continueRun(projectId: string, runId: string, form?: FormData) {
  const path = `/projects/${projectId}/runs/${runId}`;
  const { supabase } = await requireUser();
  const { data: run, error: e1 } = await supabase.from("runs").select("*").eq("id", runId).single();
  if (e1 || !run) fail(path, e1 ?? "Run not found.");
  const base = String(run.name ?? "Run").replace(/ \(continued( \d+)?\)$/, "");
  const { data, error } = await supabase.rpc("authorize_run", {
    p_plan_id: run.plan_id,
    p_mode: run.mode,
    // The new run's AI budget can be raised here (never below the previous run's).
    p_max_ai_spend_usd: Math.max(Number(run.max_ai_spend_usd), Number(form?.get("ai") ?? 0) || 0),
    p_max_compute_spend_usd: run.max_compute_spend_usd,
    p_allowed_risk_levels: run.allowed_risk_levels,
    p_max_retries_per_task: run.max_retries_per_task,
    p_task_ids: run.authorized_task_ids,
    p_stop_conditions: run.stop_conditions,
    p_name: `${base} (continued)`,
  });
  if (error) fail(path, error);
  redirect(`/projects/${projectId}/runs/${data}?notice=${encodeURIComponent("New run authorized with the same limits.")}`);
}

/** Raises a run's AI and compute budget; a run stopped only by its budget resumes. */
export async function raiseBudget(projectId: string, runId: string, form: FormData) {
  const path = `/projects/${projectId}/runs/${runId}`;
  const { supabase } = await requireUser();
  const ai = Number(form.get("ai")), compute = Number(form.get("compute"));
  if (!Number.isFinite(ai) || !Number.isFinite(compute)) fail(path, "Give both budgets in dollars.");
  const { data, error } = await supabase.rpc("raise_run_budget", { p_run: runId, p_ai: ai, p_compute: compute });
  if (error) fail(path, error);
  revalidatePath(path);
  redirect(`${path}?notice=${encodeURIComponent(`Budget raised to $${ai} AI and $${compute} compute${data === "running" ? "; the run continues." : "."}`)}`);
}

/** Continues this run (not a new one): reopened with the budget and overnight setting given; waiting results are approved when overnight is on. */
export async function continueThisRun(projectId: string, runId: string, form: FormData) {
  const path = `/projects/${projectId}/runs/${runId}`;
  const { supabase } = await requireUser();
  const auto = form.get("auto_approve") === "on";
  const { data, error } = await supabase.rpc("continue_run", { p_run: runId, p_ai: Number(form.get("ai")) || 0, p_auto_approve: auto,
    p_retry_failed: form.get("retry_failed") !== "off", p_include_critical: form.get("include_critical") === "on",
    p_compute: Number(form.get("compute")) || null });
  if (error) fail(path, error);
  revalidatePath(path);
  redirect(`${path}?notice=${encodeURIComponent(`The run continues${auto ? " straight through: results whose checks pass are approved automatically" : ""}.` +
    (Number(data) ? ` ${data} waiting result(s) approved.` : ""))}`);
}

export async function setAutoApprove(projectId: string, runId: string, on: boolean) {
  const path = `/projects/${projectId}/runs/${runId}`;
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("set_run_auto_approve", { p_run: runId, p_on: on });
  if (error) fail(path, error);
  revalidatePath(path);
  redirect(`${path}?notice=${encodeURIComponent(on ? "Running straight through: results whose checks pass are approved automatically." : "Stopping for approvals again.")}`);
}

/**
 * The run page's chat: a message to the design agent, optionally about one step. Guidance about a step is saved
 * with it (its next attempt reads it, as it reads a reviewer's notes), and the agent replies in the project chat.
 */
export async function sendRunGuidance(projectId: string, runId: string, form: FormData) {
  const path = `/projects/${projectId}/runs/${runId}`;
  const { supabase, userId } = await requireUser();
  const message = String(form.get("message") ?? "").trim();
  const taskId = String(form.get("task") ?? "") || null;
  if (message.length < 2) fail(`${path}#run-chat`, "Write a message first.");
  let about = "";
  if (taskId) {
    const { data: t } = await supabase.from("tasks").select("key, title").eq("id", taskId).maybeSingle();
    if (!t) fail(path, "That step was not found.");
    const { error } = await supabase.rpc("add_task_guidance", { p_task: taskId, p_note: message });
    if (error) fail(path, error);
    about = `Guidance for the step "${t.title}" (${t.key}), saved for its next attempt: `;
  }
  const err = await askAndPost(supabase, userId, projectId, `${about}${message}`.slice(0, 4000));
  revalidatePath(path);
  redirect(`${path}?notice=${encodeURIComponent(taskId ? "Saved: the step's next attempt will follow your guidance. Continue the run when you are ready." : "Sent.")}${err ? `&error=${encodeURIComponent(err)}` : ""}#run-chat`);
}

/** "Try again" on one step: it goes back to the queue with a fresh retry allowance, and the run continues. */
export async function retryStepAndContinue(projectId: string, runId: string, taskId: string) {
  const path = `/projects/${projectId}/runs/${runId}`;
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("retry_step", { p_task: taskId });
  if (error) fail(path, error);
  const { data: run } = await supabase.from("runs").select("stop_conditions").eq("id", runId).single();
  const { error: e2 } = await supabase.rpc("continue_run", { p_run: runId, p_ai: 0, p_auto_approve: !!(run?.stop_conditions as { auto_approve?: boolean } | null)?.auto_approve,
    p_retry_failed: false, p_include_critical: false, p_compute: null });
  if (e2 && !/another run of this plan is active/.test(e2.message)) fail(path, e2);
  revalidatePath(path);
  redirect(`${path}?notice=${encodeURIComponent("Trying that step again: the run is going.")}`);
}

/** Guidance written under a step's card: saved with the step, answered by the agent, and optionally tried again at once. */
export async function guideStep(projectId: string, runId: string, taskId: string, form: FormData) {
  const path = `/projects/${projectId}/runs/${runId}`;
  const { supabase, userId } = await requireUser();
  const note = String(form.get("note") ?? "").trim();
  if (note.length < 2) fail(path, "Write the guidance first.");
  const { data: t } = await supabase.from("tasks").select("key, title, status, blocker_reason").eq("id", taskId).maybeSingle();
  if (!t) fail(path, "That step was not found.");
  const { error } = await supabase.rpc("add_task_guidance", { p_task: taskId, p_note: note });
  if (error) fail(path, error);
  await askAndPost(supabase, userId, projectId, `Guidance for the step "${t.title}" (${t.key}), saved for its next attempt: ${note}`.slice(0, 4000));
  if (form.get("then") === "retry" && (t.status === "failed" || (t.status === "blocked" && /^interrupted /.test(t.blocker_reason ?? "")))) {
    await retryStepAndContinue(projectId, runId, taskId);
  }
  revalidatePath(path);
  redirect(`${path}?guide=${t.key}&notice=${encodeURIComponent("Guidance saved: the step's next attempt follows it.")}#issue-${t.key}`);
}

export async function deferStep(projectId: string, runId: string, taskId: string, form: FormData) {
  const path = `/projects/${projectId}/runs/${runId}`;
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("defer_step", { p_task: taskId, p_note: String(form.get("note") ?? "") });
  if (error) fail(path, error);
  revalidatePath(path);
  redirect(`${path}?notice=${encodeURIComponent("Saved for later: continuing the run leaves it alone until you bring it back.")}`);
}

export async function undeferStep(projectId: string, runId: string, taskId: string) {
  const path = `/projects/${projectId}/runs/${runId}`;
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("undefer_step", { p_task: taskId });
  if (error) fail(path, error);
  revalidatePath(path);
  redirect(`${path}?notice=${encodeURIComponent("Brought back: it is in the list again.")}`);
}

/** "Skip this step": done without its result, so the steps after it can run. Undone by "Try again". */
export async function skipStep(projectId: string, runId: string, taskId: string, form: FormData) {
  const path = `/projects/${projectId}/runs/${runId}`;
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("skip_step", { p_task: taskId, p_note: String(form.get("note") ?? "") });
  if (error) fail(path, error);
  const { data: run } = await supabase.from("runs").select("stop_conditions, status").eq("id", runId).single();
  if (run && !["pending", "running", "paused"].includes(run.status)) {
    await supabase.rpc("continue_run", { p_run: runId, p_ai: 0, p_auto_approve: !!(run.stop_conditions as { auto_approve?: boolean } | null)?.auto_approve,
      p_retry_failed: false, p_include_critical: false, p_compute: null });
  }
  revalidatePath(path);
  redirect(`${path}?notice=${encodeURIComponent("On hold: the steps after it carry on without its result. Press “Do it now” under On hold when it can be done.")}`);
}

/** A step that ran out of its own AI limit: raise just that step's limit and try it again. */
export async function raiseStepBudget(projectId: string, runId: string, taskId: string, form: FormData) {
  const path = `/projects/${projectId}/runs/${runId}`;
  const { supabase } = await requireUser();
  const usd = Number(form.get("usd"));
  const { error } = await supabase.rpc("set_step_budget", { p_task: taskId, p_usd: usd });
  if (error) fail(path, error);
  await retryStepAndContinue(projectId, runId, taskId);
}

/**
 * "Restart this run" on any run that is not going: it picks up where it stopped (steps that could not finish are tried
 * again; saved-for-later steps are left alone). Another run of the same plan that is still going is stopped first,
 * since only one run of a plan works at a time; its finished work is kept. A canceled or failed run starts again as a
 * new run with the same settings.
 */
export async function restartRun(projectId: string, runId: string) {
  const path = `/projects/${projectId}/runs/${runId}`;
  const { supabase } = await requireUser();
  const { data: run } = await supabase.from("runs").select("id, plan_id, status, stop_conditions").eq("id", runId).single();
  if (!run) fail(path, "Run not found.");
  if (["canceled", "failed"].includes(run.status)) return continueRun(projectId, runId);
  if (["pending", "running", "paused"].includes(run.status)) redirect(`${path}?notice=${encodeURIComponent("This run is already going.")}`);
  const { data: others } = await supabase.from("runs").select("id").eq("plan_id", run.plan_id).neq("id", runId).in("status", ["pending", "running", "paused"]);
  for (const o of others ?? []) {
    const { error } = await supabase.rpc("control_run", { p_run_id: o.id, p_action: "cancel" });
    if (error) fail(path, error);
  }
  const { error } = await supabase.rpc("continue_run", { p_run: runId, p_ai: 0,
    p_auto_approve: !!(run.stop_conditions as { auto_approve?: boolean } | null)?.auto_approve,
    p_retry_failed: true, p_include_critical: false, p_compute: null });
  if (error) fail(path, error);
  revalidatePath(path);
  redirect(`${path}?notice=${encodeURIComponent((others ?? []).length ? "Restarted here. The other run was stopped; its finished work is kept." : "Restarted: the run picks up where it stopped.")}`);
}
