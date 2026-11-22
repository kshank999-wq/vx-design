"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { fail, requireUser } from "@/lib/auth";

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
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("submit_plan", { p_plan_id: planId });
  if (error) fail(path, error);
  revalidatePath(path);
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
    p_stop_conditions: { stop_on_failure: form.get("stop_on_failure") === "on" },
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
