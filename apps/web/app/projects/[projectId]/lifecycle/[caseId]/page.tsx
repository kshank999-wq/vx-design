import Link from "next/link";
import { notFound } from "next/navigation";
import { Banner } from "@/components/Banner";
import { SubmitButton } from "@/components/SubmitButton";
import { requireUser } from "@/lib/auth";
import { CASE_PILL, caseCode, CHECKS } from "@/lib/lifecycle";
import { assessCase, decideSubstitute, proposeSubstitute, resolveCase, saveChecks } from "../actions";

type Check = { result?: string; basis?: string; test_run_id?: string };

export default async function CasePage({ params, searchParams }: {
  params: Promise<{ projectId: string; caseId: string }>; searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const { projectId, caseId } = await params;
  const { error, notice } = await searchParams;
  const { supabase, userId } = await requireUser();
  const [{ data: project }, { data: me }, { data: c }, { data: subs }, { data: runs }] = await Promise.all([
    supabase.from("projects").select("name").eq("id", projectId).maybeSingle(),
    supabase.from("project_members").select("role").eq("project_id", projectId).eq("user_id", userId).maybeSingle(),
    supabase.from("lifecycle_cases").select("*, part_notices(*)").eq("id", caseId).eq("project_id", projectId).maybeSingle(),
    supabase.from("substitutes").select("*").eq("case_id", caseId).order("created_at"),
    supabase.from("test_runs").select("id, run_no, units(serial), test_procedures(code)").eq("project_id", projectId).eq("verdict", "pass").order("run_no", { ascending: false }).limit(50),
  ]);
  if (!project || !c) notFound();
  const role = me?.role ?? "viewer";
  const canEdit = role === "owner" || role === "engineer";
  const canDecide = role === "owner" || role === "reviewer";
  const open = c.status !== "resolved";
  const n = c.part_notices as unknown as { kind: string; title: string; notice_ref: string | null; summary: string | null; last_order_on: string | null; source_url: string | null; source_note: string | null } | null;
  const { data: bomLine } = c.part_id
    ? await supabase.from("project_bom_parts").select("alternates").eq("project_id", projectId).eq("part_id", c.part_id).order("loaded_at", { ascending: false }).limit(1).maybeSingle()
    : { data: null };
  const alternates = ((bomLine?.alternates ?? []) as { mpn: string; manufacturer: string }[]).filter((a) => !(subs ?? []).some((s) => s.mpn === a.mpn));
  const qualified = (subs ?? []).filter((s) => s.status === "qualified");

  return (
    <main>
      <p className="crumbs"><Link href="/projects">Projects</Link> / <Link href={`/projects/${projectId}`}>{project.name}</Link> /{" "}
        <Link href={`/projects/${projectId}/lifecycle`}>Lifecycle</Link> /</p>
      <h1>{caseCode(c.case_no)}: {c.mpn} <span className={`pill pill-${CASE_PILL[c.status]}`} data-testid="case-status">{c.status}</span></h1>
      <Banner error={error} notice={notice} />
      <dl className="small">
        <dt>Why</dt><dd>{c.trigger_text} ({c.severity})</dd>
        <dt>Used at</dt><dd>{(c.refs as string[]).join(", ") || "—"}</dd>
        {n && <><dt>Notice</dt><dd>{n.kind.replace(/_/g, " ")}: {n.title}{n.notice_ref && ` (${n.notice_ref})`}{n.last_order_on && `, last order ${n.last_order_on}`}
          {n.summary && ` — ${n.summary}`}{n.source_url ? <> · <a href={n.source_url} target="_blank" rel="noreferrer noopener">source</a></> : n.source_note ? ` · ${n.source_note}` : ""}</dd></>}
      </dl>

      <section>
        <h2>Impact</h2>
        {c.impact ? <p data-testid="impact">{c.impact}</p> : <p className="muted">Not assessed yet.</p>}
        {canEdit && open && (
          <form action={assessCase.bind(null, projectId, caseId)} className="stack">
            <label>Impact assessment<textarea name="impact" rows={3} required defaultValue={c.impact ?? ""} aria-label="Impact assessment"
              placeholder="Which boards and releases use it, stock on hand, builds planned, options" /></label>
            <label className="inline">Severity<select name="severity" defaultValue={c.severity} aria-label="Severity"><option>low</option><option>medium</option><option>high</option></select></label>
            <div><SubmitButton variant="secondary" pendingText="Saving…">Save assessment</SubmitButton></div>
          </form>
        )}
      </section>

      <section>
        <h2>Substitutes</h2>
        <ul className="list" data-testid="substitutes">{(subs ?? []).map((s) => {
          const checks = (s.checks ?? {}) as Record<string, Check>;
          const editable = open && canEdit && (s.status === "proposed" || s.status === "qualifying");
          return (
            <li key={s.id} data-mpn={s.mpn} data-status={s.status}>
              <strong>{s.manufacturer} {s.mpn}</strong> <span className={`pill pill-${s.status === "qualified" ? "complete" : s.status === "rejected" ? "failed" : "awaiting_approval"}`}>{s.status}</span>
              {s.status_note && <div className="small">{s.status_note}</div>}
              <form key={`${s.status}-${s.updated_at}`} action={saveChecks.bind(null, projectId, caseId, s.id)} className="stack small">
                <table><thead><tr><th>Check</th><th>Result</th><th>Basis</th></tr></thead>
                  <tbody>{CHECKS.map(([k, label]) => (
                    <tr key={k}><td>{label}</td>
                      <td>{editable ? <select name={`${k}_result`} defaultValue={checks[k]?.result ?? ""} aria-label={`${label} result for ${s.mpn}`}>
                        <option value="">—</option><option value="pass">pass</option><option value="fail">fail</option><option value="na">not applicable</option></select>
                        : <span className={`pill pill-verdict-${checks[k]?.result === "pass" ? "pass" : checks[k]?.result === "fail" ? "fail" : "missing"}`}>{checks[k]?.result ?? "—"}</span>}</td>
                      <td>{editable ? <input name={`${k}_basis`} defaultValue={checks[k]?.basis ?? ""} aria-label={`${label} basis for ${s.mpn}`} /> : checks[k]?.basis ?? ""}
                        {k === "test" && (editable
                          ? <select name="test_run" defaultValue={checks.test?.test_run_id ?? ""} aria-label={`Test run for ${s.mpn}`}><option value="">(passing test run)</option>
                              {(runs ?? []).map((r) => <option key={r.id} value={r.id}>run {r.run_no}: {(r.units as unknown as { serial: string }).serial} {(r.test_procedures as unknown as { code: string }).code}</option>)}</select>
                          : checks.test?.test_run_id && <> · <Link href={`/projects/${projectId}/validation/runs/${checks.test.test_run_id}`}>test run</Link></>)}</td></tr>
                  ))}</tbody></table>
                {editable && <div><SubmitButton variant="secondary" pendingText="Saving…">Save checks</SubmitButton></div>}
              </form>
              {open && canDecide && (s.status === "proposed" || s.status === "qualifying") && (
                <form action={decideSubstitute.bind(null, projectId, caseId, s.id)} className="row tight small">
                  <select name="decision" defaultValue="qualify" aria-label={`Decision on ${s.mpn}`}><option value="qualify">qualify</option><option value="reject">reject</option></select>
                  <input name="note" required placeholder="reason" aria-label={`Reason for ${s.mpn}`} />
                  <SubmitButton pendingText="…">Decide</SubmitButton>
                </form>
              )}
            </li>
          );
        })}{!subs?.length && <li className="muted">No substitutes proposed.</li>}</ul>
        {open && canEdit && (
          <details className="card"><summary>Propose a substitute</summary>
            <form action={proposeSubstitute.bind(null, projectId, caseId)} className="stack">
              {alternates.length > 0 && <label>From the sourced BOM&apos;s alternates<select name="pick" defaultValue="" aria-label="Alternate">
                <option value="">(type one below)</option>{alternates.map((a) => <option key={a.mpn} value={`${a.mpn}|${a.manufacturer}`}>{a.manufacturer} {a.mpn}</option>)}</select></label>}
              <div className="grid2">
                <label>Part number<input name="mpn" aria-label="Substitute part number" /></label>
                <label>Manufacturer<input name="manufacturer" aria-label="Substitute manufacturer" /></label>
              </div>
              <div><SubmitButton variant="secondary" pendingText="…">Propose</SubmitButton></div>
            </form>
          </details>
        )}
      </section>

      <section className={open ? "card" : ""}>
        <h2>Resolution</h2>
        {!open ? <p data-testid="resolution">{c.resolution?.replace(/_/g, " ")}{c.ltb_quantity ? ` of ${c.ltb_quantity}` : ""}: {c.resolution_note} (recorded as a project decision)</p>
          : canDecide ? (
            <form key={qualified.map((s) => s.id).join() || "none"} action={resolveCase.bind(null, projectId, caseId)} className="stack">
              <div className="grid2">
                <label>Resolution<select name="resolution" defaultValue={qualified.length ? "substitute" : "last_time_buy"} aria-label="Resolution">
                  <option value="substitute">use a qualified substitute</option><option value="last_time_buy">last-time buy</option><option value="redesign">redesign</option>
                  <option value="accepted_risk">accept the risk</option><option value="not_affected">not affected</option></select></label>
                <label>Substitute<select name="substitute" defaultValue={qualified[0]?.id ?? ""} aria-label="Qualified substitute"><option value="">—</option>
                  {qualified.map((s) => <option key={s.id} value={s.id}>{s.manufacturer} {s.mpn}</option>)}</select></label>
                <label>Last-time-buy quantity<input name="ltb_quantity" type="number" min={1} aria-label="Last-time-buy quantity" /></label>
              </div>
              <label>Reason<input name="note" required aria-label="Resolution reason" /></label>
              <div><SubmitButton pendingText="Resolving…">Resolve</SubmitButton></div>
            </form>
          ) : <p className="muted small">An owner or reviewer resolves the case.</p>}
      </section>
    </main>
  );
}
