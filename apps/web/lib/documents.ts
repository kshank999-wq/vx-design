import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeText, parseDocument, UnsupportedDocumentError, type ExtractionResult, type ParsedDocument, type ReusableRequirement } from "@vx/planning";
import { POLICIES, uploadProblem } from "@/lib/uploads";

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/** Checks, parses and stores one specification document. Throws an Error whose message is for the person uploading. */
export async function storeDocument(supabase: SupabaseClient, userId: string, projectId: string, file: File): Promise<{ title: string; sections: number }> {
  if (file.size > MAX_UPLOAD_BYTES) throw new Error(`${file.name} is larger than 20 MB.`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const refused = uploadProblem(file.name, bytes, POLICIES.document);
  if (refused) throw new Error(`${file.name}: ${refused}`);
  let parsed: ParsedDocument;
  try {
    parsed = await parseDocument(bytes, file.type, file.name);
  } catch (e) {
    throw new Error(e instanceof UnsupportedDocumentError ? `${file.name}: ${e.message}` : `Could not read ${file.name}: ${(e as Error).message}`);
  }
  if (!parsed.sections.some((s) => s.blocks.length)) throw new Error(`No text found in ${file.name}.`);
  const { data: existing } = await supabase.from("documents").select("id").eq("project_id", projectId).eq("sha256", parsed.sha256).maybeSingle();
  if (existing) throw new Error(`${file.name} is already uploaded to the project.`);

  const safeName = file.name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(-120);
  const storagePath = `${projectId}/documents/${parsed.sha256.slice(0, 16)}-${safeName}`;
  const { error: upErr } = await supabase.storage.from("project-files").upload(storagePath, bytes, { contentType: file.type || parsed.mimeType, upsert: false });
  if (upErr) throw new Error(`Upload of ${file.name} failed: ${upErr.message}`);
  const { error } = await supabase.from("documents").insert({
    project_id: projectId, kind: "specification", title: parsed.title ?? file.name, filename: file.name, storage_path: storagePath,
    sha256: parsed.sha256, size_bytes: file.size, mime_type: parsed.mimeType, parsed, uploaded_by: userId,
  });
  if (error) throw new Error(error.message);
  return { title: parsed.title ?? file.name, sections: parsed.sections.length };
}

export interface PreparedExtraction { id: string; title: string; parsed: ParsedDocument; previous: string[] }

/**
 * Whether a document may be (re-)extracted. Re-extraction replaces its unreviewed requirements unless a plan uses
 * them or they were reviewed. Marks the document as running. Throws with the reason otherwise.
 */
export async function prepareExtraction(supabase: SupabaseClient, documentId: string): Promise<PreparedExtraction> {
  const { data: doc, error } = await supabase.from("documents").select("id, title, parsed, extraction_status").eq("id", documentId).single();
  if (error || !doc?.parsed) throw new Error(error?.message ?? "Document has no parsed content.");
  if (doc.extraction_status === "running") throw new Error(`Extraction is already running for ${doc.title}.`);
  const { data: previous } = await supabase.from("requirements").select("id, status, task_requirements(task_id)").eq("document_id", documentId).eq("origin", "extracted");
  if (previous?.some((r) => (r.task_requirements as unknown[]).length)) throw new Error(`Requirements from ${doc.title} are used by a plan; revise the plan instead of re-extracting.`);
  if (previous?.some((r) => r.status === "confirmed" || r.status === "rejected")) throw new Error(`Some requirements from ${doc.title} were already reviewed; re-extraction would discard that review.`);
  await supabase.from("documents").update({ extraction_status: "running" }).eq("id", documentId);
  return { id: doc.id, title: doc.title, parsed: doc.parsed as ParsedDocument, previous: (previous ?? []).map((r) => r.id) };
}

/** Stores a document's extracted requirements, numbered after those already in the project. Run one at a time. */
export async function persistExtraction(supabase: SupabaseClient, projectId: string, p: PreparedExtraction, result: ExtractionResult,
                                        model: { label: string; offline: boolean }): Promise<number> {
  const { data: existing } = await supabase.from("requirements").select("ref_code").eq("project_id", projectId).neq("document_id", p.id);
  const offsets = new Map<string, number>();
  for (const { ref_code } of existing ?? []) {
    const m = /^(REQ-[A-Z]+)-(\d+)$/.exec(ref_code);
    if (m) offsets.set(m[1]!, Math.max(offsets.get(m[1]!) ?? 0, Number(m[2])));
  }
  const rows = result.requirements.map((r) => {
    const [, prefix, n] = /^(REQ-[A-Z]+)-(\d+)$/.exec(r.refCode)!;
    return {
      project_id: projectId, document_id: p.id, ref_code: `${prefix}-${String(Number(n) + (offsets.get(prefix!) ?? 0)).padStart(3, "0")}`,
      kind: r.kind, status: r.status, priority: r.priority, text: r.text, source_section: r.sectionTitle, source_page: r.page,
      source_excerpt: r.excerpt, block_id: r.blockId, acceptance_criteria: r.acceptanceCriteria, notes: r.notes, origin: "extracted",
    };
  });
  if (p.previous.length) await supabase.from("requirements").delete().in("id", p.previous);
  if (rows.length) {
    const { error } = await supabase.from("requirements").insert(rows);
    if (error) throw new Error(error.message);
  }
  await supabase.from("documents").update({
    extraction_status: "done",
    extraction_report: { prompt_version: result.promptVersion, model: model.label, offline: model.offline, requirements: rows.length,
                         dropped: result.dropped, open_questions: result.openQuestions, usage: result.usage, sources: result.sources ?? null,
                         completed_at: new Date().toISOString() },
  }).eq("id", p.id);
  return rows.length;
}

/**
 * Requirements already read from the project's other specifications, by the exact text of the block they came from:
 * a new revision of a document reuses them for every block that did not change, so only changed blocks are read
 * again. Requirements people rejected are not carried over.
 */
export async function reusableRequirements(supabase: SupabaseClient, projectId: string, exceptDocumentIds: string[]): Promise<Map<string, ReusableRequirement[]>> {
  const out = new Map<string, ReusableRequirement[]>();
  const { data: docs } = await supabase.from("documents").select("id, parsed").eq("project_id", projectId).eq("extraction_status", "done");
  const others = (docs ?? []).filter((d) => !exceptDocumentIds.includes(d.id) && d.parsed);
  if (!others.length) return out;
  const { data: reqs } = await supabase.from("requirements").select("document_id, block_id, text, kind, priority, source_excerpt, acceptance_criteria, notes, status")
    .in("document_id", others.map((d) => d.id)).eq("origin", "extracted").neq("status", "rejected");
  for (const d of others) {
    const blocks = new Map(((d.parsed as ParsedDocument).sections ?? []).flatMap((s) => s.blocks).map((b) => [b.id, b.text]));
    for (const r of (reqs ?? []).filter((x) => x.document_id === d.id && x.block_id && x.source_excerpt)) {
      const text = blocks.get(r.block_id!);
      if (!text) continue;
      const key = normalizeText(text);
      const list = out.get(key) ?? [];
      if (!list.some((x) => x.statement === r.text)) list.push({ statement: r.text, kind: r.kind, priority: r.priority, excerpt: r.source_excerpt!,
        acceptance_criteria: r.acceptance_criteria, ambiguity: r.notes });
      out.set(key, list);
    }
  }
  return out;
}

export async function markExtractionFailed(supabase: SupabaseClient, documentId: string, message: string, model: string) {
  await supabase.from("documents").update({ extraction_status: "failed", extraction_report: { error: message, model } }).eq("id", documentId);
}

const words = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9.%°±]+/g, " ").split(" ").filter((w) => w.length > 2));
/**
 * Requirements in different documents that say nearly the same thing (word overlap ≥ 0.75), for a person to merge or
 * reject one of. Deterministic; nothing is changed automatically.
 */
export function crossDocumentDuplicates<T extends { id: string; ref_code: string; text: string; document_id: string | null; status: string }>(reqs: T[]): [T, T, number][] {
  const live = reqs.filter((r) => r.status !== "rejected" && r.document_id);
  const sets = live.map((r) => words(r.text));
  const out: [T, T, number][] = [];
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      if (live[i]!.document_id === live[j]!.document_id) continue;
      const a = sets[i]!, b = sets[j]!;
      if (!a.size || !b.size) continue;
      const inter = [...a].filter((w) => b.has(w)).length;
      const score = inter / (a.size + b.size - inter);
      if (score >= 0.75) out.push([live[i]!, live[j]!, Math.round(score * 100) / 100]);
    }
  }
  return out.sort((x, y) => y[2] - x[2]);
}
