import Link from "next/link";
import { notFound } from "next/navigation";
import { AutoRefresh } from "@/components/AutoRefresh";
import { Banner } from "@/components/Banner";
import { SubmitButton } from "@/components/SubmitButton";
import { requireUser } from "@/lib/auth";
import { createAudit } from "./actions";
import { IMPORT_SOURCES, sourceOf } from "@/lib/import-sources";

export default async function FluxAuditsPage({ params, searchParams }: {
  params: Promise<{ projectId: string }>; searchParams: Promise<{ error?: string }>;
}) {
  const { projectId } = await params;
  const { error } = await searchParams;
  const { supabase, userId } = await requireUser();
  const [{ data: project }, { data: me }, { data: audits }] = await Promise.all([
    supabase.from("projects").select("id, name").eq("id", projectId).maybeSingle(),
    supabase.from("project_members").select("role").eq("project_id", projectId).eq("user_id", userId).maybeSingle(),
    supabase.from("flux_audits").select("id, audit_no, title, status, summary, completed_at, source_tool, flux_audit_files(count)").eq("project_id", projectId).order("audit_no", { ascending: false }),
  ]);
  if (!project) notFound();
  const canEdit = me?.role === "owner" || me?.role === "engineer";
  return (
    <main>
      <p className="crumbs"><Link href="/projects">Projects</Link> / <Link href={`/projects/${projectId}`}>{project.name}</Link> /</p>
      <div className="row spread"><h1>Import existing designs</h1>{(audits ?? []).some((a) => a.status === "queued" || a.status === "running") && <AutoRefresh intervalMs={3000} />}</div>
      <p className="muted">Bring in work done before or elsewhere: KiCad, Eagle and Fusion, Altium, EasyEDA, PADS, CADSTAR, Allegro, Flux, SolidWorks and
        other 3D tools, or any tool&apos;s manufacturing exports. Boards from other tools are converted to KiCad and checked; 3D models are measured; exports
        are checked against each other and across revisions, with earlier decisions and test claims and a migration plan. An imported design is never
        treated as verified.</p>
      <details className="card small" data-testid="import-sources"><summary>What to export from each tool</summary>
        <dl className="facts">{IMPORT_SOURCES.flatMap((s) => [<dt key={`${s.id}-t`}>{s.label}</dt>, <dd key={`${s.id}-d`}>{s.files}</dd>])}</dl></details>
      <Banner error={error} />
      <table data-testid="audits">
        <thead><tr><th>Import</th><th>Files</th><th>Status</th><th>Result</th></tr></thead>
        <tbody>
          {(audits ?? []).map((a) => {
            const s = a.summary as { blockers?: number; warnings?: number; uncertain?: number; components?: number };
            return (
              <tr key={a.id}>
                <td><Link href={`/projects/${projectId}/flux/${a.id}`}>#{a.audit_no} {a.title}</Link> <span className="muted small">{sourceOf(a.source_tool).label}</span></td>
                <td>{(a.flux_audit_files as unknown as { count: number }[])[0]?.count ?? 0}</td>
                <td><span className={`pill pill-${a.status === "ready" ? "complete" : a.status === "failed" ? "failed" : "awaiting_approval"}`}>{a.status}</span></td>
                <td className="small">{a.status === "ready" ? `${s.blockers ?? 0} blocker(s), ${s.warnings ?? 0} warning(s); ${s.uncertain ?? 0} of ${s.components ?? 0} parts uncertain` : "—"}</td>
              </tr>
            );
          })}
          {!audits?.length && <tr><td colSpan={4} className="muted">No imports yet.</td></tr>}
        </tbody>
      </table>
      {canEdit && (
        <form action={createAudit.bind(null, projectId)} className="card row">
          <label style={{ flex: 1 }}>Title<input name="title" required placeholder="Smart Slate rev C board" /></label>
          <label>Comes from<select name="source_tool" defaultValue="kicad" aria-label="Comes from">{IMPORT_SOURCES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select></label>
          <SubmitButton pendingText="Creating…">New import</SubmitButton>
        </form>
      )}
    </main>
  );
}
