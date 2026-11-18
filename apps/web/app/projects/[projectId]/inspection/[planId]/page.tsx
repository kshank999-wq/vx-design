import Link from "next/link";
import { notFound } from "next/navigation";
import type { InspectionItem } from "@vx/planning";
import { Banner } from "@/components/Banner";
import { SubmitButton } from "@/components/SubmitButton";
import { requireUser } from "@/lib/auth";
import { lotCode } from "@/lib/production";
import { KIND_LABEL, planCode, PLAN_PILL, STAGE_LABEL } from "@/lib/inspection";
import { approvePlan, revisePlan, savePlan } from "../actions";

const STAGES = ["incoming", "in_process", "final"] as const;
const SAMPLES = ["100%", "sample", "first article"] as const;

function ItemFields({ p, i }: { p: string; i?: InspectionItem }) {
  return <>
    <td><select name={`${p}stage`} defaultValue={i?.stage ?? "final"} aria-label={`${p}stage`}>{STAGES.map((s) => <option key={s} value={s}>{STAGE_LABEL[s]}</option>)}</select></td>
    <td><textarea name={`${p}characteristic`} defaultValue={i?.characteristic} rows={3} aria-label={`${p}characteristic`} /></td>
    <td><textarea name={`${p}method`} defaultValue={i?.method} rows={3} aria-label={`${p}method`} /></td>
    <td><select name={`${p}sample`} defaultValue={i?.sample ?? "sample"} aria-label={`${p}sample`}>{SAMPLES.map((s) => <option key={s} value={s}>{s}</option>)}</select></td>
    <td><textarea name={`${p}acceptance`} defaultValue={i?.acceptance} rows={3} aria-label={`${p}acceptance`} /></td>
    <td><input name={`${p}reference`} defaultValue={i?.reference} aria-label={`${p}reference`} /></td>
    <td><input type="checkbox" name={`${p}critical`} defaultChecked={i?.critical} aria-label={`${p}critical`} /></td>
  </>;
}

export default async function PlanPage({ params, searchParams }: {
  params: Promise<{ projectId: string; planId: string }>; searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const { projectId, planId } = await params;
  const { error, notice } = await searchParams;
  const { supabase, userId } = await requireUser();
  const [{ data: project }, { data: me }, { data: p }, { data: lots }] = await Promise.all([
    supabase.from("projects").select("name").eq("id", projectId).maybeSingle(),
    supabase.from("project_members").select("role").eq("project_id", projectId).eq("user_id", userId).maybeSingle(),
    supabase.from("inspection_plans").select("*").eq("id", planId).eq("project_id", projectId).maybeSingle(),
    supabase.from("production_lots").select("id, lot_no").eq("inspection_plan_id", planId).order("lot_no"),
  ]);
  if (!project || !p) notFound();
  const { data: versions } = await supabase.from("inspection_plans").select("id, version, status").eq("project_id", projectId).eq("plan_no", p.plan_no).order("version");
  const role = me?.role ?? "viewer";
  const canEdit = (role === "owner" || role === "engineer") && p.status === "draft";
  const canApprove = (role === "owner" || role === "reviewer") && p.status === "draft";
  const canRevise = (role === "owner" || role === "engineer") && p.status === "approved" && !(versions ?? []).some((v) => v.version > p.version);
  const items = p.items as InspectionItem[];
  const src = p.source as { artifact?: string; version?: number; procedure?: string | null; tolerance?: { basis: string; assumed: boolean } };

  return (
    <main>
      <p className="crumbs"><Link href="/projects">Projects</Link> / <Link href={`/projects/${projectId}`}>{project.name}</Link> /{" "}
        <Link href={`/projects/${projectId}/inspection`}>Inspection plans</Link> /</p>
      <h1>{planCode(p.plan_no, p.version)} {p.title} <span className={`pill pill-${PLAN_PILL[p.status]}`} data-testid="plan-status">{p.status}</span></h1>
      <Banner error={error} notice={notice} />
      <dl className="small">
        <dt>Kind</dt><dd>{KIND_LABEL[p.kind]}</dd>
        <dt>Drafted from</dt><dd>{src.artifact ? `${src.artifact} v${src.version}` : "—"}{src.procedure && `; production test ${src.procedure}`}</dd>
        {src.tolerance && <><dt>Tolerance</dt><dd>{src.tolerance.basis}{src.tolerance.assumed && <strong> (assumed)</strong>}</dd></>}
        {p.approved_at && <><dt>Approved</dt><dd>{new Date(p.approved_at).toLocaleString()}{p.approval_note && ` — ${p.approval_note}`}</dd></>}
        <dt>Versions</dt><dd>{(versions ?? []).map((v, k) => <span key={v.id}>{k > 0 && ", "}{v.id === p.id ? <strong>v{v.version}</strong>
          : <Link href={`/projects/${projectId}/inspection/${v.id}`}>v{v.version}</Link>} ({v.status})</span>)}</dd>
        <dt>Lots</dt><dd>{lots?.length ? lots.map((l, k) => <span key={l.id}>{k > 0 && ", "}<Link href={`/projects/${projectId}/production/${l.id}`}>{lotCode(l.lot_no)}</Link></span>) : "none"}</dd>
      </dl>
      <p><a className="btn" href={`/projects/${projectId}/inspection/${p.id}/csv`} data-testid="plan-csv">Download CSV</a></p>

      {canEdit ? (
        <form action={savePlan.bind(null, projectId, p.id, p.kind)} className="stack">
          <label>Title<input name="title" defaultValue={p.title} required aria-label="Plan title" /></label>
          <input type="hidden" name="count" value={items.length} />
          <table className="small" data-testid="plan-items">
            <thead><tr><th>Stage</th><th>Characteristic</th><th>Method</th><th>Sample</th><th>Acceptance</th><th>Reference</th><th>Critical</th><th>Remove</th></tr></thead>
            <tbody>
              {items.map((i, k) => <tr key={i.key} data-key={i.key}><ItemFields p={`${k}_`} i={i} />
                <td><input type="hidden" name={`${k}_key`} value={i.key} /><input type="checkbox" name={`${k}_remove`} aria-label={`Remove ${i.key}`} /></td></tr>)}
              <tr data-key="new"><ItemFields p="new_" /><td className="muted">new</td></tr>
            </tbody>
          </table>
          <div><SubmitButton pendingText="Saving…">Save plan</SubmitButton></div>
        </form>
      ) : (
        <table className="small" data-testid="plan-items">
          <thead><tr><th>Stage</th><th>Characteristic</th><th>Method</th><th>Sample</th><th>Acceptance</th><th>Reference</th></tr></thead>
          <tbody>{items.map((i) => <tr key={i.key} data-key={i.key}>
            <td>{STAGE_LABEL[i.stage]}</td><td>{i.characteristic}{i.critical && <> <span className="pill pill-failed">critical</span></>}</td>
            <td>{i.method}</td><td>{i.sample}</td><td>{i.acceptance}</td><td className="muted">{i.reference}</td></tr>)}</tbody>
        </table>
      )}

      {canApprove && (
        <form action={approvePlan.bind(null, projectId, p.id)} className="card stack">
          <h2>Approve</h2>
          <label>Note<input name="note" aria-label="Approval note" /></label>
          <p className="small muted">Approval freezes this version and supersedes the currently approved {(KIND_LABEL[p.kind] ?? p.kind).toLowerCase()} plan, if any.</p>
          <div><SubmitButton pendingText="Approving…">Approve plan</SubmitButton></div>
        </form>
      )}
      {canRevise && (
        <form action={revisePlan.bind(null, projectId, p.id)}><SubmitButton variant="secondary" pendingText="…">Revise (new version)</SubmitButton></form>
      )}
    </main>
  );
}
