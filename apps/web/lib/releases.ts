import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CommittedFile } from "@/components/ReleaseFiles";
import { RELEASE_KINDS } from "@/lib/production";

/** Committed versions of the project's design outputs, newest first within each file. */
export async function committedFiles(supabase: SupabaseClient, projectId: string): Promise<CommittedFile[]> {
  const { data } = await supabase.from("artifact_versions").select("id, version, committed_at, artifact_id, artifacts!inner(name, kind)")
    .eq("project_id", projectId).eq("status", "committed").in("artifacts.kind", RELEASE_KINDS);
  const rows = (data ?? []).map((v) => {
    const a = v.artifacts as unknown as { name: string; kind: string };
    return { id: v.id as string, version: v.version as number, artifact_id: v.artifact_id as string, artifact: a.name, kind: a.kind, committed_at: v.committed_at as string | null };
  });
  const latest = new Map<string, number>();
  for (const r of rows) latest.set(r.artifact_id, Math.max(latest.get(r.artifact_id) ?? 0, r.version));
  return rows.map(({ artifact_id, ...r }) => ({ ...r, latest: latest.get(artifact_id) === r.version }))
    .sort((a, b) => a.artifact.localeCompare(b.artifact) || b.version - a.version);
}
