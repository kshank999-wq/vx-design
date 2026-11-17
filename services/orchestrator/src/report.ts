/**
 * In-app completion report for a run (spec §7, §10): what finished, links to outputs,
 * failed checks, open approvals, recoveries, spend, and recommended next tasks.
 */
import type { RunRow, WorkerDb } from "./db.ts";

export interface RunReport {
  version: 1;
  generated_at: string;
  headline: string;
  final_status: "completed" | "stopped" | "failed" | "canceled";
  stop_reason: string | null;
  tasks: { id: string; key: string; title: string; discipline: string; status: string; attempts: number;
           blocker_reason: string | null; executions: number; interruptions: number }[];
  outputs: { task_key: string; artifact: string; version: number; status: "committed" | "awaiting_approval";
             version_id: string; storage_path: string; summary: string | null }[];
  checks: { task_key: string; kind: string; result: string; evidence_category: string; summary: string }[];
  open_approvals: { task_key: string; reason: string }[];
  recoveries: { task_key: string; execution_id: string; note: string }[];
  costs: { ai_usd: number; compute_usd: number; max_ai_usd: number; max_compute_usd: number };
  next_steps: string[];
}

export async function buildRunReport(db: WorkerDb, run: RunRow): Promise<RunReport> {
  const c = db.client;
  const [{ data: tasks }, { data: execs }, { data: costs }] = await Promise.all([
    c.from("tasks").select("id, key, title, discipline, status, attempts, blocker_reason, risk_level, position")
      .eq("plan_id", run.plan_id).order("position"),
    c.from("executions").select("id, task_id, status, error, resumed_from_id").eq("run_id", run.id).order("created_at"),
    c.from("cost_events").select("kind, cost_usd").eq("run_id", run.id),
  ]);
  const execIds = (execs ?? []).map((e) => e.id);
  const [{ data: versions }, { data: checks }, { data: approvals }, { data: deps }] = await Promise.all([
    execIds.length
      ? c.from("artifact_versions").select("id, version, status, validated_at, storage_path, summary, produced_by_task_id, artifacts(name)")
          .in("produced_by_execution_id", execIds)
      : Promise.resolve({ data: [] as never[] }),
    execIds.length
      ? c.from("validations").select("task_id, kind, result, evidence_category, summary").in("execution_id", execIds)
      : Promise.resolve({ data: [] as never[] }),
    c.from("approvals").select("task_id, reason").eq("status", "pending").in("task_id", (tasks ?? []).map((t) => t.id)),
    c.from("task_dependencies").select("task_id, depends_on_task_id").in("task_id", (tasks ?? []).map((t) => t.id)),
  ]);

  const inScope = (t: { id: string; risk_level: string }) =>
    run.allowed_risk_levels.includes(t.risk_level) && (!run.authorized_task_ids || run.authorized_task_ids.includes(t.id));
  const scoped = (tasks ?? []).filter(inScope);
  const keyOf = new Map((tasks ?? []).map((t) => [t.id, t.key]));
  const execCount = (taskId: string) => (execs ?? []).filter((e) => e.task_id === taskId).length;
  const interruptions = (execs ?? []).filter((e) => e.status === "interrupted");
  const statusOf = new Map((tasks ?? []).map((t) => [t.id, t.status]));
  const downstream = (taskId: string) => (deps ?? []).filter((d) => d.depends_on_task_id === taskId).map((d) => keyOf.get(d.task_id)!);

  const ai = (costs ?? []).filter((x) => x.kind === "ai_tokens").reduce((s, x) => s + Number(x.cost_usd), 0);
  const compute = (costs ?? []).filter((x) => x.kind !== "ai_tokens").reduce((s, x) => s + Number(x.cost_usd), 0);

  const count = (s: string) => scoped.filter((t) => t.status === s).length;
  const complete = count("complete");
  const parts = [`${complete} of ${scoped.length} task(s) in scope complete`];
  if (count("awaiting_approval")) parts.push(`${count("awaiting_approval")} awaiting your approval`);
  if (count("blocked")) parts.push(`${count("blocked")} blocked`);
  if (count("failed")) parts.push(`${count("failed")} failed`);
  if (count("ready")) parts.push(`${count("ready")} not started`);

  const next: string[] = [];
  for (const t of scoped) {
    const down = downstream(t.id).filter((k) => k);
    const unblocks = down.length ? ` (unblocks ${down.join(", ")})` : "";
    if (t.status === "awaiting_approval") next.push(`Review and approve ${t.key}${unblocks}.`);
    else if (t.status === "blocked") next.push(`${t.key} is blocked: ${t.blocker_reason ?? "see its execution log"}`);
    else if (t.status === "failed") next.push(`${t.key} failed: ${t.blocker_reason ?? "see its execution log"}. Retry it once the cause is fixed.`);
  }
  for (const t of (tasks ?? []).filter((x) => !inScope(x) && x.status === "ready")) {
    next.push(`${t.key} was outside this run's scope (risk ${t.risk_level}); include it in a future run if intended.`);
  }
  if (!next.length && complete === scoped.length) next.push("All tasks in scope are complete.");

  const finalStatus: RunReport["final_status"] =
    run.status === "canceled" ? "canceled"
    : run.status === "stopped" ? "stopped"
    : run.status === "failed" ? "failed"
    : complete === scoped.length ? "completed" : "stopped";

  return {
    version: 1,
    generated_at: new Date().toISOString(),
    headline: parts.join("; ") + ".",
    final_status: finalStatus,
    stop_reason: run.stop_reason ?? (finalStatus === "stopped" && run.status === "running"
      ? "Nothing more can run without your input." : null),
    tasks: scoped.map((t) => ({
      id: t.id, key: t.key, title: t.title, discipline: t.discipline, status: t.status, attempts: t.attempts,
      blocker_reason: t.blocker_reason, executions: execCount(t.id),
      interruptions: interruptions.filter((e) => e.task_id === t.id).length,
    })),
    outputs: (versions ?? [])
      .filter((v) => v.status === "committed" || (v.status === "scratch" && v.validated_at && statusOf.get(v.produced_by_task_id!) === "awaiting_approval"))
      .map((v) => ({
        task_key: keyOf.get(v.produced_by_task_id!) ?? "?",
        artifact: (v.artifacts as unknown as { name: string }).name,
        version: v.version,
        status: v.status === "committed" ? "committed" as const : "awaiting_approval" as const,
        version_id: v.id, storage_path: v.storage_path, summary: v.summary,
      })),
    checks: (checks ?? []).map((v) => ({ task_key: keyOf.get(v.task_id!) ?? "?", kind: v.kind, result: v.result,
                                         evidence_category: v.evidence_category, summary: v.summary })),
    open_approvals: (approvals ?? []).map((a) => ({ task_key: keyOf.get(a.task_id!) ?? "?", reason: a.reason })),
    recoveries: interruptions.map((e) => ({ task_key: keyOf.get(e.task_id) ?? "?", execution_id: e.id, note: e.error ?? "interrupted" })),
    costs: { ai_usd: round(ai), compute_usd: round(compute), max_ai_usd: Number(run.max_ai_spend_usd), max_compute_usd: Number(run.max_compute_spend_usd) },
    next_steps: next,
  };
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
