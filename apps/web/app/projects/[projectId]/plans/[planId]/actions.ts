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
