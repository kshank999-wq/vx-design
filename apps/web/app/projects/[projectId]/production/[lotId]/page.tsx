import Link from "next/link";
import { SectionTabs } from "@/components/SectionTabs";
import { notFound } from "next/navigation";
import { Banner } from "@/components/Banner";
import { SubmitButton } from "@/components/SubmitButton";
import { requireUser } from "@/lib/auth";
import { LOT_STATUS, lotCode, pct, type LotSummary } from "@/lib/production";
import type { InspectionItem } from "@vx/planning";
import { planCode, STAGE_LABEL } from "@/lib/inspection";
import { setLotPlan } from "../../inspection/actions";
import { addUnits, recordInspection, setDelivery, setLotStatus } from "../actions";

export default async function LotPage({ params, searchParams }: {
  params: Promise<{ projectId: string; lotId: string }>; searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const { projectId, lotId } = await params;
  const { error, notice } = await searchParams;
  const { supabase, userId } = await requireUser();
  const [{ data: project }, { data: me }, { data: l }, { data: units }, { data: inspections }, { data: summary }, { data: plans }] = await Promise.all([
    supabase.from("projects").select("name").eq("id", projectId).maybeSingle(),
    supabase.from("project_members").select("role").eq("project_id", projectId).eq("user_id", userId).maybeSingle(),
    supabase.from("production_lots").select("*, releases(id, revision, status), test_procedures(id, code, version, title), manufacturers(display_name)")
      .eq("id", lotId).eq("project_id", projectId).maybeSingle(),
    supabase.from("units").select("id, serial, status").eq("lot_id", lotId).order("serial"),
    supabase.from("lot_inspections").select("*").eq("lot_id", lotId).order("inspected_at", { ascending: false }),
    supabase.rpc("lot_summary", { p_lot: lotId }),
    supabase.from("inspection_plans").select("id, plan_no, version, kind, title, status, items").eq("project_id", projectId).in("status", ["approved", "superseded"])
      .order("plan_no").order("version"),
  ]);
  if (!project || !l) notFound();
  const role = me?.role ?? "viewer";
  const canEdit = role === "owner" || role === "engineer";
  const canJudge = role === "owner" || role === "reviewer";
  const canInspect = canEdit || role === "reviewer";
  const closed = l.status === "accepted" || l.status === "rejected";
  const rel = l.releases as unknown as { id: string; revision: string; status: string };
  const proc = l.test_procedures as unknown as { id: string; code: string; version: number; title: string } | null;
  const s = summary as LotSummary;
  const ids = (units ?? []).map((u) => u.id);
  const { data: runs } = proc && ids.length
    ? await supabase.from("test_runs").select("id, unit_id, verdict, performed_at, run_no, test_procedures!inner(code)").in("unit_id", ids)
        .eq("test_procedures.code", proc.code).order("performed_at", { ascending: false }).order("run_no", { ascending: false })
    : { data: [] };
  const latest = new Map<string, { id: string; verdict: string }>();
  for (const r of runs ?? []) if (!latest.has(r.unit_id)) latest.set(r.unit_id, r);
  const maker = (l.manufacturers as unknown as { display_name: string } | null)?.display_name ?? l.built_by;
  const n = (units ?? []).length;
  const plan = (plans ?? []).find((x) => x.id === l.inspection_plan_id);
  const planItems = (plan?.items ?? []) as InspectionItem[];
  const prefix = `${project.name.replace(/[^A-Za-z0-9]+/g, "").slice(0, 6).toUpperCase() || "SN"}-${rel.revision}-`;

  return (
    <main>
      <p className="crumbs"><Link href="/projects">Projects</Link> / <Link href={`/projects/${projectId}`}>{project.name}</Link> /{" "}
        <Link href={`/projects/${projectId}/production`}>Production</Link> /</p>
      <h1>{lotCode(l.lot_no)} <span className={`pill pill-${LOT_STATUS[l.status]?.[1] ?? ""}`} data-testid="lot-status">{LOT_STATUS[l.status]?.[0] ?? l.status}</span></h1>
      <Banner error={error} notice={notice} />
      <dl className="small">
        <dt>Kind</dt><dd>{l.kind}, {l.quantity} units{maker && <>, built by {maker}</>}</dd>
        <dt>Revision</dt><dd><Link href={`/projects/${projectId}/releases/${rel.id}`}>Rev {rel.revision}</Link>{rel.status !== "released" && <strong> (this release is {rel.status})</strong>}</dd>
        <dt>Production test</dt><dd>{proc ? <Link href={`/projects/${projectId}/validation/procedures/${proc.id}`}>{proc.code} v{proc.version} {proc.title}</Link> : "none set"}</dd>
        <dt>Delivery</dt><dd data-testid="lot-delivery">{l.promised_on ? `promised ${l.promised_on}` : "no promised date"}{l.delivered_on ? `, delivered ${l.delivered_on}${l.promised_on ? (l.delivered_on <= l.promised_on ? " (on time)" : " (late)") : ""}` : ""}</dd>
        <dt>Inspection plan</dt><dd data-testid="lot-plan">{plan ? <><Link href={`/projects/${projectId}/inspection/${plan.id}`}>{planCode(plan.plan_no, plan.version)} {plan.title}</Link>
          {plan.status !== "approved" && <strong> (superseded by a newer version)</strong>}</> : "none set"}</dd>
        <dt>Sampling plan</dt><dd>inspect {l.sample_size}, accept with at most {l.accept_max_defects} defect(s)</dd>
        {l.status_note && <><dt>Note</dt><dd>{l.status_note}</dd></>}
      </dl>
      {canEdit && (
        <details className="small"><summary>Delivery dates</summary>
          <form action={setDelivery.bind(null, projectId, lotId)} className="row tight">
            <label className="inline">Promised<input name="promised_on" type="date" defaultValue={l.promised_on ?? ""} aria-label="Promised date" /></label>
            <label className="inline">Delivered<input name="delivered_on" type="date" defaultValue={l.delivered_on ?? ""} aria-label="Delivered date" /></label>
            <SubmitButton variant="secondary" pendingText="…">Save dates</SubmitButton>
          </form>
        </details>
      )}
      <p data-testid="lot-summary">{s.units} unit(s) registered{s.scrapped ? `, ${s.scrapped} scrapped` : ""}. Production test: {s.tested} tested, {s.passing} passing,
        {" "}{s.failing} failing; first-pass yield {pct(s.first_pass, s.tested)}.</p>

      <SectionTabs id="lot" sections={[
        { key: "units", label: "Units", badge: n || null, content: (<>
      <section>
        <table className="small" data-testid="lot-units">
          <thead><tr><th>Serial</th><th>Status</th><th>Production test</th><th></th></tr></thead>
          <tbody>{(units ?? []).map((u) => {
            const r = latest.get(u.id);
            return <tr key={u.id} data-serial={u.serial}>
              <td><Link href={`/projects/${projectId}/production/trace?serial=${encodeURIComponent(u.serial)}`}>{u.serial}</Link></td>
              <td>{u.status.replace("_", " ")}</td>
              <td>{r ? <Link href={`/projects/${projectId}/validation/runs/${r.id}`}><span className={`pill pill-verdict-${r.verdict}`}>{r.verdict}</span></Link> : <span className="muted">not tested</span>}</td>
              <td>{proc && canInspect && u.status !== "scrapped" && <Link href={`/projects/${projectId}/validation/record?procedure=${proc.id}&unit=${u.id}`}>Record test</Link>}</td>
            </tr>;
          })}{!n && <tr><td colSpan={4} className="muted">No units registered.</td></tr>}</tbody>
        </table>
        {canEdit && !closed && n < l.quantity && (
          <details className="card" open={!n}><summary>Register units</summary>
            <form action={addUnits.bind(null, projectId, lotId)} className="stack">
              <div className="grid2">
                <label>Serial prefix<input name="prefix" required defaultValue={prefix} aria-label="Serial prefix" /></label>
                <label>First number<input name="start" type="number" min={0} required defaultValue={n + 1} aria-label="First number" /></label>
                <label>How many<input name="count" type="number" min={1} max={l.quantity - n} required defaultValue={l.quantity - n} aria-label="Unit count" /></label>
                <label>Digits<input name="digits" type="number" min={1} max={8} defaultValue={4} aria-label="Digits" /></label>
              </div>
              <div><SubmitButton pendingText="Registering…">Register units</SubmitButton></div>
            </form>
          </details>
        )}
      </section>
        </>) },
        { key: "inspections", label: "Inspections", badge: (inspections ?? []).length || null, content: (<>
      <section>
        {plan && (
          <details className="small" data-testid="lot-plan-items"><summary>{planItems.length} check(s) in {planCode(plan.plan_no, plan.version)}</summary>
            <table><thead><tr><th>Stage</th><th>Characteristic</th><th>Method</th><th>Sample</th><th>Acceptance</th></tr></thead>
              <tbody>{planItems.map((i) => <tr key={i.key}><td>{STAGE_LABEL[i.stage]}</td>
                <td>{i.characteristic}{i.critical && <> <span className="pill pill-failed">critical</span></>}</td><td>{i.method}</td><td>{i.sample}</td><td>{i.acceptance}</td></tr>)}</tbody></table>
          </details>
        )}
        {canEdit && !closed && (
          <form action={setLotPlan.bind(null, projectId, lotId)} className="row tight small">
            <label className="inline">Inspect against<select name="plan" defaultValue={l.inspection_plan_id ?? ""} aria-label="Inspection plan">
              <option value="">no plan</option>
              {(plans ?? []).filter((x) => x.status === "approved").map((x) => <option key={x.id} value={x.id}>{planCode(x.plan_no, x.version)} {x.title}</option>)}</select></label>
            <SubmitButton variant="secondary" pendingText="…">Set plan</SubmitButton>
          </form>
        )}
        <ul className="list small" data-testid="inspections">{(inspections ?? []).map((i) => (
          <li key={i.id} data-verdict={i.verdict}><span className={`pill pill-${i.verdict === "accept" ? "complete" : i.verdict === "reject" ? "failed" : "awaiting_approval"}`}>{i.verdict}</span>
            {" "}{i.stage.replace("_", "-")} · {i.inspected} inspected, {i.defects} defect(s) (plan: {i.sample_size}, ≤ {i.accept_max}) · {new Date(i.inspected_at).toLocaleString()}
            {(i.findings as { defect: string; count: number }[]).length > 0 && <div>{(i.findings as { defect: string; count: number }[]).map((f) => `${f.defect} ×${f.count}`).join("; ")}</div>}
            {i.notes && <div className="muted">{i.notes}</div>}</li>
        ))}{!inspections?.length && <li className="muted">No inspections recorded.</li>}</ul>
        {canInspect && !closed && (
          <details className="card"><summary>Record an inspection</summary>
            <form action={recordInspection.bind(null, projectId, lotId)} className="stack">
              <div className="grid2">
                <label>Stage<select name="stage" defaultValue="final" aria-label="Inspection stage"><option value="incoming">incoming</option><option value="in_process">in-process</option><option value="final">final</option></select></label>
                <label>Units inspected<input name="inspected" type="number" min={1} required defaultValue={l.sample_size} aria-label="Units inspected" /></label>
                <label>Defects found<input name="defects" type="number" min={0} aria-label="Defects found" /></label>
              </div>
              <label>Findings (one per line: defect, count)<textarea name="findings" rows={2} aria-label="Findings" placeholder="solder bridge U3, 1" /></label>
              <label>Notes<input name="notes" aria-label="Inspection notes" /></label>
              <div><SubmitButton pendingText="Recording…">Record inspection</SubmitButton></div>
            </form>
          </details>
        )}
      </section>
        </>) },
        ...(!closed && (canEdit || canJudge) ? [{ key: "disposition", label: "Disposition", content: (<>
        <section className="card">
          <form action={setLotStatus.bind(null, projectId, lotId)} className="stack">
            <div className="grid2">
              <label>Status<select name="status" defaultValue={canJudge ? "accepted" : "on_hold"} aria-label="Lot status">
                {canEdit && <><option value="in_build">in build</option><option value="inspection">inspection</option></>}
                <option value="on_hold">on hold</option>
                {canJudge && <><option value="accepted">accept the lot</option><option value="rejected">reject the lot</option></>}</select></label>
              <label>Note (needed to hold or reject)<input name="note" aria-label="Disposition note" /></label>
            </div>
            <p className="small muted">Accepting needs a final inspection that meets the sampling plan and every unit passing the production test (or scrapped).</p>
            <div><SubmitButton pendingText="Saving…">Set status</SubmitButton></div>
          </form>
        </section>
        </>) }] : []),
      ]} />
    </main>
  );
}
