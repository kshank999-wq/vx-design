"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { extractRequirements, generatePlan, planPayload, PlanValidationError, type PlanRequestPayload } from "@vx/planning";
import { fail, requireUser } from "@/lib/auth";
import { getModel } from "@/lib/model";
import { formFile } from "@/lib/staged";
import { markExtractionFailed, persistExtraction, prepareExtraction, storeDocument } from "@/lib/documents";
import { loadPlanInputs } from "@/lib/plan-inputs";

export async function uploadDocument(projectId: string, form: FormData) {
  const base = `/projects/${projectId}`, path = `${base}?tab=documents`;
  const { supabase, userId } = await requireUser();
  let file: File | null = null;
  try { file = await formFile(supabase, form, "file"); } catch (e) { fail(path, (e as Error).message); }
  if (!file) fail(path, "Choose a DOCX, PDF, Markdown or text file.");
  let stored;
  try { stored = await storeDocument(supabase, userId, projectId, file); } catch (e) { fail(path, (e as Error).message); }
  revalidatePath(base);
  redirect(`${path}&notice=${encodeURIComponent(`Uploaded ${file.name}: ${stored.sections} sections.`)}`);
}

export async function runExtraction(projectId: string, documentId: string, from?: string) {
  const path = from === "inputs" ? `/projects/${projectId}/inputs?step=1` : `/projects/${projectId}?tab=documents`;
  const { supabase } = await requireUser();
  let choice;
  try { choice = getModel(); } catch (e) { fail(path, e); }
  let prepared;
  try { prepared = await prepareExtraction(supabase, documentId); } catch (e) { fail(path, (e as Error).message); }
  try {
    const result = await extractRequirements(prepared.parsed, choice.model);
    await persistExtraction(supabase, projectId, prepared, result, choice);
  } catch (e) {
    await markExtractionFailed(supabase, documentId, (e as Error).message, choice.label);
    fail(path, `Extraction failed: ${(e as Error).message}`);
  }
  revalidatePath(path.split("?")[0]!);
  redirect(path);
}

export async function setRequirementStatus(projectId: string, requirementId: string, status: string) {
  const base = `/projects/${projectId}`, path = `${base}?tab=requirements`;
  const { supabase } = await requireUser();
  if (!["confirmed", "rejected", "extracted", "ambiguous"].includes(status)) fail(path, "Invalid status.");
  const { error } = await supabase.from("requirements").update({ status }).eq("id", requirementId);
  if (error) fail(path, error);
  revalidatePath(base);
}

/** Above this many active requirements the plan is made by a worker: the web server's request limit is 5 minutes. */
const WEB_PLAN_LIMIT = Number(process.env.VX_WEB_PLAN_MAX_REQUIREMENTS ?? 80);

/** A plan from every project input: requirements (with acceptance criteria), intake, freeze, standards, references, prior work. */
export async function createPlan(projectId: string, from?: string) {
  const path = from === "inputs" ? `/projects/${projectId}/inputs?step=5` : `/projects/${projectId}?tab=plans`;
  const { supabase } = await requireUser();
  const [{ data: project }, { data: reqs }, { data: caps }, loaded] = await Promise.all([
    supabase.from("projects").select("name, description, supervision_mode").eq("id", projectId).single(),
    supabase.from("requirements").select("ref_code, kind, priority, status, text, notes, acceptance_criteria").eq("project_id", projectId).order("ref_code"),
    supabase.from("tool_capabilities").select("tool_name, operation, status"),
    loadPlanInputs(supabase, projectId),
  ]);
  const active = (reqs ?? []).filter((r) => r.status !== "rejected");
  if (!active.length) fail(path, "Extract or add requirements before generating a plan.");
  const request: PlanRequestPayload = {
    requirements: active.map((r) => ({ refCode: r.ref_code, kind: r.kind, priority: r.priority, status: r.status, text: r.text, notes: r.notes, acceptanceCriteria: r.acceptance_criteria })),
    context: loaded.context, input_ids: loaded.inputIds, inputs: loaded.record, must_address: loaded.mustAddress,
    capabilities: (caps ?? []).map((c) => ({ toolName: c.tool_name, operation: c.operation, status: c.status })),
    supervision_mode: project?.supervision_mode ?? "guided",
  };

  // Large projects: a worker plans (it has no time limit); this page and the inputs page show progress.
  if (active.length > WEB_PLAN_LIMIT) {
    const { error } = await supabase.rpc("request_plan", { p_project: projectId, p_payload: request });
    if (error) fail(path, error);
    revalidatePath(path.split("?")[0]!);
    redirect(`${path}&notice=${encodeURIComponent(`Planning ${active.length} requirements: a worker is generating the plan. This page updates by itself and links to the plan when it is ready (usually 5 to 15 minutes).`)}`);
  }

  let choice;
  try { choice = getModel(); } catch (e) { fail(path, e); }
  let planId: string;
  try {
    const plan = await generatePlan(request.requirements, choice.model, { capabilities: request.capabilities, projectContext: request.context, inputIds: request.input_ids, mustAddress: request.must_address });
    const payload = planPayload(plan, { model: choice.label, offline: choice.offline, supervisionMode: request.supervision_mode, inputs: request.inputs });
    const { data, error } = await supabase.rpc("create_plan_version", { p_project_id: projectId, p_payload: payload });
    if (error) throw new Error(error.message);
    planId = data as string;
  } catch (e) {
    const message = e instanceof PlanValidationError
      ? `The generated plan failed validation after ${e.attempts} attempts: ${e.problems.map((p) => p.message).join("; ")}`
      : `Plan generation failed: ${(e as Error).message}`;
    fail(path, message);
  }
  redirect(`/projects/${projectId}/plans/${planId}`);
}

const INVITE_ROLES = ["client", "reviewer", "engineer", "viewer"];

export async function inviteMember(projectId: string, form: FormData) {
  const base = `/projects/${projectId}`, path = `${base}?tab=team`;
  const { supabase } = await requireUser();
  const email = String(form.get("email") ?? "").trim();
  const role = String(form.get("role") ?? "client");
  if (!INVITE_ROLES.includes(role)) fail(path, "Unknown role.");
  const { data, error } = await supabase.rpc("invite_member", { p_project_id: projectId, p_email: email, p_role: role });
  if (error) fail(path, error);
  revalidatePath(base);
  const notice = data === "added" ? `${email} already has an account and was added as ${role}.`
    : `Invitation recorded: when ${email} signs up with that address, they join as ${role}. Send them the sign-up link yourself; VX Design does not email yet.`;
  redirect(`${path}&notice=${encodeURIComponent(notice)}`);
}
