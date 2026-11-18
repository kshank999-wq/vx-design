"use server";
import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { suggestCompliance } from "@vx/planning";
import { fail, requireUser } from "@/lib/auth";
import { formFile } from "@/lib/staged";
import { POLICIES, uploadProblem } from "@/lib/uploads";

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const base = (projectId: string) => `/projects/${projectId}/compliance`;
function go(projectId: string, notice: string): never {
  revalidatePath(base(projectId));
  redirect(`${base(projectId)}?notice=${encodeURIComponent(notice)}`);
}

async function suggestionsFor(projectId: string) {
  const { supabase } = await requireUser();
  const [{ data: intake }, { data: items }] = await Promise.all([
    supabase.from("project_intake").select("*").eq("project_id", projectId).maybeSingle(),
    supabase.from("compliance_items").select("suggestion_key").eq("project_id", projectId),
  ]);
  const have = new Set((items ?? []).map((i) => i.suggestion_key));
  return { supabase, todo: suggestCompliance(intake ?? {}).suggestions.filter((s) => !have.has(s.key)) };
}

/** Adds one suggestion (form field "key"), or every suggestion not yet on the list when no key is given. */
export async function addSuggested(projectId: string, form: FormData) {
  const { supabase, todo } = await suggestionsFor(projectId);
  const key = str(form, "key");
  const pick = key ? todo.filter((s) => s.key === key) : todo;
  if (!pick.length) go(projectId, "Nothing new to add.");
  for (const s of pick) {
    const { error } = await supabase.rpc("add_compliance_item", { p_project: projectId, p_title: s.title, p_market: s.market, p_standards: s.standards,
      p_basis: s.note ? `${s.basis}. ${s.note}` : s.basis, p_suggestion_key: s.key });
    if (error) fail(base(projectId), error);
  }
  go(projectId, pick.length === 1 ? `Added: ${pick[0]!.title}.` : `${pick.length} items added. Confirm each with your test lab.`);
}

export async function addItem(projectId: string, form: FormData) {
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("add_compliance_item", { p_project: projectId, p_title: str(form, "title"), p_market: str(form, "market"),
    p_standards: str(form, "standards").split(/[;\n]/).map((s) => s.trim()).filter(Boolean), p_basis: str(form, "basis") || null, p_suggestion_key: null });
  if (error) fail(base(projectId), error);
  go(projectId, "Item added.");
}

export async function setStatus(projectId: string, itemId: string, form: FormData) {
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("set_compliance_status", { p_item: itemId, p_status: str(form, "status"),
    p_lab_name: str(form, "lab_name") || null, p_note: str(form, "note") || null });
  if (error) fail(base(projectId), error);
  go(projectId, "Status updated.");
}

export async function markNotApplicable(projectId: string, itemId: string, form: FormData) {
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("mark_compliance_not_applicable", { p_item: itemId, p_reason: str(form, "reason") });
  if (error) fail(base(projectId), error);
  go(projectId, "Marked not applicable, with the reason recorded.");
}

/** The lab's report is checked like any document upload, stored in the item's folder, then the result is recorded. */
export async function recordResult(projectId: string, itemId: string, form: FormData) {
  const path = base(projectId);
  const { supabase } = await requireUser();
  let file: File | null = null;
  try { file = await formFile(supabase, form, "report"); } catch (e) { fail(path, (e as Error).message); }
  if (!file) fail(path, "Attach the lab's report.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const refused = uploadProblem(file.name, bytes, POLICIES.document);
  if (refused) fail(path, refused);
  const sha = createHash("sha256").update(bytes).digest("hex");
  const storagePath = `${projectId}/compliance/${itemId}/${sha.slice(0, 12)}-${file.name.replace(/[^\w.-]+/g, "_").slice(-100)}`;
  const up = await supabase.storage.from("project-files").upload(storagePath, bytes, { contentType: file.type || "application/octet-stream", upsert: false });
  if (up.error && !/exists|duplicate/i.test(up.error.message)) fail(path, `The report could not be stored: ${up.error.message}`);
  const { error } = await supabase.rpc("record_compliance_result", {
    p_item: itemId, p_outcome: str(form, "outcome"), p_lab_name: str(form, "lab_name"), p_lab_reference: str(form, "lab_reference") || null,
    p_certificate_ref: str(form, "certificate_ref") || null, p_result_date: str(form, "result_date") || null, p_expires_on: str(form, "expires_on") || null,
    p_tested_release: str(form, "tested_release") || null, p_report_name: file.name, p_report_path: storagePath, p_report_sha256: sha,
    p_report_size: bytes.length, p_notes: str(form, "notes") || null,
  });
  if (error) fail(path, error);
  go(projectId, `Lab result recorded (${str(form, "outcome")}).`);
}
