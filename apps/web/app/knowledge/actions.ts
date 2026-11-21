"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { chunkDocument, parseDocument, UnsupportedDocumentError, type ParsedDocument } from "@vx/planning";
import { fail, requireUser } from "@/lib/auth";
import { POLICIES, uploadProblem } from "@/lib/uploads";
import { LICENSES, SOURCE_KINDS, type License } from "@/lib/knowledge";
import { formFile } from "@/lib/staged";
import { fetchIntoSource, queueOcr } from "@/lib/kb-ingest";

const MAX_BYTES = 20 * 1024 * 1024;
const str = (form: FormData, k: string) => String(form.get(k) ?? "").trim();
const back = (projectId: string | null) => projectId ? `/projects/${projectId}` : "/knowledge";

/**
 * Registers a source in the shared library (knowledge editors) or a project (owners, engineers). An uploaded
 * file is read for excerpts only when the licence allows it, and kept only when the licence allows that too;
 * the database refuses anything else, this just says so before any work is done.
 */
export async function addSource(form: FormData) {
  const projectId = str(form, "project_id") || null;
  const path = back(projectId);
  const { supabase } = await requireUser();
  const license = str(form, "license") as License;
  const kind = str(form, "kind");
  if (!(license in LICENSES)) fail(path, "Choose a licence.");
  if (!SOURCE_KINDS.includes(kind as never)) fail(path, "Choose what kind of source it is.");
  const rule = LICENSES[license];
  let file: File | null = null;
  try { file = await formFile(supabase, form, "file"); } catch (e) { fail(path, (e as Error).message); }
  const hasFile = file !== null;
  if (hasFile && !rule.excerpts) {
    fail(path, `${rule.label}: VX Design keeps only the details and the official link for this source. Leave the file out.`);
  }
  if (hasFile && file!.size > MAX_BYTES) fail(path, "The file is larger than 20 MB.");

  let parsed: ParsedDocument | null = null;
  let bytes: Uint8Array | null = null;
  if (hasFile) {
    bytes = new Uint8Array(await file!.arrayBuffer());
    const refused = uploadProblem(file!.name, bytes, POLICIES.source);
    if (refused) fail(path, refused);
    try {
      parsed = await parseDocument(bytes, file!.type, file!.name);
    } catch (e) {
      fail(path, e instanceof UnsupportedDocumentError ? e.message : `Could not read the file: ${(e as Error).message}`);
    }
  }
  // A PDF with no text layer is a scan: it is registered, then queued for OCR instead of refused.
  const scanned = !!parsed && !parsed.sections.some((s) => s.blocks.length);
  if (scanned && parsed!.mimeType !== "application/pdf") fail(path, "No text found in the file.");

  const { data: id, error } = await supabase.rpc("register_source", {
    p_project_id: projectId, p_kind: kind, p_title: str(form, "title") || parsed?.title || (hasFile ? file!.name : "") || str(form, "identifier") || str(form, "official_url"),
    p_publisher: str(form, "publisher"), p_official_url: str(form, "official_url") || null,
    p_identifier: str(form, "identifier") || null, p_edition: str(form, "edition") || null, p_license: license,
    p_license_note: str(form, "license_note") || null, p_summary: str(form, "summary") || null,
    p_acquisition: hasFile ? "upload" : "official_url",
  });
  if (error) fail(path, error);

  let notice = "Source added (details and link only).";
  if (scanned) {
    try { notice = await queueOcr(supabase, { id: id as string, project_id: projectId, license, official_url: null, sha256: null }, bytes!, file!.name); }
    catch (e) { fail(`/knowledge/sources/${id}`, `Saved the details, but ${(e as Error).message}`); }
  } else if (!hasFile && form.get("fetch") === "on" && str(form, "official_url")) {
    try { notice = await fetchIntoSource(supabase, id as string); }
    catch (e) { notice = `Source added. ${(e as Error).message}`; }
  } else if (parsed && bytes && hasFile) {
    const excerpts = chunkDocument(parsed);
    let storagePath: string | null = null;
    if (rule.file) {
      const safe = file!.name.replace(/[^\w.-]+/g, "_").slice(-100);
      const bucket = projectId ? "project-files" : "knowledge-files";
      storagePath = projectId ? `${projectId}/sources/${id}-${safe}` : `${id}/${parsed.sha256.slice(0, 16)}-${safe}`;
      const { error: up } = await supabase.storage.from(bucket).upload(storagePath, bytes, { contentType: parsed.mimeType, upsert: false });
      if (up) fail(`/knowledge/sources/${id}`, `Saved the details, but the upload failed: ${up.message}`);
    }
    const { error: e2 } = await supabase.rpc("set_source_content", {
      p_source_id: id, p_chunks: excerpts.map(({ block_ids: _, ...x }) => x), p_storage_path: storagePath,
      p_sha256: parsed.sha256, p_mime_type: parsed.mimeType, p_size_bytes: bytes.length,
    });
    if (e2) fail(`/knowledge/sources/${id}`, e2);
    notice = `Source added: ${excerpts.length} excerpt(s) indexed${storagePath ? ", file kept" : ", file not kept (vendor terms)"}.`;
  }
  revalidatePath(path);
  redirect(`/knowledge/sources/${id}?notice=${encodeURIComponent(notice)}`);
}

export async function verifySource(sourceId: string, form: FormData) {
  const path = `/knowledge/sources/${sourceId}`;
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("verify_source", { p_source_id: sourceId, p_edition: str(form, "edition") || null, p_note: str(form, "note") });
  if (error) fail(path, error);
  revalidatePath(path);
  redirect(`${path}?notice=${encodeURIComponent("Verified.")}`);
}

export async function changeLicense(sourceId: string, form: FormData) {
  const path = `/knowledge/sources/${sourceId}`;
  const { supabase } = await requireUser();
  const license = str(form, "license");
  if (!(license in LICENSES)) fail(path, "Choose a licence.");
  const { data: src } = await supabase.from("sources").select("project_id").eq("id", sourceId).maybeSingle();
  const { data: removed, error } = await supabase.rpc("set_source_license", { p_source_id: sourceId, p_license: license, p_note: str(form, "note") });
  if (error) fail(path, error);
  let notice = `Licence set to ${LICENSES[license as License].label}.`;
  if (removed) {
    const { error: del } = await supabase.storage.from(src?.project_id ? "project-files" : "knowledge-files").remove([removed as string]);
    notice += del ? ` The stored file could not be deleted (${del.message}); remove ${removed} by hand.` : " The stored copy was deleted.";
  }
  revalidatePath(path);
  redirect(`${path}?notice=${encodeURIComponent(notice)}`);
}

export async function withdrawSource(sourceId: string, form: FormData) {
  const path = `/knowledge/sources/${sourceId}`;
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("withdraw_source", { p_source_id: sourceId, p_superseded_by: null, p_note: str(form, "note") || null });
  if (error) fail(path, error);
  revalidatePath(path);
  redirect(`${path}?notice=${encodeURIComponent("Withdrawn: it no longer appears in searches.")}`);
}

export async function reviewStandard(standardId: string, form: FormData) {
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("review_standard", {
    p_standard_id: standardId, p_edition: str(form, "edition"), p_edition_note: str(form, "edition_note") || null,
    p_status: str(form, "status") || "reviewed",
  });
  if (error) fail("/knowledge", error);
  revalidatePath("/knowledge");
  redirect(`/knowledge?notice=${encodeURIComponent("Standard reviewed.")}#standards`);
}

export async function proposeStandard(projectId: string, form: FormData) {
  const base = `/projects/${projectId}`, path = `${base}?tab=standards`;
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("set_project_standard", {
    p_project_id: projectId, p_standard_id: str(form, "standard_id"), p_applicability: str(form, "applicability"), p_rationale: str(form, "rationale"),
  });
  if (error) fail(path, error);
  revalidatePath(base);
  redirect(`${path}&notice=${encodeURIComponent("Proposed: an owner or reviewer confirms it.")}`);
}

export async function confirmStandard(projectId: string, id: string) {
  const base = `/projects/${projectId}`, path = `${base}?tab=standards`;
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("confirm_project_standard", { p_id: id, p_note: null });
  if (error) fail(path, error);
  revalidatePath(base);
  redirect(`${path}&notice=${encodeURIComponent("Confirmed.")}`);
}

export async function fetchSource(sourceId: string) {
  const path = `/knowledge/sources/${sourceId}`;
  const { supabase } = await requireUser();
  let notice: string;
  try { notice = await fetchIntoSource(supabase, sourceId); } catch (e) { fail(path, (e as Error).message); }
  revalidatePath(path);
  redirect(`${path}?notice=${encodeURIComponent(notice)}`);
}
