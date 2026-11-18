import Link from "next/link";
import { notFound } from "next/navigation";
import { Banner } from "@/components/Banner";
import { ReleaseFiles } from "@/components/ReleaseFiles";
import { SubmitButton } from "@/components/SubmitButton";
import { requireUser } from "@/lib/auth";
import { lotCode, RELEASE_STATUS, type ManifestFile, type ReadinessItem } from "@/lib/production";
import { committedFiles } from "@/lib/releases";
import { issueRelease, saveRelease, withdrawRelease } from "../actions";

export default async function ReleasePage({ params, searchParams }: {
  params: Promise<{ projectId: string; releaseId: string }>; searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const { projectId, releaseId } = await params;
  const { error, notice } = await searchParams;
  const { supabase, userId } = await requireUser();
  const [{ data: project }, { data: me }, { data: r }, { data: lots }] = await Promise.all([
    supabase.from("projects").select("name").eq("id", projectId).maybeSingle(),
    supabase.from("project_members").select("role").eq("project_id", projectId).eq("user_id", userId).maybeSingle(),
    supabase.from("releases").select("*").eq("id", releaseId).eq("project_id", projectId).maybeSingle(),
    supabase.from("production_lots").select("id, lot_no, kind, status, quantity").eq("release_id", releaseId).order("lot_no"),
  ]);
  if (!project || !r) notFound();
  const role = me?.role ?? "viewer";
  const canEdit = role === "owner" || role === "engineer";
  const draft = r.status === "draft";
  const readiness = (draft ? (await supabase.rpc("check_release_readiness", { p_release: releaseId })).data : r.readiness) as ReadinessItem[] | null ?? [];
  const blocks = readiness.filter((x) => x.severity === "block");
  const files = draft && canEdit ? await committedFiles(supabase, projectId) : [];
  const manifest = (r.manifest ?? []) as ManifestFile[];

  return (
    <main>
      <p className="crumbs"><Link href="/projects">Projects</Link> / <Link href={`/projects/${projectId}`}>{project.name}</Link> /{" "}
        <Link href={`/projects/${projectId}/releases`}>Releases</Link> /</p>
      <h1>Rev {r.revision} <span className={`pill pill-${RELEASE_STATUS[r.status] ?? ""}`} data-testid="release-status">{r.status}</span></h1>
      <Banner error={error} notice={notice} />
      {r.notes && <p>{r.notes}</p>}
      {r.status === "withdrawn" && <p className="banner banner-error">Withdrawn: {r.withdrawn_reason}</p>}

      <section>
        <h2>{draft ? "Readiness" : "Readiness when issued"}</h2>
        <ul className="list small" data-testid="readiness">{readiness.map((x, i) => (
          <li key={i} data-severity={x.severity}><span className={`pill pill-${x.severity === "block" ? "failed" : "awaiting_approval"}`}>{x.severity === "block" ? "blocker" : "warning"}</span> {x.text}</li>
        ))}{!readiness.length && <li className="muted">Nothing outstanding.</li>}</ul>
        {r.waiver && <p className="small">Released despite blockers: <strong>{r.waiver}</strong></p>}
        {r.decision_id && <p className="small">Recorded as a project decision.</p>}
      </section>

      {draft ? (
        <>
          {canEdit && (
            <section>
              <h2>Files</h2>
              <form action={saveRelease.bind(null, projectId, releaseId)} className="stack">
                <div className="grid2">
                  <label>Revision<input name="revision" required defaultValue={r.revision} aria-label="Revision" /></label>
                  <label>Notes<input name="notes" defaultValue={r.notes ?? ""} aria-label="Release notes" /></label>
                </div>
                <ReleaseFiles files={files} chosen={r.version_ids as string[]} />
                <div><SubmitButton variant="secondary" pendingText="Saving…">Save draft</SubmitButton></div>
              </form>
            </section>
          )}
          {role === "owner" && (
            <section className="card">
              <h2>Issue</h2>
              <form action={issueRelease.bind(null, projectId, releaseId)} className="stack">
                {blocks.length > 0 && <label>{blocks.length} blocker(s): the reason for releasing anyway
                  <textarea name="waiver" required rows={2} aria-label="Reason for releasing despite blockers" /></label>}
                <p className="small muted">Issuing freezes the file list and checksums and supersedes the current release.</p>
                <div><SubmitButton pendingText="Issuing…">Issue Rev {r.revision}</SubmitButton></div>
              </form>
            </section>
          )}
        </>
      ) : (
        <section>
          <h2>Files</h2>
          <table className="small" data-testid="manifest">
            <thead><tr><th>File</th><th>Kind</th><th>Version</th><th>sha256</th></tr></thead>
            <tbody>{manifest.map((f) => (
              <tr key={f.version_id}><td><Link href={`/projects/${projectId}/artifacts/${f.version_id}`}>{f.artifact}</Link></td><td>{f.kind.replace("_", " ")}</td>
                <td>v{f.version}</td><td className="muted"><code>{f.sha256}</code></td></tr>
            ))}</tbody>
          </table>
          <p className="small">Manifest sha256 <code data-testid="manifest-sha">{r.manifest_sha256}</code>, released {new Date(r.released_at!).toLocaleString()}.</p>
          <h2>Production lots</h2>
          <ul className="list small">{(lots ?? []).map((l) => (
            <li key={l.id}><Link href={`/projects/${projectId}/production/${l.id}`}>{lotCode(l.lot_no)}</Link> {l.kind}, {l.quantity} units, {l.status.replace("_", " ")}</li>
          ))}{!lots?.length && <li className="muted">None yet. <Link href={`/projects/${projectId}/production`}>Plan a lot</Link>.</li>}</ul>
        </section>
      )}

      {role === "owner" && r.status !== "withdrawn" && (
        <details className="small"><summary>{draft ? "Delete this draft" : "Withdraw this release"}</summary>
          <form action={withdrawRelease.bind(null, projectId, releaseId)} className="stack">
            <label>Reason<input name="reason" required aria-label="Reason for withdrawing" /></label>
            <div><SubmitButton variant="secondary" pendingText="…">{draft ? "Delete draft" : "Withdraw"}</SubmitButton></div>
          </form>
        </details>
      )}
    </main>
  );
}
