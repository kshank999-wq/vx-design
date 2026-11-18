import Link from "next/link";
import { notFound } from "next/navigation";
import { suggestCompliance } from "@vx/planning";
import { Banner } from "@/components/Banner";
import { ScanBadge } from "@/components/ScanBadge";
import { StagedFileInput } from "@/components/StagedFileInput";
import { SubmitButton } from "@/components/SubmitButton";
import { requireUser } from "@/lib/auth";
import { COMPLIANCE_STATUS, itemCode } from "@/lib/production";
import { addItem, addSuggested, markNotApplicable, recordResult, setStatus } from "./actions";

interface Result {
  id: string; item_id: string; outcome: string; lab_name: string; lab_reference: string | null; certificate_ref: string | null; result_date: string;
  expires_on: string | null; tested_release_id: string; report_name: string; report_path: string; report_sha256: string; notes: string | null;
}

export default async function CompliancePage({ params, searchParams }: {
  params: Promise<{ projectId: string }>; searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const { projectId } = await params;
  const { error, notice } = await searchParams;
  const { supabase, userId } = await requireUser();
  const [{ data: project }, { data: me }, { data: intake }, { data: items }, { data: results }, { data: releases }] = await Promise.all([
    supabase.from("projects").select("name").eq("id", projectId).maybeSingle(),
    supabase.from("project_members").select("role").eq("project_id", projectId).eq("user_id", userId).maybeSingle(),
    supabase.from("project_intake").select("*").eq("project_id", projectId).maybeSingle(),
    supabase.from("compliance_items").select("*").eq("project_id", projectId).order("item_no"),
    supabase.from("compliance_results").select("*").eq("project_id", projectId).order("recorded_at", { ascending: false }),
    supabase.from("releases").select("id, revision, status").eq("project_id", projectId).in("status", ["released", "superseded"]).order("release_no", { ascending: false }),
  ]);
  if (!project) notFound();
  const role = me?.role ?? "viewer";
  const canEdit = role === "owner" || role === "engineer";
  const canWaive = role === "owner" || role === "reviewer";
  const all = (results ?? []) as Result[];
  const rev = new Map((releases ?? []).map((r) => [r.id, r.revision]));
  const current = (releases ?? []).find((r) => r.status === "released");
  const have = new Set((items ?? []).map((i) => i.suggestion_key));
  const { suggestions, gaps } = suggestCompliance(intake ?? {});
  const todo = suggestions.filter((s) => !have.has(s.key));
  const paths = all.map((r) => r.report_path);
  const [{ data: urls }, { data: scans }] = paths.length
    ? await Promise.all([supabase.storage.from("project-files").createSignedUrls(paths, 600),
                         supabase.from("file_scans").select("path, status, signature").eq("bucket", "project-files").in("path", paths)])
    : [{ data: [] }, { data: [] }];
  const url = new Map((urls ?? []).map((u) => [u.path, u.signedUrl]));
  const scan = new Map((scans ?? []).map((s) => [s.path, s]));
  const today = new Date().toISOString().slice(0, 10);
  const soon = new Date(Date.now() + 90 * 86400e3).toISOString().slice(0, 10);
  const counts = (items ?? []).reduce<Record<string, number>>((a, i) => ({ ...a, [i.status]: (a[i.status] ?? 0) + 1 }), {});

  return (
    <main>
      <p className="crumbs"><Link href="/projects">Projects</Link> / <Link href={`/projects/${projectId}`}>{project.name}</Link> /</p>
      <h1>Compliance</h1>
      <p className="muted">The regulatory regimes this product has to meet, and what the test labs reported, with their report files and the
        released revision they tested. This is tracking only: VX Design does not certify products or decide that one complies.</p>
      <Banner error={error} notice={notice} />
      <p className="small" data-testid="compliance-summary">{(items ?? []).length} item(s): {counts.passed ?? 0} with a passing lab result,
        {" "}{counts.failed ?? 0} failed, {(counts.identified ?? 0) + (counts.in_progress ?? 0) + (counts.at_lab ?? 0)} open,
        {" "}{counts.not_applicable ?? 0} not applicable. {current ? <>Current release: <strong>Rev {current.revision}</strong>.</> : <>No release issued yet (<Link href={`/projects/${projectId}/releases`}>Releases</Link>).</>}</p>

      {canEdit && (todo.length > 0 || gaps.length > 0) && (
        <section className="card" data-testid="suggestions">
          <h2>Suggested from the intake</h2>
          <p className="small muted">Worked out from the markets, radios, power source and intended use on the{" "}
            <Link href={`/projects/${projectId}/risks`}>intake</Link>. A starting list to confirm with a test lab, not legal advice, and not complete.</p>
          {gaps.length > 0 && <ul className="small" data-testid="gaps">{gaps.map((g) => <li key={g}>Missing: {g}</li>)}</ul>}
          <ul className="list small">{todo.map((s) => (
            <li key={s.key} data-key={s.key}>
              <form action={addSuggested.bind(null, projectId)} className="row tight">
                <input type="hidden" name="key" value={s.key} />
                <span><strong>{s.title}</strong> <span className="pill">{s.market}</span> <span className="muted">because {s.basis}</span>
                  {s.standards.length > 0 && <div className="muted">{s.standards.join(" · ")}</div>}{s.note && <div className="muted">{s.note}</div>}</span>
                <SubmitButton variant="secondary" pendingText="…">Add</SubmitButton>
              </form>
            </li>
          ))}</ul>
          {todo.length > 1 && <form action={addSuggested.bind(null, projectId)}><SubmitButton pendingText="Adding…">Add all {todo.length}</SubmitButton></form>}
        </section>
      )}

      <section>
        <h2>Items</h2>
        <ul className="list" data-testid="items">{(items ?? []).map((c) => {
          const history = all.filter((r) => r.item_id === c.id);
          const latest = history.find((r) => r.id === c.latest_result_id);
          const stale = latest && current && latest.tested_release_id !== current.id;
          return (
            <li key={c.id} data-item={itemCode(c.item_no)} data-status={c.status}>
              <span className={`pill pill-${COMPLIANCE_STATUS[c.status]?.[1] ?? ""}`}>{COMPLIANCE_STATUS[c.status]?.[0] ?? c.status}</span>{" "}
              <strong>{itemCode(c.item_no)}</strong> {c.title} <span className="pill">{c.market}</span>
              <div className="small muted">{[(c.standards as string[]).join(" · "), c.basis].filter(Boolean).join(" — ")}</div>
              {c.lab_name && !latest && <div className="small">Lab: {c.lab_name}</div>}
              {c.status_note && <div className="small">{c.status === "not_applicable" ? "Why not applicable" : "Note"}: {c.status_note}</div>}
              {latest && (
                <div className="small" data-testid="latest-result">
                  {latest.outcome === "pass" ? "Passed" : "Failed"} at {latest.lab_name}{latest.lab_reference && ` (report ${latest.lab_reference})`} on {latest.result_date},
                  {" "}testing <strong>Rev {rev.get(latest.tested_release_id) ?? "?"}</strong>.
                  {latest.certificate_ref && <> Certificate or declaration: {latest.certificate_ref}.</>}
                  {latest.expires_on && <> Valid until {latest.expires_on}{latest.expires_on < today ? <strong className="error"> (expired)</strong> : latest.expires_on < soon ? <strong> (expires within 90 days)</strong> : null}.</>}
                  {stale && <div className="banner banner-warn" data-testid="stale">Tested on Rev {rev.get(latest.tested_release_id)}; the current release is Rev {current!.revision}.
                    Assess whether the changes need a retest.</div>}
                </div>
              )}
              {history.length > 0 && (
                <details className="small"><summary>Lab results ({history.length})</summary>
                  <ul className="list">{history.map((r) => (
                    <li key={r.id}><span className={`pill pill-verdict-${r.outcome}`}>{r.outcome}</span> {r.result_date} · {r.lab_name}{r.lab_reference && ` · ${r.lab_reference}`}
                      {" "}· Rev {rev.get(r.tested_release_id) ?? "?"} ·{" "}
                      {url.get(r.report_path) && scan.get(r.report_path)?.status !== "infected" ? <a href={url.get(r.report_path)!}>{r.report_name}</a> : r.report_name}
                      {" "}<ScanBadge status={scan.get(r.report_path)?.status} signature={scan.get(r.report_path)?.signature} />
                      <span className="muted"> sha256 {r.report_sha256.slice(0, 12)}</span>{r.notes && <div>{r.notes}</div>}</li>
                  ))}</ul>
                </details>
              )}
              {(canEdit || canWaive) && (
                <div className="row tight">
                  {canEdit && c.status !== "passed" && c.status !== "not_applicable" && (
                    <details><summary>Update progress</summary>
                      <form action={setStatus.bind(null, projectId, c.id)} className="stack">
                        <div className="grid2">
                          <label>Status<select name="status" defaultValue={c.status === "identified" ? "in_progress" : "at_lab"} aria-label={`Status of ${itemCode(c.item_no)}`}>
                            <option value="identified">identified</option><option value="in_progress">in progress (pre-scans, test plan)</option><option value="at_lab">at the lab</option></select></label>
                          <label>Lab<input name="lab_name" defaultValue={c.lab_name ?? ""} aria-label={`Lab for ${itemCode(c.item_no)}`} /></label>
                        </div>
                        <label>Note<input name="note" aria-label={`Note for ${itemCode(c.item_no)}`} /></label>
                        <div><SubmitButton variant="secondary" pendingText="Saving…">Save</SubmitButton></div>
                      </form>
                    </details>
                  )}
                  {canEdit && c.status !== "not_applicable" && (
                    <details><summary>Record a lab result</summary>
                      {(releases ?? []).length === 0 ? <p className="small">Issue a release first, so the result says which revision was tested.</p> : (
                        <form action={recordResult.bind(null, projectId, c.id)} className="stack" data-testid={`result-form-${itemCode(c.item_no)}`}>
                          <div className="grid2">
                            <label>Outcome<select name="outcome" defaultValue="pass" aria-label="Outcome"><option value="pass">pass</option><option value="fail">fail</option></select></label>
                            <label>Revision tested<select name="tested_release" defaultValue={current?.id} aria-label="Revision tested">
                              {(releases ?? []).map((r) => <option key={r.id} value={r.id}>Rev {r.revision}{r.status === "superseded" ? " (superseded)" : ""}</option>)}</select></label>
                            <label>Lab<input name="lab_name" required defaultValue={c.lab_name ?? ""} aria-label="Lab name" /></label>
                            <label>Lab report number<input name="lab_reference" aria-label="Lab report number" /></label>
                            <label>Result date<input name="result_date" type="date" required defaultValue={today} aria-label="Result date" /></label>
                            <label>Valid until (if stated)<input name="expires_on" type="date" aria-label="Valid until" /></label>
                            <label>Grant ID, certificate or declaration number<input name="certificate_ref" aria-label="Certificate reference" /></label>
                          </div>
                          <StagedFileInput name="report" bucket="project-files" prefix={`${projectId}/uploads`} accept=".pdf,.docx,.txt" required label="Lab report (PDF)" ariaLabel="Lab report" />
                          <label>Notes<input name="notes" aria-label="Result notes" /></label>
                          <div><SubmitButton pendingText="Recording…">Record result</SubmitButton></div>
                        </form>
                      )}
                    </details>
                  )}
                  {canWaive && c.status !== "not_applicable" && c.status !== "passed" && (
                    <details><summary>Not applicable</summary>
                      <form action={markNotApplicable.bind(null, projectId, c.id)} className="stack">
                        <label>Why it does not apply<input name="reason" required aria-label={`Why ${itemCode(c.item_no)} does not apply`} /></label>
                        <div><SubmitButton variant="secondary" pendingText="Saving…">Mark not applicable</SubmitButton></div>
                      </form>
                    </details>
                  )}
                </div>
              )}
            </li>
          );
        })}{!items?.length && <li className="muted">No compliance items yet.</li>}</ul>
        {canEdit && (
          <details className="card"><summary>Add an item by hand</summary>
            <form action={addItem.bind(null, projectId)} className="stack">
              <div className="grid2">
                <label>Regime<input name="title" required placeholder="e.g. California Proposition 65 warning" /></label>
                <label>Market<input name="market" required placeholder="US, EU, global…" /></label>
              </div>
              <label>Standards (separate with ;)<input name="standards" /></label>
              <label>Why it applies<input name="basis" /></label>
              <div><SubmitButton variant="secondary" pendingText="Adding…">Add item</SubmitButton></div>
            </form>
          </details>
        )}
      </section>
    </main>
  );
}
