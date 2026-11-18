import "server-only";
import { createHash } from "node:crypto";
import { chunkDocument, parseDocument, UnsupportedDocumentError } from "@vx/planning";
import { LICENSES, type License } from "@/lib/knowledge";
import { FetchRefused, safeFetch } from "@/lib/safe-fetch";
import { POLICIES, uploadProblem } from "@/lib/uploads";
import type { createClient } from "@/lib/supabase/server";

type Supabase = Awaited<ReturnType<typeof createClient>>;
interface SourceRow { id: string; project_id: string | null; license: License; official_url: string | null; sha256: string | null }

const safeName = (n: string) => n.replace(/[^\w.-]+/g, "_").slice(-100) || "document";
const bucketOf = (s: SourceRow) => (s.project_id ? "project-files" : "knowledge-files");

/** Where a source's file lives: the project's sources folder, or the source's own folder in the shared library. */
export function sourceFilePath(s: SourceRow, sha: string, name: string, prefix = ""): string {
  return s.project_id ? `${s.project_id}/sources/${prefix}${s.id}-${safeName(name)}` : `${s.id}/${prefix}${sha.slice(0, 16)}-${safeName(name)}`;
}

/** A scanned PDF (no text layer): stored in the source's folder and queued for OCR by the worker. */
export async function queueOcr(supabase: Supabase, s: SourceRow, bytes: Uint8Array, name: string): Promise<string> {
  const sha = createHash("sha256").update(bytes).digest("hex");
  const path = sourceFilePath(s, sha, name, "ocr-");
  const { error: up } = await supabase.storage.from(bucketOf(s)).upload(path, bytes, { contentType: "application/pdf", upsert: true });
  if (up) throw new Error(`the scanned file could not be stored: ${up.message}`);
  const { error } = await supabase.rpc("request_ocr", { p_source_id: s.id, p_storage_path: path, p_sha256: sha, p_size_bytes: bytes.length });
  if (error) throw new Error(error.message);
  return "The PDF has no text layer (a scan): it is queued for OCR by the worker. Excerpts appear when it finishes, marked as OCR text.";
}

/**
 * Fetches a source from its official link and indexes it, if its licence allows reading it. The same content
 * (same sha256) only records the check; new content replaces the excerpts and, for a verified source, asks for
 * verification again. Returns a sentence for the person.
 */
export async function fetchIntoSource(supabase: Supabase, sourceId: string): Promise<string> {
  const { data } = await supabase.from("sources").select("id, project_id, license, official_url, sha256").eq("id", sourceId).maybeSingle();
  const s = data as SourceRow | null;
  if (!s) throw new Error("Source not found.");
  if (!s.official_url) throw new Error("The source has no official link to fetch.");
  const rule = LICENSES[s.license];
  if (!rule.excerpts) throw new Error(`${rule.label}: VX Design keeps only the details and the link for this source, so it is not fetched.`);
  let fetched;
  try { fetched = await safeFetch(s.official_url); }
  catch (e) { throw new Error(e instanceof FetchRefused ? `Not fetched: ${e.message}.` : `The link could not be fetched (${(e as Error).message}).`); }
  const { bytes, contentType, finalUrl } = fetched;
  const sha = createHash("sha256").update(bytes).digest("hex");
  const name = decodeURIComponent(new URL(finalUrl).pathname.split("/").pop() || "page.html");
  if (sha === s.sha256) {
    const { error } = await supabase.rpc("apply_source_fetch", { p_source_id: s.id, p_url: finalUrl, p_sha256: sha, p_mime_type: contentType,
                                                                p_size_bytes: bytes.length, p_chunks: [], p_storage_path: null });
    if (error) throw new Error(error.message);
    return "Checked: the document at the official link is unchanged.";
  }
  // A web page is only read for its text (the parser never runs scripts) and is never stored or served, so the
  // upload rule against scripts in HTML does not apply to it; documents get the full upload check.
  const isHtml = contentType === "text/html" || contentType === "application/xhtml+xml";
  if (!isHtml) {
    const refused = uploadProblem(name, bytes, POLICIES.source);
    if (refused) throw new Error(refused);
  }
  let parsed;
  try { parsed = await parseDocument(bytes, contentType, name); }
  catch (e) { throw new Error(e instanceof UnsupportedDocumentError ? e.message : `The document could not be read: ${(e as Error).message}`); }
  if (!parsed.sections.some((x) => x.blocks.length)) {
    if (parsed.mimeType === "application/pdf") return queueOcr(supabase, s, bytes, name);
    throw new Error("No readable text at the official link.");
  }
  const chunks = chunkDocument(parsed).map(({ block_ids: _, ...x }) => x);
  let storagePath: string | null = null;
  if (rule.file && !isHtml) {
    storagePath = sourceFilePath(s, sha, name);
    const { error: up } = await supabase.storage.from(bucketOf(s)).upload(storagePath, bytes, { contentType: parsed.mimeType, upsert: true });
    if (up) throw new Error(`The copy could not be stored: ${up.message}`);
  }
  const { data: r, error } = await supabase.rpc("apply_source_fetch", { p_source_id: s.id, p_url: finalUrl, p_sha256: sha, p_mime_type: parsed.mimeType,
                                                                      p_size_bytes: bytes.length, p_chunks: chunks, p_storage_path: storagePath });
  if (error) throw new Error(error.message);
  const res = r as { changed: boolean; excerpts: number; first: boolean };
  return res.first ? `Fetched from the official link: ${res.excerpts} excerpt(s) indexed${storagePath ? ", copy kept" : isHtml ? " (web page: text only, no copy kept)" : " (copy not kept: vendor terms)"}.`
                   : `The document at the official link changed: ${res.excerpts} excerpt(s) re-indexed. Check the edition and verify it again.`;
}
