import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { BomLineFact } from "@vx/planning";

export const caseCode = (n: number) => `LC-${String(n).padStart(3, "0")}`;
export const RISK_PILL: Record<string, string> = { high: "failed", medium: "awaiting_approval", low: "", none: "complete" };
export const CASE_PILL: Record<string, string> = { open: "failed", assessing: "awaiting_approval", resolved: "complete" };
export const CHECKS: [string, string][] = [
  ["pinout", "Footprint and pin-out"], ["electrical", "Electrical ratings"], ["environmental", "Temperature and environment"],
  ["supply", "Supply (stock, second source)"], ["test", "Bench or production test"],
];

/** The JSON a sourcing task commits as `<task>/sourced-bom` (only the fields lifecycle needs). */
export interface SourcedBomJson {
  generatedAt: string; currency: string; quantities: number[]; dataStatus: string;
  lines: { refs: string[]; quantityPerBoard: number; wanted: { mpn: string | null; manufacturer: string | null };
           selected: { mpn: string; manufacturer: string } | null; alternates: { mpn: string; manufacturer: string }[] }[];
  totals: { boards: number; perBoard: number | null; total: number | null; missingLines: string[] }[];
}

export interface BomVersion { id: string; version: number; artifact: string; committed_at: string | null; storage_path: string }

/** Committed sourced-BOM versions of a project, newest first. */
export async function sourcedBomVersions(supabase: SupabaseClient, projectId: string): Promise<BomVersion[]> {
  const { data } = await supabase.from("artifact_versions").select("id, version, committed_at, storage_path, artifacts!inner(name, kind)")
    .eq("project_id", projectId).neq("status", "scratch").eq("artifacts.kind", "bom").like("artifacts.name", "%/sourced-bom");
  return (data ?? []).map((v) => ({ id: v.id, version: v.version, committed_at: v.committed_at, storage_path: v.storage_path,
                                    artifact: (v.artifacts as unknown as { name: string }).name }))
    .sort((a, b) => (b.committed_at ?? "").localeCompare(a.committed_at ?? "") || b.version - a.version);
}

export async function readSourcedBom(supabase: SupabaseClient, path: string): Promise<SourcedBomJson | null> {
  const { data } = await supabase.storage.from("project-files").download(path);
  if (!data) return null;
  try { return JSON.parse(await data.text()) as SourcedBomJson; } catch { return null; }
}

export const bomLineFacts = (b: SourcedBomJson): BomLineFact[] =>
  b.lines.map((l) => ({ refs: l.refs, mpn: l.selected?.mpn ?? l.wanted.mpn, manufacturer: l.selected?.manufacturer ?? l.wanted.manufacturer }));
