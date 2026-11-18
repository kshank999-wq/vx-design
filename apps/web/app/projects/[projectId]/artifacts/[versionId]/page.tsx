import Link from "next/link";
import { notFound } from "next/navigation";
import { CsvTable, DesignView, DrcView, ErcView, EvidenceView, FabCheckView, FitReportView, LayoutView, ModelReportView, SourcedBomView } from "@/components/ArtifactViews";
import { BoardViewer } from "@/components/BoardViewer";
import { PowerView } from "@/components/PowerView";
import { requireUser } from "@/lib/auth";

const MAX_INLINE = 2 * 1024 * 1024;

export default async function ArtifactVersionPage({ params, searchParams }: {
  params: Promise<{ projectId: string; versionId: string }>;
  searchParams: Promise<{ embed?: string }>;
}) {
  const { projectId, versionId } = await params;
  const embed = (await searchParams).embed === "1";
  const { supabase } = await requireUser();
  const { data: v } = await supabase.from("artifact_versions")
    .select("id, version, status, sha256, size_bytes, content_type, storage_path, tool_name, tool_version, tool_config, summary, created_at, committed_at, validated_at, produced_by_task_id, produced_by_execution_id, artifacts(name, kind), tasks:produced_by_task_id(key, title), projects!artifact_versions_project_id_fkey(name)")
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
  const sibling = (end: string) => (siblings ?? []).find((s) => (s.artifacts as unknown as { name: string }).name.endsWith(`/${end}`));
  const signedOf = async (end: string) => {
    const s = sibling(end);
    return s ? (await supabase.storage.from("project-files").createSignedUrl(s.storage_path, 3600)).data?.signedUrl ?? null : null;
  };
  const isProject = suffix === "kicad-project";
  const hasBoard = !!sibling("board-glb");
  const isFab = suffix === "fab-package";
  let fabNotes: string | null = null;
  if (isFab && sibling("fab-notes")) {
    const { data } = await supabase.storage.from("project-files").download(sibling("fab-notes")!.storage_path);
    fabNotes = data ? await data.text() : null;
  }
  const gerbersUrl = isFab ? await signedOf("gerbers") : null;
  const panelUrl = isFab ? await signedOf("panel-render") : null;
  const isFit = suffix === "fit-report";
  const enclosureGlb = isFit ? await signedOf("enclosure-3d") : null;
  const [svgUrl, renderUrl, glbUrl] = await Promise.all([
    isProject && !hasBoard ? signedOf("schematic-svg") : null,
    (isProject || suffix === "board-glb") && hasBoard ? signedOf("render-3d") : null,
    isProject && hasBoard ? signedOf("board-glb") : null,
  ]);

  return (
    <main className={embed ? "embed" : undefined}>
      <p className="crumbs"><Link href="/projects">Projects</Link> / <Link href={`/projects/${projectId}`}>{(v.projects as unknown as { name: string }).name}</Link> /</p>
      <div className="row spread">
        <h1>{artifact.name} <span className="muted">v{v.version}</span></h1>
        <span className={`pill big pill-${v.status === "committed" ? "complete" : "awaiting_approval"}`}>{label}</span>
      </div>
      {v.summary && <p>{v.summary}</p>}
      {(v.tool_config as { offline?: boolean })?.offline && (
        <p className="banner banner-warn">Produced with the offline stand-in, not AI: the design content is a fixed fixture, though the checks run on it are real.</p>
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

      {isProject && (
        <div className="card">
          <h3>Open in KiCad</h3>
          {hasBoard ? (
            <p className="small">Download and unzip, then open the <span className="mono">.kicad_pro</span> file in KiCad 10. The project holds the
              schematic and the routed board, linked to each other (Tools → Update PCB from Schematic reports no changes). Footprints and
              3D models come from KiCad&apos;s standard libraries. Placement was proposed by the model and routing done by Freerouting:
              review both before ordering.</p>
          ) : (
            <p className="small">Download and unzip, then open the <span className="mono">.kicad_pro</span> file in KiCad 10. Symbols are embedded in the
              schematic; footprints come from KiCad&apos;s standard libraries. The drawing is laid out automatically, so tidy it before sharing.</p>
          )}
          {svgUrl && <img className="schematic" src={svgUrl} alt="Schematic drawing" />}
          {glbUrl && <BoardViewer src={glbUrl} poster={renderUrl ?? undefined} />}
        </div>
      )}
      {isFab && (
        <div className="card" data-testid="order-card">
          <h3>Order this board</h3>
          <ol className="small">
            <li>Review the fab notes, the checks above and the assembly drawing.</li>
            <li>Upload <span className="mono">gerbers.zip</span>{gerbersUrl && <> (<a href={gerbersUrl} download>download</a>)</>} on the board
              house&apos;s quote page and enter the settings from the fab notes. It also sits inside the package zip.</li>
            <li>For assembly, also upload <span className="mono">bom.csv</span> and <span className="mono">cpl.csv</span>, then check the
              house&apos;s placement preview. Parts without an LCSC number cannot be assembled by JLCPCB yet.</li>
            <li>Ordering is done by you on the board house&apos;s site; VX Design never places orders.</li>
          </ol>
          {fabNotes && <pre className="doc" data-testid="fab-notes">{fabNotes}</pre>}
          {panelUrl && <><h3>Optional 2x2 panel</h3><img className="render" src={panelUrl} alt="Panel render" /></>}
        </div>
      )}
      {type === "image/png" && signed?.signedUrl && <img className="render" src={signed.signedUrl} alt={`${artifact.name} render`} />}
      {type === "model/gltf-binary" && signed?.signedUrl && (
        <div className="card"><p className="small muted">Drag to orbit, scroll to zoom.{" "}
          {suffix === "enclosure-3d" ? "Exploded view: the board with its 3D models in the base on its standoffs, and the lid set beside it."
            : "Exported by KiCad with tracks, pads, pours, silkscreen and the library 3D models."}</p>
          <BoardViewer src={signed.signedUrl} poster={renderUrl ?? undefined} /></div>
      )}
      {isFit && enclosureGlb && <div className="card"><p className="small muted">Exploded view (drag to orbit).</p><BoardViewer src={enclosureGlb} /></div>}
      {type === "model/stl" && <p className="small card">STL mesh for slicing (FDM/SLA/SLS). Download it above; print with the flat outer face on the bed.</p>}
      {type === "model/step" && ["base-step", "lid-step", "assembly-step"].includes(suffix) ? (
        <p className="small card">STEP of the {suffix.replace("-step", "")} for CAD review, CNC quoting or modification. Download it above.</p>
      ) : type === "model/step" && (
        <p className="small card">STEP AP214 of the assembled board (board body, copper and the KiCad library 3D models), for enclosure work in
          FreeCAD, Fusion, SolidWorks or CadQuery. Download it above.</p>
      )}
      {type === "image/svg+xml" && signed?.signedUrl && (
        <a href={signed.signedUrl} target="_blank" rel="noreferrer"><img className="schematic" src={signed.signedUrl} alt={`${artifact.name} drawing`} /></a>
      )}
      {type === "application/pdf" && signed?.signedUrl && <iframe className="pdf" src={signed.signedUrl} title={artifact.name} />}
      {json && suffix === "erc-report" && <ErcView report={json} />}
      {json && suffix === "component-evidence" && <EvidenceView evidence={json} />}
      {json && suffix === "design" && <DesignView design={json} />}
      {json && suffix === "drc-report" && <DrcView report={json} />}
      {json && suffix === "model-report" && <ModelReportView models={json} />}
      {json && suffix === "layout" && <LayoutView layout={json} />}
      {json && suffix === "fab-check" && <FabCheckView check={json} />}
      {json && suffix === "sourced-bom" && <SourcedBomView bom={json} />}
      {json && suffix === "fit-report" && <FitReportView report={json} />}
      {json && suffix === "power-budget" && json.tree && json.report && <PowerView tree={json.tree} report={json.report} />}
      {json && !["erc-report", "component-evidence", "design", "drc-report", "model-report", "layout", "fab-check", "sourced-bom", "power-budget", "fit-report"].includes(suffix) &&
        <pre className="doc">{JSON.stringify(json, null, 2)}</pre>}
      {text !== null && type.startsWith("text/csv") && <CsvTable csv={text} />}
      {text !== null && !json && !type.startsWith("text/csv") && <pre className="doc">{text}</pre>}

      {others.length > 0 && (
        <section>
          <h2>Other outputs of this task</h2>
          <ul className="small">{others.map((s) => (
            <li key={s.id}><Link href={`/projects/${projectId}/artifacts/${s.id}${embed ? "?embed=1" : ""}`}>{(s.artifacts as unknown as { name: string }).name} v{s.version}</Link>
              <span className="muted"> {s.content_type}</span></li>
          ))}</ul>
        </section>
      )}
    </main>
  );
}
