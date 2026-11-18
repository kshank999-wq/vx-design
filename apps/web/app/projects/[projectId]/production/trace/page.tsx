import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { lotCode, type ManifestFile } from "@/lib/production";

interface Trace {
  unit: { id: string; serial: string; revision: string; status: string; received_at: string | null; assembled_by: string | null; lot: string | null; created_at: string };
  lot: { id: string; lot_no: number; kind: string; status: string; built_by: string | null } | null;
  release: { id: string; revision: string; status: string; released_at: string | null; manifest_sha256: string | null; files: ManifestFile[] | null } | null;
  built_from: { id: string; artifact: string; version: number; sha256: string } | null;
  runs: { id: string; run_no: number; procedure: string; version: number; title: string; verdict: string; performed_at: string }[];
  faults: { fault_no: number; title: string; status: string; severity: string }[];
}

export default async function TracePage({ params, searchParams }: {
  params: Promise<{ projectId: string }>; searchParams: Promise<{ serial?: string }>;
}) {
  const { projectId } = await params;
  const serial = ((await searchParams).serial ?? "").trim();
  const { supabase } = await requireUser();
  const { data: project } = await supabase.from("projects").select("name").eq("id", projectId).maybeSingle();
  if (!project) notFound();
  const t = serial ? ((await supabase.rpc("trace_unit", { p_project: projectId, p_serial: serial })).data as Trace | null) : null;

  return (
    <main>
      <p className="crumbs"><Link href="/projects">Projects</Link> / <Link href={`/projects/${projectId}`}>{project.name}</Link> /{" "}
        <Link href={`/projects/${projectId}/production`}>Production</Link> /</p>
      <h1>Trace {serial || "a unit"}</h1>
      <form className="row tight">
        <label className="inline">Serial number<input name="serial" defaultValue={serial} required aria-label="Serial number to trace" /></label>
        <button className="btn" type="submit">Trace</button>
      </form>
      {serial && !t && <p className="banner banner-error">No unit with serial {serial} in this project.</p>}
      {t && (
        <div data-testid="trace">
          <dl>
            <dt>Unit</dt><dd><strong>{t.unit.serial}</strong>, revision {t.unit.revision}, {t.unit.status.replace("_", " ")}{t.unit.assembled_by && `, built by ${t.unit.assembled_by}`}</dd>
            <dt>Lot</dt><dd>{t.lot ? <Link href={`/projects/${projectId}/production/${t.lot.id}`}>{lotCode(t.lot.lot_no)}</Link> : t.unit.lot ?? "—"}
              {t.lot && ` (${t.lot.kind}, ${t.lot.status.replace("_", " ")})`}</dd>
            <dt>Release</dt><dd>{t.release ? <><Link href={`/projects/${projectId}/releases/${t.release.id}`}>Rev {t.release.revision}</Link> ({t.release.status})
              {t.release.manifest_sha256 && <span className="muted"> manifest sha256 {t.release.manifest_sha256.slice(0, 12)}</span>}</> : "no release recorded for this revision"}</dd>
            <dt>Built from</dt><dd>{t.built_from ? <Link href={`/projects/${projectId}/artifacts/${t.built_from.id}`}>{t.built_from.artifact} v{t.built_from.version}</Link> : "—"}</dd>
          </dl>
          {t.release?.files && (
            <details className="small"><summary>Released files ({t.release.files.length})</summary>
              <ul>{t.release.files.map((f) => <li key={f.version_id}>{f.artifact} v{f.version} <code className="muted">{f.sha256.slice(0, 16)}</code></li>)}</ul>
            </details>
          )}
          <h2>Tests</h2>
          <table className="small" data-testid="trace-runs">
            <thead><tr><th>Run</th><th>Procedure</th><th>Performed</th><th>Result</th></tr></thead>
            <tbody>{t.runs.map((r) => (
              <tr key={r.id}><td><Link href={`/projects/${projectId}/validation/runs/${r.id}`}>run {r.run_no}</Link></td><td>{r.procedure} v{r.version} {r.title}</td>
                <td>{new Date(r.performed_at).toLocaleString()}</td><td><span className={`pill pill-verdict-${r.verdict}`}>{r.verdict}</span></td></tr>
            ))}{!t.runs.length && <tr><td colSpan={4} className="muted">No tests recorded.</td></tr>}</tbody>
          </table>
          <h2>Faults</h2>
          <ul className="small">{t.faults.map((f) => <li key={f.fault_no}>F-{String(f.fault_no).padStart(3, "0")} ({f.severity}, {f.status.replace("_", " ")}) {f.title}</li>)}
            {!t.faults.length && <li className="muted">None.</li>}</ul>
        </div>
      )}
    </main>
  );
}
