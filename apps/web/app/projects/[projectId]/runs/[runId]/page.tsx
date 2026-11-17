import Link from "next/link";
import { notFound } from "next/navigation";
import { AutoRefresh } from "@/components/AutoRefresh";
import { Banner } from "@/components/Banner";
import { SubmitButton } from "@/components/SubmitButton";
import { requireUser } from "@/lib/auth";
import { continueRun, controlRun, decideTask } from "./actions";

interface Report {
  headline: string;
  final_status: string;
  stop_reason: string | null;
  generated_at: string;
  outputs: { task_key: string; artifact: string; version: number; status: string; version_id: string; storage_path: string; summary: string | null }[];
  checks: { task_key: string; kind: string; result: string; evidence_category: string; summary: string }[];
  open_approvals: { task_key: string; reason: string }[];
  recoveries: { task_key: string; execution_id: string; note: string }[];
  costs: { ai_usd: number; compute_usd: number; max_ai_usd: number; max_compute_usd: number };
  next_steps: string[];
}

const RUN_LABEL: Record<string, string> = {
  pending: "Pending", running: "Running", paused: "Paused", completed: "Completed", stopped: "Stopped", failed: "Failed", canceled: "Canceled",
};
const EVIDENCE: Record<string, string> = {
  unverified_assumption: "unverified AI reasoning", deterministic_calculation: "calculation", cad_check: "CAD check",
  datasheet_verified: "datasheet", simulation: "simulation", hardware_test: "hardware test",
};

export default async function RunPage({ params, searchParams }: {
  params: Promise<{ projectId: string; runId: string }>;
  searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const { projectId, runId } = await params;
  const { error, notice } = await searchParams;
  const { supabase, userId } = await requireUser();

  const { data: run } = await supabase.from("runs").select("*, plans(version), projects(name)")
    .eq("id", runId).eq("project_id", projectId).maybeSingle();
  if (!run) notFound();

  const [{ data: tasks }, { data: execs }, { data: costs }, { data: me }, { data: activeRuns }] = await Promise.all([
    supabase.from("tasks").select("id, key, title, discipline, status, attempts, blocker_reason, risk_level, assigned_worker, position")
      .eq("plan_id", run.plan_id).order("position"),
    supabase.from("executions").select("id, task_id, attempt, status, worker_id, checkpoint_seq, resumed_from_id, started_at, finished_at, heartbeat_at, error, summary, compute_seconds")
      .eq("run_id", runId).order("created_at"),
    supabase.from("cost_events").select("kind, cost_usd").eq("run_id", runId),
    supabase.from("project_members").select("role").eq("project_id", projectId).eq("user_id", userId).maybeSingle(),
    supabase.from("runs").select("id").eq("plan_id", run.plan_id).in("status", ["pending", "running", "paused"]),
  ]);
  const taskIds = (tasks ?? []).map((t) => t.id);
  const execIds = (execs ?? []).map((e) => e.id);
  const [{ data: approvals }, { data: versions }, { data: logs }] = await Promise.all([
    supabase.from("approvals").select("id, task_id, reason, status, response_note, requested_at").in("task_id", taskIds).order("requested_at"),
    supabase.from("artifact_versions").select("id, version, status, validated_at, storage_path, summary, produced_by_task_id, artifacts(name)")
      .in("produced_by_task_id", taskIds).order("version"),
    execIds.length
      ? supabase.from("execution_logs").select("id, execution_id, level, message, created_at").in("execution_id", execIds).order("id", { ascending: false }).limit(300)
      : Promise.resolve({ data: [] as { id: number; execution_id: string; level: string; message: string; created_at: string }[] }),
  ]);

  const role = me?.role ?? "viewer";
  const canControl = role === "owner" || role === "engineer";
  const canDecide = role === "owner" || role === "reviewer";
  const report = run.report as Report | null;
  const active = ["pending", "running", "paused"].includes(run.status);
  const live = active || !report;
  const inScope = (t: { id: string; risk_level: string }) =>
    (run.allowed_risk_levels as string[]).includes(t.risk_level) && (!run.authorized_task_ids || (run.authorized_task_ids as string[]).includes(t.id));
  const keyOf = new Map((tasks ?? []).map((t) => [t.id, t.key]));
  const aiUsd = (costs ?? []).filter((c) => c.kind === "ai_tokens").reduce((s, c) => s + Number(c.cost_usd), 0);
  const computeUsd = (costs ?? []).filter((c) => c.kind !== "ai_tokens").reduce((s, c) => s + Number(c.cost_usd), 0);
  const liveExecs = (execs ?? []).filter((e) => e.status === "running");
  const waiting = (tasks ?? []).filter((t) => t.status === "awaiting_approval");
  const pendingApproval = new Map((approvals ?? []).filter((a) => a.status === "pending").map((a) => [a.task_id, a]));
  const outputsOf = (taskId: string) => (versions ?? []).filter((v) => v.produced_by_task_id === taskId
    && (v.status === "committed" || (v.status === "scratch" && v.validated_at)));
  const lastLog = new Map<string, string>();
  for (const l of logs ?? []) if (!lastLog.has(l.execution_id)) lastLog.set(l.execution_id, l.message);
  const taskStatus = new Map((tasks ?? []).map((t) => [t.id, t.status]));
  const { data: depRows } = await supabase.from("task_dependencies").select("task_id, depends_on_task_id").in("task_id", taskIds);
  // Something in scope could run now (e.g. after an approval): offer a follow-up run.
  const runnable = (tasks ?? []).filter((t) => t.status === "ready" && inScope(t)
    && (depRows ?? []).filter((d) => d.task_id === t.id).every((d) => taskStatus.get(d.depends_on_task_id) === "complete"));
  const canContinue = canControl && !active && !(activeRuns ?? []).length && runnable.length > 0;
  const noWorker = run.status === "running" && !(execs ?? []).length && Date.now() - new Date(run.created_at).getTime() > 20_000;

  const paths = [...new Set([...(versions ?? []).map((v) => v.storage_path), ...(report?.outputs ?? []).map((o) => o.storage_path)])];
  const { data: signed } = paths.length
    ? await supabase.storage.from("project-files").createSignedUrls(paths, 3600)
    : { data: [] as { path: string | null; signedUrl: string }[] };
  const urlOf = new Map<string | null, string | undefined>((signed ?? []).map((s) => [s.path, s.signedUrl ?? undefined]));
  const artifactName = (v: { artifacts: unknown }) => (v.artifacts as { name: string }).name;

  return (
    <main>
      <p className="crumbs">
        <Link href="/projects">Projects</Link> / <Link href={`/projects/${projectId}`}>{(run.projects as { name: string }).name}</Link> /{" "}
        <Link href={`/projects/${projectId}/plans/${run.plan_id}`}>Plan v{(run.plans as { version: number }).version}</Link> /
      </p>
      <div className="row spread">
        <h1>{run.name || "Run"}</h1>
        <div className="row">
          {live && <AutoRefresh />}
          <span className={`pill pill-${run.status} big`} data-testid="run-status">{RUN_LABEL[run.status] ?? run.status}</span>
        </div>
      </div>
      <Banner error={error} notice={notice} />
      {run.stop_reason && <p className="banner banner-warn">Stopped: {run.stop_reason}</p>}
      {noWorker && <p className="banner banner-warn">No worker has picked this run up yet. Workers run outside the web app; see services/orchestrator/README.md.</p>}

      <div className="grid2">
        <div className="card">
          <h3>Authorization</h3>
          <dl className="facts small">
            <dt>Mode</dt><dd>{run.mode}</dd>
            <dt>Risk levels</dt><dd>{(run.allowed_risk_levels as string[]).join(", ")}</dd>
            <dt>Retries</dt><dd>{run.max_retries_per_task} per task</dd>
            <dt>Scope</dt><dd>{run.authorized_task_ids ? `${(run.authorized_task_ids as string[]).length} selected tasks` : "all tasks of the plan"}</dd>
            {(run.stop_conditions as { stop_on_failure?: boolean })?.stop_on_failure && <><dt>Stops</dt><dd>on the first failed or blocked task</dd></>}
            <dt>Started</dt><dd>{run.started_at ? new Date(run.started_at).toLocaleString() : "—"}</dd>
            {run.finished_at && <><dt>Finished</dt><dd>{new Date(run.finished_at).toLocaleString()}</dd></>}
          </dl>
        </div>
        <div className="card">
          <h3>Spend</h3>
          <Meter label="AI" used={aiUsd} max={Number(run.max_ai_spend_usd)} />
          <Meter label="Compute" used={computeUsd} max={Number(run.max_compute_spend_usd)} />
          {canControl && active && (
            <div className="row" style={{ marginTop: 12 }}>
              {run.status === "running" && <form action={controlRun.bind(null, projectId, runId, "pause")}><SubmitButton variant="secondary">Pause</SubmitButton></form>}
              {run.status === "paused" && <form action={controlRun.bind(null, projectId, runId, "resume")}><SubmitButton>Resume</SubmitButton></form>}
              <form action={controlRun.bind(null, projectId, runId, "cancel")}><SubmitButton variant="danger">Cancel run</SubmitButton></form>
            </div>
          )}
        </div>
      </div>

      {waiting.length > 0 && (
        <section>
          <h2>Waiting for your approval</h2>
          {waiting.map((t) => {
            const appr = pendingApproval.get(t.id);
            return (
              <div key={t.id} className="card approval" data-task={t.key}>
                <div className="row spread"><h3><span className="mono muted">{t.key}</span> {t.title}</h3><span className="pill pill-awaiting_approval">awaiting approval</span></div>
                {appr && <p className="small">{appr.reason}</p>}
                <ul className="small">{outputsOf(t.id).map((v) => (
                  <li key={v.id}>
                    <Link href={`/projects/${projectId}/artifacts/${v.id}`}>{artifactName(v)} v{v.version}</Link>
                    {urlOf.get(v.storage_path) && <> · <a href={urlOf.get(v.storage_path) ?? undefined}>download</a></>}
                    {v.summary && <span className="muted"> — {v.summary}</span>}
                  </li>
                ))}</ul>
                {canDecide && (
                  <form className="stack" action={decideTask.bind(null, projectId, runId, t.id, true)}>
                    <label>Note<textarea name="note" rows={2} placeholder="Required when returning the task" /></label>
                    <div className="row">
                      <SubmitButton pendingText="Approving…">Approve and commit</SubmitButton>
                      <SubmitButton variant="danger" formAction={decideTask.bind(null, projectId, runId, t.id, false)} pendingText="Returning…">Return for rework</SubmitButton>
                    </div>
                  </form>
                )}
              </div>
            );
          })}
        </section>
      )}

      <section>
        <h2>Tasks</h2>
        <table className="run-tasks">
          <thead><tr><th>Task</th><th>Status</th><th>Attempts</th><th>Now</th></tr></thead>
          <tbody>
            {(tasks ?? []).map((t) => {
              const exec = liveExecs.find((e) => e.task_id === t.id);
              return (
                <tr key={t.id} data-task={t.key} className={inScope(t) ? "" : "out-of-scope"}>
                  <td><span className="mono">{t.key}</span> {t.title}<div className="muted small">{t.discipline.replace("_", " ")} · {t.risk_level} risk{!inScope(t) && " · outside this run's scope"}</div></td>
                  <td><span className={`pill pill-${t.status}`}>{t.status.replace("_", " ")}</span></td>
                  <td>{t.attempts}</td>
                  <td className="small">
                    {exec ? <>{exec.worker_id}: {lastLog.get(exec.id) ?? "starting"}</> : t.blocker_reason ? <span className="warn-text">{t.blocker_reason}</span> : null}
                    {outputsOf(t.id).filter((v) => v.status === "committed").map((v) => (
                      <div key={v.id}><Link href={`/projects/${projectId}/artifacts/${v.id}`}>{artifactName(v)} v{v.version}</Link> <span className="pill pill-complete">committed</span></div>
                    ))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      {canContinue && (
        <div className="card row spread">
          <span className="small">{runnable.map((t) => t.key).join(", ")} can run now.</span>
          <form action={continueRun.bind(null, projectId, runId)}><SubmitButton pendingText="Authorizing…">Continue in a new run</SubmitButton></form>
        </div>
      )}

      {report && (
        <section className="report" data-testid="run-report">
          <h2>Completion report</h2>
          <div className="card">
            <p><strong>{report.headline}</strong></p>
            {report.stop_reason && <p className="small muted">{report.stop_reason}</p>}
            {report.next_steps.length > 0 && <><h3>Recommended next</h3><ul>{report.next_steps.map((s, i) => <li key={i}>{s}</li>)}</ul></>}
            {report.outputs.length > 0 && <><h3>Outputs</h3><ul>{report.outputs.map((o) => (
              <li key={o.version_id}>
                <Link href={`/projects/${projectId}/artifacts/${o.version_id}`}>{o.artifact} v{o.version}</Link> ({o.task_key})
                <span className={`pill pill-${o.status === "committed" ? "complete" : "awaiting_approval"}`}>{o.status.replace("_", " ")}</span>
                {urlOf.get(o.storage_path) && <> · <a href={urlOf.get(o.storage_path) ?? undefined}>download</a></>}
              </li>
            ))}</ul></>}
            {report.checks.length > 0 && <><h3>Checks</h3><ul className="small">{report.checks.map((c, i) => (
              <li key={i}><span className={`pill pill-check-${c.result}`}>{c.result}</span> {c.task_key}: {c.summary} <span className="muted">({EVIDENCE[c.evidence_category] ?? c.evidence_category})</span></li>
            ))}</ul></>}
            {report.recoveries.length > 0 && <><h3>Recovered interruptions</h3><ul className="small">{report.recoveries.map((r) => (
              <li key={r.execution_id}>{r.task_key}: {r.note}</li>
            ))}</ul></>}
            <p className="small muted">Spend: AI ${report.costs.ai_usd.toFixed(4)} of ${report.costs.max_ai_usd} · compute ${report.costs.compute_usd.toFixed(4)} of ${report.costs.max_compute_usd} · report written {new Date(report.generated_at).toLocaleString()}</p>
          </div>
        </section>
      )}

      <section>
        <h2>Activity</h2>
        {!(execs ?? []).length && <p className="muted">No work has started yet.</p>}
        {[...(execs ?? [])].reverse().map((e) => (
          <details key={e.id} className="card exec" open={e.status === "running"}>
            <summary>
              <span className="mono">{keyOf.get(e.task_id)}</span> attempt {e.attempt}{e.resumed_from_id && " (resumed from checkpoint)"}
              <span className={`pill pill-exec-${e.status}`}>{e.status}</span>
              <span className="muted small"> {e.worker_id} · {new Date(e.started_at ?? e.heartbeat_at).toLocaleTimeString()}</span>
            </summary>
            {e.error && <p className="small warn-text">{e.error}</p>}
            {e.summary && <p className="small">{e.summary}</p>}
            <ol className="log mono">
              {(logs ?? []).filter((l) => l.execution_id === e.id).reverse().map((l) => (
                <li key={l.id} className={`log-${l.level}`}>{new Date(l.created_at).toLocaleTimeString()} {l.message}</li>
              ))}
            </ol>
          </details>
        ))}
      </section>
    </main>
  );
}

function Meter({ label, used, max }: { label: string; used: number; max: number }) {
  const pct = max > 0 ? Math.min(100, (used / max) * 100) : used > 0 ? 100 : 0;
  return (
    <div className="meter small">
      <div className="row spread"><span>{label}</span><span>${used.toFixed(4)} of ${max.toFixed(2)}</span></div>
      <div className="meter-track"><div className={`meter-fill${pct >= 100 ? " over" : ""}`} style={{ width: `${pct}%` }} /></div>
    </div>
  );
}
