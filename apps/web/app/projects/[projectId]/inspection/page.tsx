import Link from "next/link";
import { notFound } from "next/navigation";
import { Banner } from "@/components/Banner";
import { SubmitButton } from "@/components/SubmitButton";
import { requireUser } from "@/lib/auth";
import { KIND_LABEL, planCode, PLAN_PILL } from "@/lib/inspection";
import { draftFromEnclosure, draftFromFab } from "./actions";

export default async function InspectionPage({ params, searchParams }: {
  params: Promise<{ projectId: string }>; searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const { projectId } = await params;
  const { error, notice } = await searchParams;
  const { supabase, userId } = await requireUser();
  const committed = (suffix: string) => supabase.from("artifact_versions").select("id, artifacts!inner(name)", { count: "exact", head: true })
    .eq("project_id", projectId).eq("status", "committed").like("artifacts.name", `%/${suffix}`);
  const [{ data: project }, { data: me }, { data: plans }, { data: procs }, { count: fabs }, { count: fits }] = await Promise.all([
    supabase.from("projects").select("name").eq("id", projectId).maybeSingle(),
    supabase.from("project_members").select("role").eq("project_id", projectId).eq("user_id", userId).maybeSingle(),
    supabase.from("inspection_plans").select("id, plan_no, version, kind, title, status, items, source, approved_at")
      .eq("project_id", projectId).order("plan_no", { ascending: false }).order("version", { ascending: false }),
    supabase.from("test_procedures").select("id, code, version, title").eq("project_id", projectId).eq("status", "approved").order("code"),
    committed("fab-check"), committed("fit-report"),
  ]);
  if (!project) notFound();
  const canEdit = me?.role === "owner" || me?.role === "engineer";
  const hasFab = !!fabs, hasFit = !!fits;

  return (
    <main>
      <p className="crumbs"><Link href="/projects">Projects</Link> / <Link href={`/projects/${projectId}`}>{project.name}</Link> /</p>
      <h1>Inspection plans</h1>
      <p className="muted">What to check on bare boards, assembled boards and enclosures: each item names the characteristic, the method, when
        it is checked, how many and what is acceptable. Drafts are built from the committed fab package or enclosure fit report, so each item
        traces to a fact of the design; tolerances not taken from a supplier say so. An approved plan is frozen and can be given to the supplier
        as CSV; production lots name the plan they are inspected against.</p>
      <Banner error={error} notice={notice} />

      <section>
        <table className="small" data-testid="plans">
          <thead><tr><th>Plan</th><th>Kind</th><th>Title</th><th>Items</th><th>Source</th><th>Status</th></tr></thead>
          <tbody>{(plans ?? []).map((p) => {
            const items = p.items as { critical: boolean }[];
            const src = p.source as { artifact?: string; version?: number };
            return <tr key={p.id} data-plan={planCode(p.plan_no, p.version)} data-status={p.status}>
              <td><Link href={`/projects/${projectId}/inspection/${p.id}`}>{planCode(p.plan_no, p.version)}</Link></td>
              <td>{KIND_LABEL[p.kind]}</td><td>{p.title}</td>
              <td>{items.length} ({items.filter((i) => i.critical).length} critical)</td>
              <td>{src.artifact ? `${src.artifact} v${src.version}` : "—"}</td>
              <td><span className={`pill pill-${PLAN_PILL[p.status]}`}>{p.status}</span></td>
            </tr>;
          })}{!plans?.length && <tr><td colSpan={6} className="muted">No inspection plans yet.</td></tr>}</tbody>
        </table>
      </section>

      {canEdit && (
        <section className="grid2">
          <form action={draftFromFab.bind(null, projectId)} className="card stack">
            <h2>Draft from the fab package</h2>
            {hasFab ? <>
              <label>Kind<select name="kind" defaultValue="pcba" aria-label="Board plan kind">
                <option value="pcba">assembled board (PCBA)</option><option value="bare_pcb">bare board only</option></select></label>
              <label>Title<input name="title" aria-label="Board plan title" placeholder="Assembled board" /></label>
              <label>Production test<select name="procedure" defaultValue={procs?.[0]?.id ?? ""} aria-label="Production test">
                <option value="">none yet</option>
                {(procs ?? []).map((p) => <option key={p.id} value={p.id}>{p.code} v{p.version} {p.title}</option>)}</select></label>
              <div><SubmitButton pendingText="Drafting…">Draft board plan</SubmitButton></div>
            </> : <p className="small muted">No committed fab package yet.</p>}
          </form>
          <form action={draftFromEnclosure.bind(null, projectId)} className="card stack">
            <h2>Draft from the enclosure</h2>
            {hasFit ? <>
              <label>Title<input name="title" aria-label="Enclosure plan title" placeholder="Enclosure" /></label>
              <p className="small muted">Tolerances come from the loosest supplier process rules recorded for the enclosure&apos;s process, or a
                typical figure marked as assumed.</p>
              <div><SubmitButton pendingText="Drafting…">Draft enclosure plan</SubmitButton></div>
            </> : <p className="small muted">No committed enclosure fit report yet.</p>}
          </form>
        </section>
      )}
    </main>
  );
}
