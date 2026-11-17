import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";

const MAX_INLINE = 512 * 1024;

export default async function ArtifactVersionPage({ params }: { params: Promise<{ projectId: string; versionId: string }> }) {
  const { projectId, versionId } = await params;
  const { supabase } = await requireUser();
  const { data: v } = await supabase.from("artifact_versions")
    .select("id, version, status, sha256, size_bytes, content_type, storage_path, tool_name, tool_version, tool_config, summary, created_at, committed_at, validated_at, artifacts(name, kind), tasks:produced_by_task_id(key, title), projects(name)")
    .eq("id", versionId).eq("project_id", projectId).maybeSingle();
  if (!v) notFound();

  const [{ data: signed }, { data: checks }] = await Promise.all([
    supabase.storage.from("project-files").createSignedUrl(v.storage_path, 3600),
    supabase.from("validations").select("id, kind, result, evidence_category, summary").eq("artifact_version_id", versionId),
  ]);
  let text: string | null = null;
  if (v.content_type?.startsWith("text/") && (v.size_bytes ?? 0) <= MAX_INLINE) {
    const { data } = await supabase.storage.from("project-files").download(v.storage_path);
    text = data ? await data.text() : null;
  }
  const artifact = v.artifacts as unknown as { name: string; kind: string };
  const task = v.tasks as unknown as { key: string; title: string } | null;
  const label = v.status === "committed" ? "Committed" : v.status === "superseded" ? "Superseded" : v.validated_at ? "Validated, awaiting approval" : "Scratch (not committed)";

  return (
    <main>
      <p className="crumbs"><Link href="/projects">Projects</Link> / <Link href={`/projects/${projectId}`}>{(v.projects as unknown as { name: string }).name}</Link> /</p>
      <div className="row spread">
        <h1>{artifact.name} <span className="muted">v{v.version}</span></h1>
        <span className={`pill big pill-${v.status === "committed" ? "complete" : "awaiting_approval"}`}>{label}</span>
      </div>
      {v.summary && <p>{v.summary}</p>}
      <dl className="facts small card">
        <dt>Kind</dt><dd>{artifact.kind}</dd>
        {task && <><dt>Produced by</dt><dd><span className="mono">{task.key}</span> {task.title}</dd></>}
        <dt>Tool</dt><dd className="mono">{v.tool_name} {v.tool_version} {JSON.stringify(v.tool_config)}</dd>
        <dt>SHA-256</dt><dd className="mono">{v.sha256}</dd>
        <dt>Created</dt><dd>{new Date(v.created_at).toLocaleString()}{v.committed_at && ` · committed ${new Date(v.committed_at).toLocaleString()}`}</dd>
        <dt>File</dt><dd>{signed?.signedUrl ? <a href={signed.signedUrl}>Download</a> : "unavailable"} ({v.size_bytes} bytes, {v.content_type})</dd>
      </dl>
      {(checks ?? []).length > 0 && (
        <ul className="small">{checks!.map((c) => <li key={c.id}><span className={`pill pill-check-${c.result}`}>{c.result}</span> {c.kind}: {c.summary} <span className="muted">({c.evidence_category.replace(/_/g, " ")})</span></li>)}</ul>
      )}
      {text !== null && <pre className="doc">{text}</pre>}
    </main>
  );
}
