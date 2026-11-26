import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { estimateProgress, typicalSeconds } from "@/lib/step-progress";
import { hasProposal, proposalStates } from "@/lib/plan-proposals";

/**
 * What is happening in a project right now, for the live strip under the project menu: the active run (or none),
 * the tasks being worked on with when they started and their latest step, and how many wait for a person.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const supabase = await createClient();
  // The run that is working, if any; otherwise the newest.
  const { data: runs } = await supabase.from("runs").select("id, name, status, stop_reason, plan_id, max_ai_spend_usd, created_at")
    .eq("project_id", projectId).order("created_at", { ascending: false }).limit(10);
  const run = (runs ?? []).find((r) => ["pending", "running", "paused"].includes(r.status)) ?? runs?.[0];
  const { count: questions } = await supabase.from("project_questions").select("id", { count: "exact", head: true }).eq("project_id", projectId).eq("status", "open");
  // Numbers for the badges on the menu's Runs item: steps being worked on now (in every run), steps that could not
  // finish (not saved for later) in the plan of the working or newest run, and results waiting for approval.
  const activeIds = (runs ?? []).filter((r) => ["pending", "running", "paused"].includes(r.status)).map((r) => r.id);
  const [{ count: runningSteps }, { data: problemRows }] = await Promise.all([
    supabase.from("executions").select("id", { count: "exact", head: true }).eq("project_id", projectId).eq("status", "running"),
    run ? supabase.from("tasks").select("status, blocker_reason").eq("plan_id", run.plan_id).is("deferred_at", null).in("status", ["failed", "blocked"]) : Promise.resolve({ data: [] as { status: string; blocker_reason: string | null }[] }),
  ]);
  const badges: Record<string, unknown> & { active_runs: number } = { active_runs: activeIds.length, running: runningSteps ?? 0,
    paused_runs: (runs ?? []).filter((r) => r.status === "paused").length,
    problems: (problemRows ?? []).filter((t) => t.status === "failed" || /^interrupted /.test(t.blocker_reason ?? "")).length };
  // For the other menu items: open questions, plan updates the agent proposed that need a decision, and a plan
  // version that needs submitting or approving (drafts made before the approved plan are out of date and left out).
  const [{ data: plans }, { data: msgs }] = await Promise.all([
    supabase.from("plans").select("id, version, status, created_at, approved_at").eq("project_id", projectId).order("version", { ascending: false }).limit(20),
    supabase.from("project_messages").select("id, author_kind, data, created_at").eq("project_id", projectId).eq("author_kind", "assistant").order("id", { ascending: false }).limit(150),
  ]);
  const baseline = (plans ?? []).find((p) => p.status === "approved");
  const { count: fileTodos } = await supabase.from("owner_file_tasks").select("id", { count: "exact", head: true }).eq("project_id", projectId).eq("status", "open");
  const { data: auth } = await supabase.auth.getUser();
  const { data: me } = auth.user ? await supabase.from("project_members").select("role").eq("project_id", projectId).eq("user_id", auth.user.id).maybeSingle() : { data: null };
  const myRole = me?.role ?? "viewer";
  const pending = (plans ?? []).find((p) => ["draft", "awaiting_approval"].includes(p.status)
    && !(baseline?.approved_at && new Date(baseline.approved_at) > new Date(p.created_at)) && (!baseline || p.version > baseline.version));
  const states = await proposalStates(supabase, projectId, (msgs ?? []).filter((m) => hasProposal(m.data)));
  Object.assign(badges, {
    questions: (questions ?? 0) + (fileTodos ?? 0),
    proposals: Object.values(states).filter((x) => x.state === "open").length,
    // The owner approves in one step, so for them a draft is simply "to approve".
    plan: pending ? { id: pending.id, version: pending.version, state: pending.status === "draft" && myRole !== "owner" ? "submit" : "approve" } : null,
    stopped: run && ["stopped", "failed"].includes(run.status) ? { id: run.id, reason: run.stop_reason } : null,
  });
  if (!run) return NextResponse.json({ run: null, questions: questions ?? 0, badges });
  const [{ data: execs }, { data: waiting }, { data: costs }] = await Promise.all([
    supabase.from("executions").select("id, task_id, started_at, tasks(key, title, discipline)").eq("run_id", run.id).eq("status", "running"),
    supabase.from("tasks").select("id").eq("plan_id", run.plan_id).eq("status", "awaiting_approval"),
    supabase.from("cost_events").select("cost_usd, kind").eq("run_id", run.id),
  ]);
  const ids = (execs ?? []).map((e) => e.id);
  const { data: logs } = ids.length ? await supabase.from("execution_logs").select("execution_id, message").in("execution_id", ids).order("id", { ascending: false }).limit(50) : { data: [] };
  const { data: doneRows } = ids.length ? await supabase.from("executions").select("started_at, finished_at, tasks(discipline)")
    .eq("project_id", projectId).eq("status", "succeeded").order("created_at", { ascending: false }).limit(400) : { data: [] };
  const typical = typicalSeconds((doneRows ?? []).map((r) => ({ discipline: (r.tasks as unknown as { discipline: string } | null)?.discipline ?? "", started_at: r.started_at, finished_at: r.finished_at })));
  const last = new Map<string, string>();
  for (const l of logs ?? []) if (!last.has(l.execution_id)) last.set(l.execution_id, l.message);
  return NextResponse.json({
    run: { id: run.id, name: run.name, number: (await supabase.rpc("run_number", { p_run: run.id })).data ?? null, status: run.status, stop_reason: run.stop_reason, ai_max: Number(run.max_ai_spend_usd),
           ai_spent: (costs ?? []).filter((c) => c.kind === "ai_tokens").reduce((n, c) => n + Number(c.cost_usd), 0) },
    working: (execs ?? []).map((e) => { const t = e.tasks as unknown as { key: string; title: string; discipline: string } | null;
      const pr = estimateProgress({ discipline: t?.discipline ?? "", startedAt: e.started_at, lastLog: last.get(e.id) ?? null, typical: typical.get(t?.discipline ?? "") });
      return { key: t?.key ?? "", title: t?.title ?? "", started_at: e.started_at, step: last.get(e.id) ?? null, pct: pr.pct, slow: pr.slow }; }),
    waiting: (waiting ?? []).length,
    questions: (questions ?? 0) + (fileTodos ?? 0),
    badges: { ...badges, waiting: (waiting ?? []).length },
  }, { headers: { "Cache-Control": "no-store" } });
}
