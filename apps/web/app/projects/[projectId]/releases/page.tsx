import Link from "next/link";
import { notFound } from "next/navigation";
import { Banner } from "@/components/Banner";
import { ReleaseFiles } from "@/components/ReleaseFiles";
import { SubmitButton } from "@/components/SubmitButton";
import { requireUser } from "@/lib/auth";
import { RELEASE_STATUS } from "@/lib/production";
import { committedFiles } from "@/lib/releases";
import { saveRelease } from "./actions";

export default async function ReleasesPage({ params, searchParams }: {
  params: Promise<{ projectId: string }>; searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const { projectId } = await params;
  const { error, notice } = await searchParams;
  const { supabase, userId } = await requireUser();
  const [{ data: project }, { data: me }, { data: releases }] = await Promise.all([
    supabase.from("projects").select("name").eq("id", projectId).maybeSingle(),
    supabase.from("project_members").select("role").eq("project_id", projectId).eq("user_id", userId).maybeSingle(),
    supabase.from("releases").select("*").eq("project_id", projectId).order("release_no", { ascending: false }),
  ]);
  if (!project) notFound();
  const canEdit = me?.role === "owner" || me?.role === "engineer";
  const files = canEdit ? await committedFiles(supabase, projectId) : [];
  const next = String.fromCharCode(65 + Math.min(25, (releases ?? []).filter((r) => r.status !== "draft").length));

  return (
    <main>
      <p className="crumbs"><Link href="/projects">Projects</Link> / <Link href={`/projects/${projectId}`}>{project.name}</Link> /</p>
      <h1>Releases</h1>
      <p className="muted">A release locks a revision: the approved files that make the product (fab package, BOM, enclosure), frozen with their
        checksums under a revision label. Production lots are built from the current release and lab results name the revision they tested.
        Issuing a release checks for unverified faults, failing requirements and failed compliance, and is the owner&apos;s call.</p>
      <Banner error={error} notice={notice} />
      <table className="small" data-testid="releases">
        <thead><tr><th>Revision</th><th>Status</th><th>Files</th><th>Released</th><th>Manifest</th></tr></thead>
        <tbody>{(releases ?? []).map((r) => (
          <tr key={r.id} data-revision={r.revision} data-status={r.status}>
            <td><Link href={`/projects/${projectId}/releases/${r.id}`}><strong>Rev {r.revision}</strong></Link>{r.notes && <span className="muted"> {r.notes}</span>}</td>
            <td><span className={`pill pill-${RELEASE_STATUS[r.status] ?? ""}`}>{r.status}</span>{r.waiver && <span className="pill pill-failed" title={r.waiver}>waiver</span>}</td>
            <td>{r.manifest ? (r.manifest as unknown[]).length : (r.version_ids as string[]).length}</td>
            <td>{r.released_at ? new Date(r.released_at).toLocaleDateString() : "—"}</td>
            <td className="muted">{r.manifest_sha256 ? `sha256 ${r.manifest_sha256.slice(0, 12)}` : "—"}</td>
          </tr>
        ))}{!releases?.length && <tr><td colSpan={5} className="muted">No releases yet.</td></tr>}</tbody>
      </table>
      {canEdit && (
        <details className="card" open={!releases?.length}><summary>Prepare a release</summary>
          <form action={saveRelease.bind(null, projectId, null)} className="stack">
            <div className="grid2">
              <label>Revision<input name="revision" required defaultValue={next} pattern="[A-Za-z0-9][A-Za-z0-9._\-]{0,19}" aria-label="Revision" /></label>
              <label>Notes<input name="notes" placeholder="e.g. Pilot run, 50 units" aria-label="Release notes" /></label>
            </div>
            <ReleaseFiles files={files} />
            <div><SubmitButton pendingText="Saving…">Make draft</SubmitButton></div>
          </form>
        </details>
      )}
    </main>
  );
}
