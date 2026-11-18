/**
 * Integrity check (G6): every stored file the database vouches for (artifact versions, documents, concept images,
 * 3D models, knowledge files, RFQ packets, Flux uploads and reports) is downloaded and hashed again, and every
 * project's audit hash chain is verified. Answers "are the records and the files still the ones we produced?" after
 * a restore, a migration or on a schedule.
 */
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface IntegrityRecord { kind: string; id: string; bucket: string; path: string; sha256: string }
export interface IntegrityReport {
  checked: number; missing: IntegrityRecord[]; mismatched: (IntegrityRecord & { actual: string })[];
  chains: { checked: number; broken: { project_id: string | null; problem: string; first_bad_seq: number | null }[] };
  ok: boolean;
}

const SOURCES: { kind: string; table: string; path: string; sha: string; filter?: (q: any) => any; bucket?: (r: any) => string }[] = [
  { kind: "artifact version", table: "artifact_versions", path: "storage_path", sha: "sha256" },
  { kind: "document", table: "documents", path: "storage_path", sha: "sha256" },
  { kind: "concept image", table: "concept_variants", path: "image_path", sha: "sha256", filter: (q) => q.eq("status", "ready") },
  { kind: "3D model", table: "part_models", path: "storage_path", sha: "sha256", filter: (q) => q.not("storage_path", "is", null) },
  { kind: "3D model original", table: "part_models", path: "original_path", sha: "original_sha256", filter: (q) => q.not("original_path", "is", null).not("original_sha256", "is", null) },
  { kind: "knowledge file", table: "sources", path: "storage_path", sha: "sha256", filter: (q) => q.not("storage_path", "is", null),
    bucket: (r) => (r.project_id ? "project-files" : "knowledge-files") },
  { kind: "RFQ packet", table: "rfqs", path: "packet_path", sha: "packet_sha256", filter: (q) => q.not("packet_path", "is", null) },
  { kind: "Flux upload", table: "flux_audit_files", path: "storage_path", sha: "sha256" },
  { kind: "Flux report", table: "flux_audits", path: "report_path", sha: "report_sha256", filter: (q) => q.eq("status", "ready") },
];

export async function listRecords(db: SupabaseClient): Promise<IntegrityRecord[]> {
  const out: IntegrityRecord[] = [];
  for (const s of SOURCES) {
    for (let from = 0; ; from += 1000) {
      let q = db.from(s.table).select(`id, ${s.path}, ${s.sha}${s.bucket ? ", project_id" : ""}`).order("id").range(from, from + 999);
      if (s.filter) q = s.filter(q);
      const { data, error } = await q;
      if (error) throw new Error(`${s.table}: ${error.message}`);
      for (const r of (data ?? []) as any[]) {
        if (r[s.path] && r[s.sha]) out.push({ kind: s.kind, id: r.id, bucket: s.bucket ? s.bucket(r) : "project-files", path: r[s.path], sha256: r[s.sha] });
      }
      if (!data || data.length < 1000) break;
    }
  }
  return out;
}

export async function checkIntegrity(db: SupabaseClient, opts: { fetch?: (r: IntegrityRecord) => Promise<Uint8Array | null>; concurrency?: number } = {}): Promise<IntegrityReport> {
  const fetchBytes = opts.fetch ?? (async (r: IntegrityRecord) => {
    const { data, error } = await db.storage.from(r.bucket).download(r.path);
    return error || !data ? null : new Uint8Array(await data.arrayBuffer());
  });
  const records = await listRecords(db);
  const missing: IntegrityReport["missing"] = [];
  const mismatched: IntegrityReport["mismatched"] = [];
  const queue = [...records];
  await Promise.all(Array.from({ length: opts.concurrency ?? 6 }, async () => {
    for (let r = queue.shift(); r; r = queue.shift()) {
      const bytes = await fetchBytes(r);
      if (!bytes) { missing.push(r); continue; }
      const actual = createHash("sha256").update(bytes).digest("hex");
      if (actual !== r.sha256) mismatched.push({ ...r, actual });
    }
  }));
  const { data: projects, error } = await db.from("projects").select("id");
  if (error) throw new Error(`projects: ${error.message}`);
  const broken: IntegrityReport["chains"]["broken"] = [];
  const ids: (string | null)[] = [null, ...(projects ?? []).map((p) => p.id as string)];
  for (const id of ids) {
    const { data, error: e } = await db.rpc("verify_audit_chain", { p_project_id: id });
    if (e) throw new Error(`verify_audit_chain: ${e.message}`);
    const v = (data as { ok: boolean; problem: string | null; first_bad_seq: number | null }[])[0]!;
    if (!v.ok) broken.push({ project_id: id, problem: v.problem ?? "broken", first_bad_seq: v.first_bad_seq });
  }
  return { checked: records.length, missing, mismatched, chains: { checked: ids.length, broken },
           ok: !missing.length && !mismatched.length && !broken.length };
}
