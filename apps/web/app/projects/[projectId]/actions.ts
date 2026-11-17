"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import {
  extractRequirements,
  generatePlan,
  parseDocument,
  PlanValidationError,
  UnsupportedDocumentError,
  type ParsedDocument,
} from "@vx/planning";
import { fail, requireUser } from "@/lib/auth";
import { getModel } from "@/lib/model";

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export async function uploadDocument(projectId: string, form: FormData) {
  const path = `/projects/${projectId}`;
  const { supabase, userId } = await requireUser();
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) fail(path, "Choose a DOCX, PDF, Markdown or text file.");
  if (file.size > MAX_UPLOAD_BYTES) fail(path, "File is larger than 20 MB.");

  const bytes = new Uint8Array(await file.arrayBuffer());
  let parsed: ParsedDocument;
  try {
    parsed = await parseDocument(bytes, file.type, file.name);
  } catch (e) {
    fail(path, e instanceof UnsupportedDocumentError ? e.message : `Could not read the document: ${(e as Error).message}`);
  }
  if (!parsed.sections.some((s) => s.blocks.length)) fail(path, "No text found in the document.");

  const { data: existing } = await supabase.from("documents").select("id")
    .eq("project_id", projectId).eq("sha256", parsed.sha256).maybeSingle();
  if (existing) fail(path, "This exact file is already uploaded to the project.");

  const safeName = file.name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(-120);
  const storagePath = `${projectId}/documents/${parsed.sha256.slice(0, 16)}-${safeName}`;
  const { error: upErr } = await supabase.storage.from("project-files")
    .upload(storagePath, bytes, { contentType: file.type || parsed.mimeType, upsert: false });
  if (upErr) fail(path, `Upload failed: ${upErr.message}`);

  const { error } = await supabase.from("documents").insert({
    project_id: projectId,
    kind: "specification",
    title: parsed.title ?? file.name,
    filename: file.name,
    storage_path: storagePath,
    sha256: parsed.sha256,
    size_bytes: file.size,
    mime_type: parsed.mimeType,
    parsed,
    uploaded_by: userId,
  });
  if (error) fail(path, error);
  revalidatePath(path);
  redirect(`${path}?notice=${encodeURIComponent(`Uploaded ${file.name}: ${parsed.sections.length} sections.`)}`);
}

export async function runExtraction(projectId: string, documentId: string) {
  const path = `/projects/${projectId}`;
  const { supabase } = await requireUser();
  const { data: doc, error } = await supabase.from("documents")
    .select("id, parsed, extraction_status").eq("id", documentId).single();
  if (error || !doc?.parsed) fail(path, error ?? "Document has no parsed content.");
  if (doc.extraction_status === "running") fail(path, "Extraction is already running for this document.");

  // Re-extraction replaces this document's unreviewed requirements, unless a plan uses them.
  const { data: previous } = await supabase.from("requirements")
    .select("id, status, task_requirements(task_id)").eq("document_id", documentId).eq("origin", "extracted");
  if (previous?.some((r) => (r.task_requirements as unknown[]).length)) {
    fail(path, "Requirements from this document are used by a plan; revise the plan instead of re-extracting.");
  }
  if (previous?.some((r) => r.status === "confirmed" || r.status === "rejected")) {
    fail(path, "Some requirements from this document were already reviewed; re-extraction would discard that review.");
  }

  let choice;
  try {
    choice = getModel();
  } catch (e) {
    fail(path, e);
  }
  await supabase.from("documents").update({ extraction_status: "running" }).eq("id", documentId);
  try {
    const result = await extractRequirements(doc.parsed as ParsedDocument, choice.model);

    // Continue numbering after requirements already in the project (other documents).
    const { data: existing } = await supabase.from("requirements").select("ref_code")
      .eq("project_id", projectId).neq("document_id", documentId);
    const offsets = new Map<string, number>();
    for (const { ref_code } of existing ?? []) {
      const m = /^(REQ-[A-Z]+)-(\d+)$/.exec(ref_code);
      if (m) offsets.set(m[1]!, Math.max(offsets.get(m[1]!) ?? 0, Number(m[2])));
    }
    const rows = result.requirements.map((r) => {
      const [, prefix, n] = /^(REQ-[A-Z]+)-(\d+)$/.exec(r.refCode)!;
      return {
        project_id: projectId,
        document_id: documentId,
        ref_code: `${prefix}-${String(Number(n) + (offsets.get(prefix!) ?? 0)).padStart(3, "0")}`,
        kind: r.kind,
        status: r.status,
        priority: r.priority,
        text: r.text,
        source_section: r.sectionTitle,
        source_page: r.page,
        source_excerpt: r.excerpt,
        block_id: r.blockId,
        acceptance_criteria: r.acceptanceCriteria,
        notes: r.notes,
        origin: "extracted",
      };
    });

    if (previous?.length) await supabase.from("requirements").delete().in("id", previous.map((r) => r.id));
    if (rows.length) {
      const { error: insErr } = await supabase.from("requirements").insert(rows);
      if (insErr) throw new Error(insErr.message);
    }
    await supabase.from("documents").update({
      extraction_status: "done",
      extraction_report: {
        prompt_version: result.promptVersion,
        model: choice.label,
        offline: choice.offline,
        requirements: rows.length,
        dropped: result.dropped,
        open_questions: result.openQuestions,
        usage: result.usage,
        completed_at: new Date().toISOString(),
      },
    }).eq("id", documentId);
  } catch (e) {
    await supabase.from("documents").update({
      extraction_status: "failed",
      extraction_report: { error: (e as Error).message, model: choice.label },
    }).eq("id", documentId);
    fail(path, `Extraction failed: ${(e as Error).message}`);
  }
  revalidatePath(path);
  redirect(path);
}

export async function setRequirementStatus(projectId: string, requirementId: string, status: string) {
  const path = `/projects/${projectId}`;
  const { supabase } = await requireUser();
  if (!["confirmed", "rejected", "extracted", "ambiguous"].includes(status)) fail(path, "Invalid status.");
  const { error } = await supabase.from("requirements").update({ status }).eq("id", requirementId);
  if (error) fail(path, error);
  revalidatePath(path);
}

export async function createPlan(projectId: string) {
  const path = `/projects/${projectId}`;
  const { supabase } = await requireUser();
  const [{ data: project }, { data: reqs }, { data: caps }] = await Promise.all([
    supabase.from("projects").select("name, description, supervision_mode").eq("id", projectId).single(),
    supabase.from("requirements").select("ref_code, kind, priority, status, text, notes").eq("project_id", projectId).order("ref_code"),
    supabase.from("tool_capabilities").select("tool_name, operation, status"),
  ]);
  const active = (reqs ?? []).filter((r) => r.status !== "rejected");
  if (!active.length) fail(path, "Extract or add requirements before generating a plan.");

  let choice;
  try {
    choice = getModel();
  } catch (e) {
    fail(path, e);
  }
  let planId: string;
  try {
    const plan = await generatePlan(
      active.map((r) => ({ refCode: r.ref_code, kind: r.kind, priority: r.priority, status: r.status, text: r.text, notes: r.notes })),
      choice.model,
      {
        capabilities: (caps ?? []).map((c) => ({ toolName: c.tool_name, operation: c.operation, status: c.status })),
        projectContext: `${project?.name ?? ""}${project?.description ? `: ${project.description}` : ""}`,
      },
    );
    const payload = {
      summary: plan.summary,
      supervision_mode: project?.supervision_mode ?? "guided",
      generator: {
        model: choice.label,
        offline: choice.offline,
        prompt_version: plan.promptVersion,
        attempts: plan.attempts,
        adjustments: plan.adjustments,
        usage: plan.usage,
      },
      assumptions: plan.assumptions,
      deferred: plan.deferred,
      tasks: plan.tasks.map((t) => ({
        key: t.key,
        title: t.title,
        discipline: t.discipline,
        description: t.description ?? "",
        upstream_keys: t.upstreamKeys,
        requirement_refs: t.requirementRefs,
        required_tools: t.requiredTools,
        acceptance_tests: t.acceptanceTests,
        risk_level: t.riskLevel,
        approval_required: t.approvalRequired,
        approval_reason: t.approvalReason,
        estimated_hours: t.estimatedHours,
      })),
    };
    const { data, error } = await supabase.rpc("create_plan_version", { p_project_id: projectId, p_payload: payload });
    if (error) throw new Error(error.message);
    planId = data as string;
  } catch (e) {
    const message = e instanceof PlanValidationError
      ? `The generated plan failed validation after ${e.attempts} attempts: ${e.problems.map((p) => p.message).join("; ")}`
      : `Plan generation failed: ${(e as Error).message}`;
    fail(path, message);
  }
  redirect(`${path}/plans/${planId}`);
}

const INVITE_ROLES = ["client", "reviewer", "engineer", "viewer"];

export async function inviteMember(projectId: string, form: FormData) {
  const path = `/projects/${projectId}`;
  const { supabase } = await requireUser();
  const email = String(form.get("email") ?? "").trim();
  const role = String(form.get("role") ?? "client");
  if (!INVITE_ROLES.includes(role)) fail(path, "Unknown role.");
  const { data, error } = await supabase.rpc("invite_member", { p_project_id: projectId, p_email: email, p_role: role });
  if (error) fail(path, error);
  revalidatePath(path);
  const notice = data === "added" ? `${email} already has an account and was added as ${role}.`
    : `Invitation recorded: when ${email} signs up with that address, they join as ${role}. Send them the sign-up link yourself; VX Design does not email yet.`;
  redirect(`${path}?notice=${encodeURIComponent(notice)}`);
}
