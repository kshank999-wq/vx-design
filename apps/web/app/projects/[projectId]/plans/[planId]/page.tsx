import Link from "next/link";
import { STAGE_NAME, STAGES, type Stage } from "@/lib/stages";
import { notFound } from "next/navigation";
import { Banner } from "@/components/Banner";
import { SubmitButton } from "@/components/SubmitButton";
import { requireUser } from "@/lib/auth";
import { PlanChangesNotice } from "@/components/PlanChangesNotice";
import { costHistory, estimate } from "@/lib/cost-estimate";
import { activePlanRequest, PlanRequestStatus } from "@/components/PlanRequestStatus";
import { planChanges } from "@/lib/plan-inputs";
import { createPlan } from "../../actions";
import { authorizeRun, decidePlan, redoTask, revisePlan, submitPlan, updateTask } from "./actions";

interface AcceptanceTest { id: string; description: string; method: string; validationKind?: string }
interface Generator { model?: string; offline?: boolean; prompt_version?: string; attempts?: number; adjustments?: string[];
  revision?: { from_version: number; changed: string[]; added: string[]; removed: { key: string; reason: string }[]; new_requirements: number } }
interface Req { id: string; ref_code: string; text: string; source_section: string | null; source_excerpt: string | null; status: string }

const STATUS_LABEL: Record<string, string> = {
  draft: "Draft", awaiting_approval: "Awaiting approval", approved: "Approved baseline", superseded: "Superseded",
};

export default async function PlanPage({ params, searchParams }: {
  params: Promise<{ projectId: string; planId: string }>;
  searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const { projectId, planId } = await params;
  const { error, notice } = await searchParams;
  const { supabase, userId } = await requireUser();

  const [{ data: plan }, { data: tasks }, { data: reqs }, { data: approvals }, { data: me }, { data: runs }] = await Promise.all([
    supabase.from("plans").select("*, projects(name)").eq("id", planId).eq("project_id", projectId).maybeSingle(),
    supabase.from("tasks").select("id, key, title, discipline, stage, description, risk_level, status, required_tools, acceptance_tests, approval_policy, estimated_hours, basis, board, reused_from_task_id, created_at, task_dependencies!task_dependencies_task_id_fkey(depends_on_task_id), task_requirements(requirement_id)")
      .eq("plan_id", planId).order("position"),
    supabase.from("requirements").select("id, ref_code, text, source_section, source_excerpt, status").eq("project_id", projectId).order("ref_code"),
    supabase.from("approvals").select("id, status, reason, response_note, requested_at, responded_at").eq("plan_id", planId).order("requested_at"),
    supabase.from("project_members").select("role").eq("project_id", projectId).eq("user_id", userId).maybeSingle(),
    supabase.from("runs").select("id, name, status, mode, created_at, stop_reason").eq("plan_id", planId).order("created_at", { ascending: false }),
  ]);
  if (!plan) notFound();

  const role = me?.role ?? "viewer";
  const canEdit = plan.status === "draft" && (role === "owner" || role === "engineer");
  const canDecide = plan.status === "awaiting_approval" && (role === "owner" || role === "reviewer");
  const canRevise = plan.status !== "draft" && (role === "owner" || role === "engineer");
  const gen = (plan.generator ?? {}) as Generator;
  // On the newest plan: what has been added since it was made, and a button to regenerate it.
  const changes = role === "owner" || role === "engineer" ? await planChanges(supabase, projectId) : null;
  const isLatest = changes?.version === plan.version;
  const building = isLatest ? await activePlanRequest(supabase, projectId) : null;
  const history = isLatest && changes?.items.length ? await costHistory(supabase, projectId) : null;
  const planCost = history ? { update: estimate(history, "planUpdate"), fresh: estimate(history, "planFull", { scale: Math.max(0.15, (reqs ?? []).filter((r) => r.status !== "rejected").length / 714) }) } : undefined;
  const rev = gen.revision;
  const keyOf = new Map((tasks ?? []).map((t) => [t.id, t.key]));
  // Where reused tasks came from ("v3, task sch").
  const reusedIds = [...new Set((tasks ?? []).map((t) => t.reused_from_task_id).filter((x): x is string => !!x))];
  const { data: sources } = reusedIds.length ? await supabase.from("tasks").select("id, key, plans(version)").in("id", reusedIds) : { data: [] };
  const reusedFrom = new Map((sources ?? []).map((x) => [x.id, `v${(x.plans as unknown as { version: number }).version} (${x.key})`]));
  const canRedo = plan.status === "approved" && (role === "owner" || role === "engineer");
  const reusedCount = reusedIds.length ? (tasks ?? []).filter((t) => t.reused_from_task_id).length : 0;
  const reqById = new Map((reqs ?? []).map((r) => [r.id, r as Req]));
  const deferred = (plan.deferred ?? []) as { ref: string; reason: string }[];
  const covered = new Set((tasks ?? []).flatMap((t) => (t.task_requirements as { requirement_id: string }[]).map((x) => x.requirement_id)));
  const uncovered = (reqs ?? []).filter((r) => r.status !== "rejected" && !covered.has(r.id) && !deferred.some((d) => d.ref === r.ref_code));
  const hours = (tasks ?? []).reduce((s, t) => s + Number(t.estimated_hours ?? 0), 0);
  const gates = (tasks ?? []).filter((t) => (t.approval_policy as { required?: boolean })?.required).length;
  const activeRun = (runs ?? []).find((r) => ["pending", "running", "paused"].includes(r.status));
  const canRun = plan.status === "approved" && !activeRun && (role === "owner" || role === "engineer");
  const riskInPlan = new Set((tasks ?? []).map((t) => t.risk_level));
  const inputs = (plan.inputs ?? []) as { id: string; kind: string; label: string }[];
  const modeOf = (t: { basis: unknown }) => (t.basis as { mode?: string } | null)?.mode;
  const reuses = (tasks ?? []).filter((t) => modeOf(t) === "reuse" || modeOf(t) === "adapt").length;
  const replaces = (tasks ?? []).filter((t) => modeOf(t) === "replace").length;

  // Tasks grouped by product stage, in plan order within each stage (S0 first).
  const groups = STAGES.map((stage) => {
    const ts = (tasks ?? []).map((t, i) => ({ t, i })).filter(({ t }) => t.stage === stage);
    return { stage, tasks: ts, hours: Math.round(ts.reduce((n, { t }) => n + (Number(t.estimated_hours) || 0), 0) * 10) / 10,
             gates: ts.filter(({ t }) => (t.approval_policy as { required?: boolean } | null)?.required).length,
             risky: ts.filter(({ t }) => t.risk_level === "high" || t.risk_level === "critical").length,
             done: ts.filter(({ t }) => t.status === "complete").length };
  }).filter((g) => g.tasks.length);

  return (
    <main>
      <p className="crumbs"><Link href="/projects">Projects</Link> / <Link href={`/projects/${projectId}`}>{(plan.projects as { name: string }).name}</Link> /</p>
      <div className="row spread">
        <h1>Plan v{plan.version}</h1>
        <span className={`pill pill-${plan.status} big`}>{STATUS_LABEL[plan.status] ?? plan.status}</span>
      </div>
      <Banner error={error} notice={notice} />
      {gen.offline && <p className="banner banner-warn">Generated by the offline heuristic, not by AI. Set ANTHROPIC_API_KEY for real planning.</p>}
      {plan.summary && <p>{plan.summary}</p>}
      <p className="muted small">
        {tasks?.length ?? 0} tasks · {hours ? `${hours} h estimated` : "no estimate"} · {gates} approval gates ·
        generated by {gen.model ?? "unknown"} ({gen.prompt_version}, {gen.attempts ?? 1} attempt{gen.attempts === 1 ? "" : "s"})
        {plan.revised_from_id && <> · revised from an earlier version</>}
      </p>
      {inputs.length > 0 && (
        <p className="small" data-testid="built-from">Built on {inputs.filter((x) => x.kind !== "register_item").map((x) => <span key={x.id}><strong>{x.id}</strong> {x.label}; </span>)}
          {inputs.some((x) => x.kind === "register_item") && <>the earlier-work register ({inputs.filter((x) => x.kind === "register_item").length} item(s), PR-1 onwards); </>}
          {reuses} task(s) reuse or adapt earlier work{replaces ? `, ${replaces} replace it` : ""}. <Link href={`/projects/${projectId}/inputs`}>Project inputs</Link></p>
      )}

      {isLatest && <PlanRequestStatus supabase={supabase} projectId={projectId} />}
      {isLatest && <PlanChangesNotice cost={planCost} changes={changes} canEdit building={!!building} action={createPlan.bind(null, projectId, "project", "revise")} fresh={createPlan.bind(null, projectId, "project", "fresh")} />}
      {rev && (
        <p className="card small" data-testid="revision">Updated from <strong>plan v{rev.from_version}</strong> with what changed, not planned again:{" "}
          {rev.changed.length ? <>changed {rev.changed.join(", ")}; </> : null}{rev.added.length ? <>added {rev.added.join(", ")}; </> : null}
          {rev.removed.length ? <>removed {rev.removed.map((r) => `${r.key} (${r.reason})`).join(", ")}; </> : null}
          {rev.new_requirements} new or changed requirement(s); every other task kept as it was.</p>
      )}
      <div className="card row spread">
        <span className="small">
          {plan.status === "draft" && "Draft: edit tasks, then submit the plan for approval."}
          {plan.status === "awaiting_approval" && "Frozen for review. An owner or reviewer approves it or returns it with notes."}
          {plan.status === "approved" && "Approved baseline. Tasks are ready to run; changes need a new revision."}
          {plan.status === "approved" && reusedCount > 0 && <span data-testid="reused-count"> {reusedCount} task(s) were unchanged since an earlier version and are reused, not run again.</span>}
          {plan.status === "superseded" && "Superseded by a newer approved plan."}
        </span>
        <div className="row">
          {canEdit && <form action={submitPlan.bind(null, projectId, planId)}><SubmitButton disabled={uncovered.length > 0}>Submit for approval</SubmitButton></form>}
          {canRevise && <form action={revisePlan.bind(null, projectId, planId)}><SubmitButton variant="secondary">Revise as new draft</SubmitButton></form>}
        </div>
      </div>

      {plan.status === "approved" && (
        <section>
          <h2>Runs</h2>
          {(runs ?? []).length > 0 && (
            <ul className="list">{runs!.map((r) => (
              <li key={r.id}>
                <Link href={`/projects/${projectId}/runs/${r.id}`}><strong>{r.name || "Run"}</strong></Link>
                <span className={`pill pill-${r.status}`}>{r.status}</span>
                <span className="muted small"> {r.mode} · {new Date(r.created_at).toLocaleString()}{r.stop_reason ? ` · ${r.stop_reason}` : ""}</span>
              </li>
            ))}</ul>
          )}
          {activeRun && <p className="small muted">This plan has an active run; pause, resume or cancel it from its page.</p>}
          {canRun && (
            <form className="card stack" action={authorizeRun.bind(null, projectId, planId)}>
              <h3>Authorize a run</h3>
              <p className="small muted">A worker executes ready tasks in plan order within these limits. You can close the browser; the report is waiting here when it finishes.</p>
              <div className="row">
                <label>Name<input name="name" placeholder="e.g. Overnight 1" /></label>
                <label>Supervision
                  <select name="mode" defaultValue={plan.supervision_mode ?? "guided"}>
                    <option value="guided">Guided: review every design result</option>
                    <option value="professional">Professional: review gated tasks only</option>
                    <option value="autonomous">Autonomous: run unattended within budget</option>
                  </select>
                </label>
              </div>
              <div className="row">
                <label>AI budget (USD)<input name="max_ai_spend_usd" type="number" min="0" step="0.01" defaultValue="5" required /></label>
                <label>Compute budget (USD)<input name="max_compute_spend_usd" type="number" min="0" step="0.01" defaultValue="1" required /></label>
                <label>Retries per task<input name="max_retries_per_task" type="number" min="0" max="5" defaultValue="2" required /></label>
              </div>
              <fieldset className="row">
                <legend>Risk levels this run may execute</legend>
                {["low", "medium", "high", "critical"].map((r) => (
                  <label key={r} className="inline"><input type="checkbox" name="risk" value={r}
                    defaultChecked={r === "low" || r === "medium" || (r === "high" && riskInPlan.has("high"))}
                    disabled={r === "critical" && role !== "owner"} /> {r}</label>
                ))}
              </fieldset>
              <label className="inline" data-testid="auto-approve-option"><input type="checkbox" name="auto_approve" /> <span><strong>Run straight through (overnight)</strong>: approve every result whose
                VX Design checks pass, without stopping. Only failed checks stop a task; the rest carries on. Every automatic approval is recorded.</span></label>
              <label className="inline"><input type="checkbox" name="stop_on_failure" /> Stop the run at the first failed or blocked task</label>
              <div><SubmitButton pendingText="Authorizing…">Authorize run</SubmitButton></div>
            </form>
          )}
        </section>
      )}

      {canDecide && (
        <form className="card stack" action={decidePlan.bind(null, projectId, planId, true)}>
          <label>Review note<textarea name="note" rows={2} placeholder="Required when returning the plan" /></label>
          <div className="row">
            <SubmitButton pendingText="Approving…">Approve as baseline</SubmitButton>
            <SubmitButton variant="danger" formAction={decidePlan.bind(null, projectId, planId, false)} pendingText="Returning…">Return to draft</SubmitButton>
          </div>
        </form>
      )}

      {uncovered.length > 0 && (
        <div className="banner banner-error">
          Not covered by any task: {uncovered.map((r) => r.ref_code).join(", ")}. Revise the plan or reject these requirements.
        </div>
      )}

      <section>
        <h2>Tasks by stage</h2>
        <nav className="stage-index" aria-label="Stages in this plan" data-testid="stage-index">
          {groups.map((g) => (
            <a key={g.stage} href={`#stage-${g.stage}`} className="stage-chip"><span className="stage-code">{g.stage}</span>
              <span>{STAGE_NAME[g.stage as Stage]}<small>{g.tasks.length} task(s){g.done ? ` · ${g.done} done` : ""}</small></span></a>
          ))}
        </nav>
        {groups.map((g) => (
          <details key={g.stage} id={`stage-${g.stage}`} className="stage-group" open data-stage={g.stage}>
            <summary>
              <span className="stage-code">{g.stage}</span>
              <strong>{STAGE_NAME[g.stage as Stage]}</strong>
              <span className="muted small">{g.tasks.length} task(s) · {g.hours} h{g.gates ? ` · ${g.gates} approval gate(s)` : ""}{g.risky ? ` · ${g.risky} high-risk` : ""}</span>
              {plan.status === "approved" && <span className="stage-progress" title={`${g.done} of ${g.tasks.length} complete`}><span style={{ width: `${Math.round((100 * g.done) / g.tasks.length)}%` }} /></span>}
            </summary>
            <ol className="tasks">
              {g.tasks.map(({ t, i }) => {
            const deps = (t.task_dependencies as { depends_on_task_id: string }[]).map((d) => keyOf.get(d.depends_on_task_id)).filter(Boolean);
            const treqs = (t.task_requirements as { requirement_id: string }[]).map((x) => reqById.get(x.requirement_id)).filter(Boolean) as Req[];
            const policy = (t.approval_policy ?? {}) as { required?: boolean; reason?: string | null };
            return (
              <li key={t.id} id={`task-${t.id}`} className="task card">
                <div className="row spread">
                  <h3><span className="muted mono">{i + 1}. {t.key}</span> {t.title}</h3>
                  <div className="row tight">
                    <span className="pill" title={STAGE_NAME[t.stage as Stage]}>{t.stage}</span>
                    <span className="pill">{t.discipline.replace("_", " ")}</span>
                    {t.board && <span className="pill" data-testid="task-board" title="The circuit board this task works on; its tasks build on each other">board: {t.board}</span>}
                    <span className={`pill risk-${t.risk_level}`}>{t.risk_level} risk</span>
                    {policy.required && <span className="pill pill-gate" title={policy.reason ?? ""}>approval gate</span>}
                    {plan.status === "approved" && <span className={`pill pill-${t.status}`}>{t.status}</span>}
                  </div>
                </div>
                {t.reused_from_task_id && (
                  <div className="row small" data-testid="reused">
                    <span className="pill pill-complete">reused</span>
                    <span className="muted">Unchanged since {reusedFrom.get(t.reused_from_task_id) ?? "an earlier version"}: its approved outputs and checks are taken over, not run again.</span>
                    {canRedo && <form action={redoTask.bind(null, projectId, plan.id, t.id)}><button type="submit" className="secondary small">Do again</button></form>}
                  </div>
                )}
                {t.description && <p>{t.description}</p>}
                {["components", "architecture", "power"].includes(t.discipline) && /\b(select(ion)?|choose|choice|module|som|radio|camera|display|battery|charger)\b/i.test(`${t.key} ${t.title}`) && (
                  <p className="small" data-testid="build-vs-buy-link"><Link href={`/projects/${projectId}/build-vs-buy?title=${encodeURIComponent(t.title)}`}>Build vs buy</Link>
                    <span className="muted">: check ready-made modules for this before designing it</span></p>
                )}
                {(() => {
                  const b = t.basis as { mode: string; sources: string[]; reason: string; concerns?: string[]; alternatives?: string[] } | null;
                  if (!b) return null;
                  const label = b.mode === "reuse" ? "reuses" : b.mode === "adapt" ? "adapts" : b.mode === "replace" ? "replaces" : "starts fresh";
                  const pill = b.mode === "new" ? "draft" : b.mode === "replace" ? "replace" : "complete";
                  return <div className="small" data-testid="basis" data-mode={b.mode}>
                    <p><span className={`pill pill-${pill}`}>{label}</span>
                      {b.sources.length > 0 && <> {b.sources.map((x) => { const inp = inputs.find((i) => i.id === x);
                        return <span key={x}><strong title={inp?.label}>{x}</strong>{(inp?.kind === "register_item" || inp?.kind === "part") && <span className="muted"> {inp.label}</span>}</span>; })
                        .flatMap((el, k) => (k ? [", ", el] : [el]))}</>} {b.reason}</p>
                    {!!b.concerns?.length && <p data-testid="basis-concerns"><strong>Concerns:</strong> {b.concerns.join("; ")}</p>}
                    {!!b.alternatives?.length && <p data-testid="basis-alternatives"><strong>Alternatives:</strong> {b.alternatives.join("; ")}</p>}
                  </div>;
                })()}
                <dl className="facts small">
                  <dt>After</dt><dd>{deps.length ? deps.join(", ") : <span className="muted">start</span>}</dd>
                  <dt>Satisfies</dt>
                  <dd>{treqs.length ? treqs.map((r) => (
                    <span key={r.id} className="chip mono" title={`${r.text}\n\n§ ${r.source_section ?? ""}: "${r.source_excerpt ?? ""}"`}>{r.ref_code}</span>
                  )) : <span className="muted">—</span>}</dd>
                  <dt>Accept when</dt>
                  <dd><ul>{(t.acceptance_tests as AcceptanceTest[]).map((a) => (
                    <li key={a.id}>{a.description} <span className="muted">({a.validationKind ?? a.method.replace("_", " ")})</span></li>
                  ))}</ul></dd>
                  {t.required_tools?.length > 0 && <><dt>Tools</dt><dd className="mono">{t.required_tools.join(", ")}</dd></>}
                  {t.estimated_hours != null && <><dt>Estimate</dt><dd>{t.estimated_hours} h</dd></>}
                  {policy.required && policy.reason && <><dt>Approval</dt><dd>{policy.reason}</dd></>}
                </dl>
                {canEdit && (
                  <details>
                    <summary>Edit task</summary>
                    <form action={updateTask.bind(null, projectId, planId, t.id)} className="stack">
                      <label>Title<input name="title" defaultValue={t.title} required /></label>
                      <label>Description<textarea name="description" rows={3} defaultValue={t.description ?? ""} /></label>
                      <div className="row">
                        <label>Risk
                          <select name="risk_level" defaultValue={t.risk_level}>
                            {["low", "medium", "high", "critical"].map((r) => <option key={r}>{r}</option>)}
                          </select>
                        </label>
                        <label>Estimate (h)<input name="estimated_hours" type="number" min="0" step="0.5" defaultValue={t.estimated_hours ?? ""} /></label>
                        <label>Stage
                          <select name="stage" defaultValue={t.stage}>
                            {STAGES.map((s) => <option key={s} value={s}>{s} {STAGE_NAME[s]}</option>)}
                          </select>
                        </label>
                        <label className="inline"><input type="checkbox" name="approval_required" defaultChecked={policy.required} /> Approval gate</label>
                      </div>
                      <label>Approval reason<input name="approval_reason" defaultValue={policy.reason ?? ""} /></label>
                      <div><SubmitButton pendingText="Saving…">Save task</SubmitButton></div>
                    </form>
                  </details>
                )}
              </li>
            );
              })}
            </ol>
          </details>
        ))}
      </section>

      {(deferred.length > 0 || (plan.assumptions as string[]).length > 0 || (gen.adjustments ?? []).length > 0) && (
        <section className="grid2">
          {deferred.length > 0 && (
            <div className="card"><h3>Deferred requirements</h3>
              <ul>{deferred.map((d) => <li key={d.ref}><span className="mono">{d.ref}</span> — {d.reason}</li>)}</ul></div>
          )}
          {(plan.assumptions as string[]).length > 0 && (
            <div className="card"><h3>Assumptions</h3><ul>{(plan.assumptions as string[]).map((a, i) => <li key={i}>{a}</li>)}</ul></div>
          )}
          {(gen.adjustments ?? []).length > 0 && (
            <div className="card" data-testid="adjustments"><h3>Changed by rule ({gen.adjustments!.length})</h3>
              <p className="small muted">Fixed in code instead of a paid repair round with the model, or set by policy. Check anything placed by rule and move it if another task fits better.</p>
              <ul>{gen.adjustments!.map((a, i) => <li key={i}>{a}</li>)}</ul></div>
          )}
        </section>
      )}

      {(approvals ?? []).length > 0 && (
        <section>
          <h2>Approval history</h2>
          <ul className="list">{approvals!.map((a) => (
            <li key={a.id}><span className={`pill pill-${a.status}`}>{a.status}</span> {a.reason}
              {a.response_note && <span className="muted"> — “{a.response_note}”</span>}
              <span className="muted small"> {new Date(a.responded_at ?? a.requested_at).toLocaleString()}</span></li>
          ))}</ul>
        </section>
      )}
    </main>
  );
}
