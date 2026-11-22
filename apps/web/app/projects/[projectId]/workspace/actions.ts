"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { applyPlanChange, PlanChange, type PlanTaskPayload } from "@vx/planning";
import { fail, requireUser } from "@/lib/auth";
import { askAndPost, questionProblem } from "@/lib/chat";

/** The form post used without JavaScript; with it, ChatForm streams from ./chat/route.ts instead. */
export async function sendMessage(projectId: string, view: string | null, form: FormData) {
  const path = `/projects/${projectId}/workspace${view ? `?view=${view}` : ""}`;
  const { supabase, userId } = await requireUser();
  const question = String(form.get("message") ?? "").trim();
  const problem = questionProblem(question);
  if (problem) fail(path, problem);
  const err = await askAndPost(supabase, userId, projectId, question);
  if (err) fail(path, err);
  revalidatePath(`/projects/${projectId}/workspace`);
  redirect(path);
}

/**
 * Turns a plan change the assistant proposed into a new draft plan version: a copy of the newest plan (draft or
 * approved) with the change applied, then reviewed and approved like any plan. Owners and engineers only (the
 * database enforces it). Drafting the same message twice opens the draft already made.
 */
export async function draftPlanChange(projectId: string, messageId: number) {
  const path = `/projects/${projectId}/workspace`;
  const { supabase } = await requireUser();
  const { data: msg } = await supabase.from("project_messages").select("id, author_kind, data").eq("id", messageId).eq("project_id", projectId).maybeSingle();
  const parsed = msg?.author_kind === "assistant" ? PlanChange.safeParse((msg.data as { suggested_plan_change?: unknown } | null)?.suggested_plan_change) : null;
  if (!parsed?.success) fail(path, "That message has no plan change to draft.");
  const change = parsed.data;
  const { data: already } = await supabase.from("plans").select("id").eq("project_id", projectId).eq("generator->>chat_message_id", String(messageId)).maybeSingle();
  if (already) redirect(`/projects/${projectId}/plans/${already.id}?notice=${encodeURIComponent("This change was already drafted.")}`);
  const { data: plan } = await supabase.from("plans").select("*").eq("project_id", projectId).in("status", ["draft", "awaiting_approval", "approved"])
    .order("version", { ascending: false }).limit(1).maybeSingle();
  if (!plan) fail(path, "There is no plan to change yet.");
  const { data: tasks } = await supabase.from("tasks").select("id, key, title, discipline, description, required_tools, acceptance_tests, approval_policy, risk_level, estimated_hours, basis, board")
    .eq("plan_id", plan.id).order("position");
  const ids = (tasks ?? []).map((t) => t.id);
  const [{ data: deps }, { data: reqs }] = ids.length ? await Promise.all([
    supabase.from("task_dependencies").select("task_id, depends_on_task_id").in("task_id", ids),
    supabase.from("task_requirements").select("task_id, requirements(ref_code)").in("task_id", ids),
  ]) : [{ data: [] }, { data: [] }];
  const keyOf = new Map((tasks ?? []).map((t) => [t.id, t.key]));
  const payloadTasks: PlanTaskPayload[] = (tasks ?? []).map((t) => ({
    key: t.key, title: t.title, discipline: t.discipline, description: t.description, required_tools: t.required_tools ?? [],
    acceptance_tests: t.acceptance_tests ?? [], approval_required: !!(t.approval_policy as { required?: boolean } | null)?.required,
    approval_reason: (t.approval_policy as { reason?: string | null } | null)?.reason ?? null, risk_level: t.risk_level, estimated_hours: t.estimated_hours,
    basis: t.basis ?? null, board: t.board ?? null,
    upstream_keys: (deps ?? []).filter((d) => d.task_id === t.id).map((d) => keyOf.get(d.depends_on_task_id)!).filter(Boolean).sort(),
    requirement_refs: (reqs ?? []).filter((r) => r.task_id === t.id).map((r) => (r.requirements as unknown as { ref_code: string }).ref_code).sort(),
  }));
  let changed: PlanTaskPayload[];
  try { changed = applyPlanChange(payloadTasks, change); } catch (e) { fail(path, `The change cannot be applied: ${(e as Error).message}.`); }
  const { data: newId, error } = await supabase.rpc("create_plan_version", { p_project_id: projectId, p_payload: {
    summary: plan.summary, supervision_mode: plan.supervision_mode, assumptions: plan.assumptions, deferred: plan.deferred, revised_from_id: plan.id, inputs: plan.inputs ?? [],
    generator: { ...(plan.generator as object ?? {}), revised_from_version: plan.version, chat_message_id: String(messageId), chat_change: change },
    tasks: changed,
  } });
  if (error) fail(path, error);
  revalidatePath(path);
  redirect(`/projects/${projectId}/plans/${newId}?notice=${encodeURIComponent(`Draft plan v${plan.version + 1} made from the chat: review it, then submit it for approval.`)}`);
}

export async function decideFromWorkspace(projectId: string, taskId: string, approve: boolean, form: FormData) {
  const path = `/projects/${projectId}/workspace`;
  const { supabase } = await requireUser();
  const note = String(form.get("note") ?? "").trim() || null;
  if (!approve && !note) fail(path, "Say what needs to change before returning the work.");
  const { error } = await supabase.rpc("decide_task", { p_task_id: taskId, p_approve: approve, p_note: note });
  if (error) fail(path, error);
  revalidatePath(path);
  redirect(`${path}?notice=${encodeURIComponent(approve ? "Approved. The team's next steps are unblocked." : "Returned to the team with your note.")}`);
}

/** Approves every waiting result whose VX Design checks all passed (notes allowed); anything with a failed check is left. */
export async function approvePassed(projectId: string) {
  const path = `/projects/${projectId}/workspace`;
  const { supabase } = await requireUser();
  const { data: plan } = await supabase.from("plans").select("id").eq("project_id", projectId).eq("status", "approved").maybeSingle();
  if (!plan) fail(path, "No approved plan.");
  const { data: waiting } = await supabase.from("tasks").select("id, title").eq("plan_id", plan.id).eq("status", "awaiting_approval");
  const ids = (waiting ?? []).map((t) => t.id);
  const { data: vals } = ids.length ? await supabase.from("validations").select("task_id, execution_id, result, created_at").in("task_id", ids).order("created_at", { ascending: false }) : { data: [] };
  const latest = new Map<string, string | null>();
  for (const v of vals ?? []) if (!latest.has(v.task_id)) latest.set(v.task_id, v.execution_id);
  let approved = 0;
  const held: string[] = [];
  for (const t of waiting ?? []) {
    const mine = (vals ?? []).filter((v) => v.task_id === t.id && v.execution_id === latest.get(t.id));
    if (mine.some((v) => v.result === "fail" || v.result === "error")) { held.push(t.title); continue; }
    const { error } = await supabase.rpc("decide_task", { p_task_id: t.id, p_approve: true, p_note: "Approved: every VX Design check passed." });
    if (error) held.push(`${t.title} (${error.message})`); else approved++;
  }
  revalidatePath(path);
  redirect(`${path}?notice=${encodeURIComponent(`${approved} result(s) approved; the work continues.` + (held.length ? ` Held for a closer look: ${held.join(", ")}.` : ""))}`);
}

