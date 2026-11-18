import Link from "next/link";
import { notFound } from "next/navigation";
import { Banner } from "@/components/Banner";
import { SubmitButton } from "@/components/SubmitButton";
import { requireUser } from "@/lib/auth";
import { createAudit } from "./actions";

export default async function FluxAuditsPage({ params, searchParams }: {
  params: Promise<{ projectId: string }>; searchParams: Promise<{ error?: string }>;
}) {
  const { projectId } = await params;
  const { error } = await searchParams;
  const { supabase, userId } = await requireUser();
  const [{ data: project }, { data: me }, { data: audits }] = await Promise.all([
    supabase.from("projects").select("id, name").eq("id", projectId).maybeSingle(),
    supabase.from("project_members").select("role").eq("project_id", projectId).eq("user_id", userId).maybeSingle(),
    supabase.from("flux_audits").select("id, audit_no, title, status, summary, completed_at, flux_audit_files(count)").eq("project_id", projectId).order("audit_no", { ascending: false }),
  ]);
  if (!project) notFound();
  const canEdit = me?.role === "owner" || me?.role === "engineer";
  return (
    <main>
      <p className="crumbs"><Link href="/projects">Projects</Link> / <Link href={`/projects/${projectId}`}>{project.name}</Link> /</p>
      <h1>Flux import and audit</h1>
      <p className="muted">Bring in work done in Flux: what was exported, what is consistent and what is uncertain, what changed between revisions,
        which earlier decisions and test claims have evidence, and a migration plan. An imported design is never treated as verified.</p>
      <Banner error={error} />
      <table data-testid="audits">
        <thead><tr><th>Import</th><th>Files</th><th>Status</th><th>Result</th></tr></thead>
        <tbody>
          {(audits ?? []).map((a) => {
            const s = a.summary as { blockers?: number; warnings?: number; uncertain?: number; components?: number };
            return (
              <tr key={a.id}>
                <td><Link href={`/projects/${projectId}/flux/${a.id}`}>#{a.audit_no} {a.title}</Link></td>
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
          <label style={{ flex: 1 }}>Title<input name="title" required placeholder="Smart Slate work in Flux" /></label>
          <SubmitButton pendingText="Creating…">New import</SubmitButton>
        </form>
      )}
    </main>
  );
}
