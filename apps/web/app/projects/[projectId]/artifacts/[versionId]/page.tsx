import Link from "next/link";
import { notFound } from "next/navigation";
import { CsvTable, DesignView, ErcView, EvidenceView } from "@/components/ArtifactViews";
import { requireUser } from "@/lib/auth";

const MAX_INLINE = 2 * 1024 * 1024;

export default async function ArtifactVersionPage({ params }: { params: Promise<{ projectId: string; versionId: string }> }) {
  const { projectId, versionId } = await params;
  const { supabase } = await requireUser();
  const { data: v } = await supabase.from("artifact_versions")
    .select("id, version, status, sha256, size_bytes, content_type, storage_path, tool_name, tool_version, tool_config, summary, created_at, committed_at, validated_at, produced_by_task_id, produced_by_execution_id, artifacts(name, kind), tasks:produced_by_task_id(key, title), projects(name)")
    .eq("id", versionId).eq("project_id", projectId).maybeSingle();
  if (!v) notFound();

  const [{ data: signed }, { data: allChecks }, { data: siblings }] = await Promise.all([
    supabase.storage.from("project-files").createSignedUrl(v.storage_path, 3600),
    // Checks of the attempt that produced this file (ERC, netlist, footprints, datasheets), not only those attached to it.
    v.produced_by_task_id
      ? supabase.from("validations").select("id, kind, result, evidence_category, summary, execution_id, artifact_version_id, created_at")
          .eq("task_id", v.produced_by_task_id).order("created_at")
      : supabase.from("validations").select("id, kind, result, evidence_category, summary, execution_id, artifact_version_id, created_at")
          .eq("artifact_version_id", versionId),
    v.produced_by_task_id
      ? supabase.from("artifact_versions").select("id, version, status, validated_at, storage_path, content_type, artifacts(name)")
          .eq("produced_by_task_id", v.produced_by_task_id).neq("status", "superseded").order("created_at")
      : Promise.resolve({ data: [] as never[] }),
  ]);
  // The validation set that mentions this version, or else the most recent one for the task.
  const groups = new Map<string, NonNullable<typeof allChecks>>();
  for (const c of allChecks ?? []) groups.set(c.execution_id ?? "", [...(groups.get(c.execution_id ?? "") ?? []), c]);
  const checks = [...groups.values()].find((g) => g.some((c) => c.artifact_version_id === versionId)) ?? [...groups.values()].at(-1) ?? [];
  const artifact = v.artifacts as unknown as { name: string; kind: string };
  const task = v.tasks as unknown as { key: string; title: string } | null;
  const type = v.content_type ?? "";
  const label = v.status === "committed" ? "Committed" : v.status === "superseded" ? "Superseded" : v.validated_at ? "Validated, awaiting approval" : "Scratch (not committed)";

  let text: string | null = null;
  if ((type.startsWith("text/") || type.startsWith("application/json")) && (v.size_bytes ?? 0) <= MAX_INLINE) {
    const { data } = await supabase.storage.from("project-files").download(v.storage_path);
    text = data ? await data.text() : null;
  }
  const json = type.startsWith("application/json") && text ? (() => { try { return JSON.parse(text!); } catch { return null; } })() : null;
  const suffix = artifact.name.split("/").pop() ?? "";

  // Same-attempt outputs of the task (e.g. the schematic drawing next to its ERC report).
  const others = (siblings ?? []).filter((s) => s.id !== v.id && (s.status === "committed" || s.validated_at));
  const svg = (siblings ?? []).find((s) => (s.artifacts as unknown as { name: string }).name.endsWith("/schematic-svg"));
  const { data: svgUrl } = svg && suffix !== "schematic-svg" && suffix === "kicad-project"
    ? await supabase.storage.from("project-files").createSignedUrl(svg.storage_path, 3600) : { data: null };

  return (
    <main>
      <p className="crumbs"><Link href="/projects">Projects</Link> / <Link href={`/projects/${projectId}`}>{(v.projects as unknown as { name: string }).name}</Link> /</p>
      <div className="row spread">
        <h1>{artifact.name} <span className="muted">v{v.version}</span></h1>
        <span className={`pill big pill-${v.status === "committed" ? "complete" : "awaiting_approval"}`}>{label}</span>
      </div>
      {v.summary && <p>{v.summary}</p>}
      {(v.tool_config as { offline?: boolean })?.offline && (
        <p className="banner banner-warn">Produced with the offline stand-in, not AI: the design content is a fixed fixture, though the KiCad checks on it are real.</p>
      )}
      <dl className="facts small card">
        <dt>Kind</dt><dd>{artifact.kind}</dd>
        {task && <><dt>Produced by</dt><dd><span className="mono">{task.key}</span> {task.title}</dd></>}
        <dt>Tool</dt><dd className="mono">{v.tool_name} {v.tool_version}</dd>
        <dt>SHA-256</dt><dd className="mono">{v.sha256}</dd>
        <dt>Created</dt><dd>{new Date(v.created_at).toLocaleString()}{v.committed_at && ` · committed ${new Date(v.committed_at).toLocaleString()}`}</dd>
        <dt>File</dt><dd>{signed?.signedUrl ? <a href={signed.signedUrl} download>Download</a> : "unavailable"} ({v.size_bytes} bytes, {type})</dd>
      </dl>
      {checks.length > 0 && (
        <ul className="small" data-testid="checks">{checks.map((c) => <li key={c.id}><span className={`pill pill-check-${c.result}`}>{c.result}</span> {c.kind.replace("_", " ")}: {c.summary} <span className="muted">({c.evidence_category.replace(/_/g, " ")})</span></li>)}</ul>
      )}

      {suffix === "kicad-project" && (
        <div className="card">
          <h3>Open in KiCad</h3>
          <p className="small">Download and unzip, then open the <span className="mono">.kicad_pro</span> file in KiCad 10. Symbols are embedded in the
            schematic; footprints come from KiCad&apos;s standard libraries. The drawing is laid out automatically, so tidy it before sharing.</p>
          {svgUrl?.signedUrl && <img className="schematic" src={svgUrl.signedUrl} alt="Schematic drawing" />}
        </div>
      )}
      {type === "image/svg+xml" && signed?.signedUrl && (
        <a href={signed.signedUrl} target="_blank" rel="noreferrer"><img className="schematic" src={signed.signedUrl} alt={`${artifact.name} drawing`} /></a>
      )}
      {type === "application/pdf" && signed?.signedUrl && <iframe className="pdf" src={signed.signedUrl} title={artifact.name} />}
      {json && suffix === "erc-report" && <ErcView report={json} />}
      {json && suffix === "component-evidence" && <EvidenceView evidence={json} />}
      {json && suffix === "design" && <DesignView design={json} />}
      {json && !["erc-report", "component-evidence", "design"].includes(suffix) && <pre className="doc">{JSON.stringify(json, null, 2)}</pre>}
      {text !== null && type.startsWith("text/csv") && <CsvTable csv={text} />}
      {text !== null && !json && !type.startsWith("text/csv") && <pre className="doc">{text}</pre>}

      {others.length > 0 && (
        <section>
          <h2>Other outputs of this task</h2>
          <ul className="small">{others.map((s) => (
            <li key={s.id}><Link href={`/projects/${projectId}/artifacts/${s.id}`}>{(s.artifacts as unknown as { name: string }).name} v{s.version}</Link>
              <span className="muted"> {s.content_type}</span></li>
          ))}</ul>
        </section>
      )}
    </main>
  );
}
