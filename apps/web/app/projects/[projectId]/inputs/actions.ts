"use server";
import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { extractRequirements } from "@vx/planning";
import { fail, requireUser } from "@/lib/auth";
import { getModel } from "@/lib/model";
import { formFile } from "@/lib/staged";
import { POLICIES, uploadProblem } from "@/lib/uploads";
import { markExtractionFailed, persistExtraction, prepareExtraction, storeDocument, type PreparedExtraction } from "@/lib/documents";
import { REFERENCE_KINDS } from "@/lib/plan-inputs";

const base = (projectId: string) => `/projects/${projectId}/inputs`;
const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
function go(path: string, notice: string): never {
  revalidatePath(path);
  redirect(`${path}?notice=${encodeURIComponent(notice)}`);
}
export interface UploadOutcome { ok: boolean; message: string }

/** One staged file (see StagedFileInput / InputsUpload) as a File, removing the staged copy. */
async function staged(supabase: Awaited<ReturnType<typeof requireUser>>["supabase"], ref: string, name: string, type: string) {
  const f = new FormData();
  f.set("file__staged", ref); f.set("file__name", name); f.set("file__type", type);
  return formFile(supabase, f, "file");
}

/** A specification staged by the browser: checked, parsed and stored like an ordinary upload. */
export async function addSpecification(projectId: string, ref: string, name: string, type: string): Promise<UploadOutcome> {
  const { supabase, userId } = await requireUser();
  try {
    const file = await staged(supabase, ref, name, type);
    if (!file) return { ok: false, message: `${name}: the file did not arrive; choose it again.` };
    const r = await storeDocument(supabase, userId, projectId, file);
    revalidatePath(base(projectId));
    return { ok: true, message: `${name}: ${r.sections} sections` };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

/**
 * Extracts requirements from every document not yet extracted (or whose extraction failed). The model reads them at
 * the same time; the results are stored one after another so requirement numbers continue across documents.
 */
export async function extractAll(projectId: string) {
  const path = base(projectId);
  const { supabase } = await requireUser();
  let choice;
  try { choice = getModel(); } catch (e) { fail(path, e); }
  const { data: docs } = await supabase.from("documents").select("id, title, extraction_status").eq("project_id", projectId).in("extraction_status", ["pending", "failed"]).order("created_at");
  if (!docs?.length) fail(path, "Every document has been extracted. Re-extract one from its row if it changed.");
  const ready: PreparedExtraction[] = [];
  const problems: string[] = [];
  for (const d of docs) {
    try { ready.push(await prepareExtraction(supabase, d.id)); } catch (e) { problems.push((e as Error).message); }
  }
  const results = await Promise.allSettled(ready.map((p) => extractRequirements(p.parsed, choice.model)));
  let total = 0, done = 0;
  for (const [i, r] of results.entries()) {
    const p = ready[i]!;
    try {
      if (r.status === "rejected") throw r.reason as Error;
      total += await persistExtraction(supabase, projectId, p, r.value, choice);
      done++;
    } catch (e) {
      await markExtractionFailed(supabase, p.id, (e as Error).message, choice.label);
      problems.push(`${p.title}: ${(e as Error).message}`);
    }
  }
  revalidatePath(path);
  const msg = `Extracted ${total} requirement(s) from ${done} document(s).${problems.length ? ` Not extracted: ${problems.join(" | ")}` : ""}`;
  if (problems.length && !done) fail(path, msg);
  redirect(`${path}?notice=${encodeURIComponent(msg)}`);
}

/** A mock-up, sketch, drawing or prior-work file staged by the browser: checked, stored under references/ and numbered. */
export async function addReference(projectId: string, ref: string, name: string, type: string, kind: string, title: string, note: string): Promise<UploadOutcome> {
  const { supabase } = await requireUser();
  try {
    if (!REFERENCE_KINDS.some(([k]) => k === kind)) return { ok: false, message: "Choose what kind of reference this is." };
    const file = await staged(supabase, ref, name, type);
    if (!file) return { ok: false, message: `${name}: the file did not arrive; choose it again.` };
    const bytes = new Uint8Array(await file.arrayBuffer());
    const refused = uploadProblem(name, bytes, POLICIES.reference);
    if (refused) return { ok: false, message: `${name}: ${refused}` };
    const sha = createHash("sha256").update(bytes).digest("hex");
    const path = `${projectId}/references/${sha.slice(0, 16)}-${name.replace(/[^\w.-]+/g, "_").slice(-120)}`;
    const mime = file.type || "application/octet-stream";
    const { error: upErr } = await supabase.storage.from("project-files").upload(path, bytes, { contentType: mime, upsert: false });
    if (upErr && !/exists|duplicate/i.test(upErr.message)) return { ok: false, message: `${name}: ${upErr.message}` };
    const { error } = await supabase.rpc("add_project_reference", {
      p_project: projectId, p_kind: kind, p_title: title.trim() || name.replace(/\.[^.]+$/, ""), p_note: note || null,
      p_filename: name, p_path: path, p_sha256: sha, p_size: bytes.length, p_mime: mime,
    });
    if (error) {
      if (!upErr) await supabase.storage.from("project-files").remove([path]);
      return { ok: false, message: `${name}: ${error.message}` };
    }
    revalidatePath(base(projectId));
    return { ok: true, message: `${name}: added` };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

export async function updateReference(projectId: string, id: string, form: FormData) {
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("update_project_reference", { p_id: id, p_kind: str(form, "kind"), p_title: str(form, "title"),
    p_note: str(form, "note") || null, p_use_in_plan: form.get("use_in_plan") === "on" });
  if (error) fail(base(projectId), error);
  go(base(projectId), "Reference saved.");
}

export async function removeReference(projectId: string, id: string) {
  const { supabase } = await requireUser();
  const { data: path, error } = await supabase.rpc("remove_project_reference", { p_id: id });
  if (error) fail(base(projectId), error);
  await supabase.storage.from("project-files").remove([path as string]);
  go(base(projectId), "Reference removed.");
}

export async function setAuditInPlan(projectId: string, auditId: string, use: boolean) {
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("set_flux_audit_in_plan", { p_audit: auditId, p_use: use });
  if (error) fail(base(projectId), error);
  go(base(projectId), use ? "The plan will build on this prior work." : "The plan will not use this prior work.");
}
