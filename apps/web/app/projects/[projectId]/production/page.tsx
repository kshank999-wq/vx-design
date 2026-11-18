import Link from "next/link";
import { notFound } from "next/navigation";
import { Banner } from "@/components/Banner";
import { SubmitButton } from "@/components/SubmitButton";
import { requireUser } from "@/lib/auth";
import { LOT_STATUS, lotCode, pct, type LotSummary } from "@/lib/production";
import { createLot } from "./actions";

export default async function ProductionPage({ params, searchParams }: {
  params: Promise<{ projectId: string }>; searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const { projectId } = await params;
  const { error, notice } = await searchParams;
  const { supabase, userId } = await requireUser();
  const [{ data: project }, { data: me }, { data: lots }, { data: releases }, { data: procs }] = await Promise.all([
    supabase.from("projects").select("name").eq("id", projectId).maybeSingle(),
    supabase.from("project_members").select("role").eq("project_id", projectId).eq("user_id", userId).maybeSingle(),
    supabase.from("production_lots").select("*, releases(revision, status)").eq("project_id", projectId).order("lot_no", { ascending: false }),
    supabase.from("releases").select("id, revision").eq("project_id", projectId).eq("status", "released"),
    supabase.from("test_procedures").select("id, code, version, title").eq("project_id", projectId).eq("status", "approved").order("code"),
  ]);
  if (!project) notFound();
  const canEdit = me?.role === "owner" || me?.role === "engineer";
  const { data: makers } = canEdit ? await supabase.from("manufacturers").select("id, display_name").order("display_name") : { data: [] };
  const summaries = await Promise.all((lots ?? []).map(async (l) => [l.id, (await supabase.rpc("lot_summary", { p_lot: l.id })).data as LotSummary] as const));
  const sum = new Map(summaries);
  const current = releases?.[0];

  return (
    <main>
      <p className="crumbs"><Link href="/projects">Projects</Link> / <Link href={`/projects/${projectId}`}>{project.name}</Link> /</p>
      <h1>Production</h1>
      <p className="muted">Pilot and production lots built from a released revision: serial-numbered units, the production (test jig) procedure
        each unit runs, incoming and final inspections against a sampling plan, and yield. Any serial number traces back to its lot, revision,
        files and test results.</p>
      <Banner error={error} notice={notice} />

      <form action={`/projects/${projectId}/production/trace`} className="row tight" data-testid="trace-form">
        <label className="inline">Trace a serial number<input name="serial" required aria-label="Serial number to trace" /></label>
        <button className="btn" type="submit">Trace</button>
      </form>

      <table className="small" data-testid="lots">
        <thead><tr><th>Lot</th><th>Revision</th><th>Units</th><th>Production test</th><th>Status</th></tr></thead>
        <tbody>{(lots ?? []).map((l) => {
          const s = sum.get(l.id);
          const rel = l.releases as unknown as { revision: string; status: string };
          return (
            <tr key={l.id} data-lot={lotCode(l.lot_no)} data-status={l.status}>
              <td><Link href={`/projects/${projectId}/production/${l.id}`}><strong>{lotCode(l.lot_no)}</strong></Link> {l.kind}</td>
              <td>Rev {rel.revision}{rel.status !== "released" && <span className="muted"> ({rel.status})</span>}</td>
              <td>{s?.units ?? 0} of {l.quantity}</td>
              <td>{s && s.tested ? `${s.passing}/${s.units} passing · first-pass yield ${pct(s.first_pass, s.tested)}` : l.procedure_id ? "not tested yet" : "no production test set"}</td>
              <td><span className={`pill pill-${LOT_STATUS[l.status]?.[1] ?? ""}`}>{LOT_STATUS[l.status]?.[0] ?? l.status}</span></td>
            </tr>
          );
        })}{!lots?.length && <tr><td colSpan={5} className="muted">No lots yet.</td></tr>}</tbody>
      </table>

      {canEdit && (
        <details className="card" open={!lots?.length}><summary>Plan a lot</summary>
          {!current ? <p className="small">Lots are built from a released revision. <Link href={`/projects/${projectId}/releases`}>Issue a release</Link> first.</p> : (
            <form action={createLot.bind(null, projectId)} className="stack">
              <input type="hidden" name="release" value={current.id} />
              <p className="small">Built from <strong>Rev {current.revision}</strong> (the current release).</p>
              <div className="grid2">
                <label>Kind<select name="kind" defaultValue={lots?.length ? "production" : "pilot"} aria-label="Lot kind"><option value="pilot">pilot</option><option value="production">production</option></select></label>
                <label>Quantity<input name="quantity" type="number" min={1} required aria-label="Quantity" /></label>
                <label>Inspection sample size<input name="sample_size" type="number" min={1} required aria-label="Sample size" /></label>
                <label>Defects allowed in the sample<input name="accept_max" type="number" min={0} defaultValue={0} aria-label="Accept number" /></label>
                <label>Production test<select name="procedure" defaultValue="" aria-label="Production test procedure"><option value="">(none)</option>
                  {(procs ?? []).map((p) => <option key={p.id} value={p.id}>{p.code} v{p.version} {p.title}</option>)}</select></label>
                <label>Assembler (directory)<select name="manufacturer" defaultValue="" aria-label="Assembler"><option value="">(not in the directory)</option>
                  {(makers ?? []).map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}</select></label>
                <label>Assembler (name)<input name="built_by" aria-label="Assembler name" /></label>
              </div>
              <label>Notes<input name="notes" aria-label="Lot notes" /></label>
              <p className="small muted">The sampling plan: inspect at least the sample size; the lot passes if the defects found do not exceed the
                number allowed. Set these from your quality standard (for example an AQL table).</p>
              <div><SubmitButton pendingText="Saving…">Plan lot</SubmitButton></div>
            </form>
          )}
        </details>
      )}
    </main>
  );
}
