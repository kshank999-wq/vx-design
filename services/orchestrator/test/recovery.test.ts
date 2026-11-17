/**
 * Worker recovery against a real Supabase stack (local `supabase start`).
 * Starts real worker processes and kills or freezes them mid-task.
 *
 *   ./scripts/test-worker.sh        (exports the local stack's URL and keys, then runs this)
 *
 * Skipped when SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY are not set.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL = process.env.SUPABASE_URL;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON = process.env.SUPABASE_ANON_KEY;
const skip = !URL || !SERVICE || !ANON ? "SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and SUPABASE_ANON_KEY are required" : false;
const MAIN = join(import.meta.dirname, "../src/main.ts");

const admin = () => createClient(URL!, SERVICE!, { auth: { persistSession: false } });

async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 60_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

function startWorker(id: string, env: Record<string, string> = {}): ChildProcess {
  const child = spawn(process.execPath, [MAIN], {
    env: { ...process.env, WORKER_ID: id, VX_LLM: "offline", WORKER_CONCURRENCY: "1", WORKER_POLL_MS: "300",
           WORKER_LEASE_SECONDS: "5", VX_UNCOVERED_GRACE_MS: "2000", VX_ENGINEERING: "off", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const tag = (s: Buffer) => s.toString().trimEnd().split("\n").map((l) => `    | ${l}`).join("\n");
  child.stdout!.on("data", (d) => process.env.WORKER_VERBOSE && console.log(tag(d)));
  child.stderr!.on("data", (d) => console.error(tag(d)));
  return child;
}

async function stopWorker(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode) return;
  const exited = new Promise((r) => child.once("exit", r));
  child.kill("SIGKILL");
  await exited;
}

/** A signed-in owner with an approved plan and an authorized Autonomous run. */
async function setupRun(label: string): Promise<{ user: SupabaseClient; projectId: string; planId: string; runId: string }> {
  const email = `worker-${label}-${Date.now()}@example.test`;
  const password = "correct-horse-battery";
  const { error: ce } = await admin().auth.admin.createUser({ email, password, email_confirm: true });
  assert.ifError(ce);
  const user = createClient(URL!, ANON!, { auth: { persistSession: false } });
  const { error: se } = await user.auth.signInWithPassword({ email, password });
  assert.ifError(se);

  const { data: project, error: pe } = await user.from("projects").insert({ name: `Recovery ${label}` }).select("id").single();
  assert.ifError(pe);
  const { error: re } = await user.from("requirements").insert([
    { project_id: project!.id, ref_code: "REQ-FUN-001", kind: "functional", text: "Output SMPTE LTC", priority: "must" },
    { project_id: project!.id, ref_code: "REQ-PWR-001", kind: "power", text: "Run from 5 V USB", priority: "must" },
    { project_id: project!.id, ref_code: "REQ-MEC-001", kind: "mechanical", text: "Fit a 40 x 30 mm outline", priority: "must" },
  ]);
  assert.ifError(re);
  const tests = [{ id: "AT1", description: "Reviewed", method: "human_review" }];
  const { data: planId, error: cpe } = await user.rpc("create_plan_version", { p_project_id: project!.id, p_payload: {
    summary: "Recovery test plan",
    tasks: [
      { key: "architecture", title: "Architecture", discipline: "architecture", requirement_refs: ["REQ-FUN-001"], acceptance_tests: tests },
      { key: "power-budget", title: "Power budget", discipline: "power", upstream_keys: ["architecture"], requirement_refs: ["REQ-PWR-001"], acceptance_tests: tests },
      { key: "envelope", title: "Mechanical envelope", discipline: "mechanical", upstream_keys: ["architecture"], requirement_refs: ["REQ-MEC-001"], acceptance_tests: tests },
      { key: "schematic", title: "Schematic", discipline: "schematic", upstream_keys: ["power-budget", "envelope"] },
    ],
  } });
  assert.ifError(cpe);
  assert.ifError((await user.rpc("submit_plan", { p_plan_id: planId })).error);
  assert.ifError((await user.rpc("decide_plan", { p_plan_id: planId, p_approve: true, p_note: null })).error);
  const { data: runId, error: ae } = await user.rpc("authorize_run", {
    p_plan_id: planId, p_mode: "autonomous", p_max_ai_spend_usd: 5, p_max_compute_spend_usd: 5,
    p_allowed_risk_levels: ["low", "medium"], p_max_retries_per_task: 1, p_name: `recovery ${label}`,
  });
  assert.ifError(ae);
  return { user, projectId: project!.id, planId: planId as string, runId: runId as string };
}

async function executions(runId: string) {
  const { data } = await admin().from("executions")
    .select("id, task_id, attempt, status, worker_id, checkpoint_seq, resumed_from_id, tasks(key)").eq("run_id", runId).order("created_at");
  return (data ?? []).map((e) => ({ ...e, key: (e.tasks as unknown as { key: string }).key }));
}

async function logs(executionId: string): Promise<string[]> {
  const { data } = await admin().from("execution_logs").select("message").eq("execution_id", executionId).order("id");
  return (data ?? []).map((l) => l.message);
}

/** No duplicate committed work: one model call and at most one committed version per task. */
async function assertNoDuplicateWork(runId: string, projectId: string) {
  const execs = await executions(runId);
  const modelCalls = new Map<string, number>();
  for (const e of execs) {
    const n = (await logs(e.id)).filter((m) => m.startsWith("model call")).length;
    modelCalls.set(e.key, (modelCalls.get(e.key) ?? 0) + n);
  }
  for (const key of ["architecture", "power-budget", "envelope"]) {
    assert.equal(modelCalls.get(key), 1, `${key}: exactly one model call across all executions`);
  }
  const { data: versions } = await admin().from("artifact_versions")
    .select("artifact_id, produced_by_task_id, status").eq("project_id", projectId);
  const committed = (versions ?? []).filter((v) => v.status === "committed");
  assert.equal(committed.length, 3, "three committed briefs");
  assert.equal(new Set(committed.map((v) => v.produced_by_task_id)).size, 3, "one committed version per task");
  assert.equal((versions ?? []).length, 3, "no stray scratch versions from the interrupted attempt");
}

test("a run survives its worker being killed mid-task, without duplicate work", { skip, timeout: 120_000 }, async () => {
  const { runId, projectId } = await setupRun("kill");
  // Worker A pauses after each step, so it can be killed between "draft" and "store".
  const a = startWorker("worker-A", { VX_STEP_DELAY_MS: "2000" });
  let b: ChildProcess | undefined;
  try {
    const victim = await waitFor("worker A to checkpoint the drafted brief", async () =>
      (await executions(runId)).find((e) => e.worker_id === "worker-A" && e.status === "running" && e.checkpoint_seq >= 2));
    await stopWorker(a);   // SIGKILL: no chance to clean up

    b = startWorker("worker-B");
    const { data: run } = await waitFor("the run report", async () => {
      const r = await admin().from("runs").select("status, report, stop_reason").eq("id", runId).single();
      return r.data?.report ? r : null;
    }, 90_000);

    const execs = await executions(runId);
    const killed = execs.find((e) => e.id === victim.id)!;
    assert.equal(killed.status, "interrupted", "killed execution was reclaimed");
    const resumed = execs.find((e) => e.resumed_from_id === victim.id);
    assert.ok(resumed, "a new execution resumed the killed one");
    assert.equal(resumed.worker_id, "worker-B");
    assert.equal(resumed.attempt, victim.attempt, "resuming does not use up an attempt");
    assert.equal(resumed.status, "succeeded");
    const resumedLogs = await logs(resumed.id);
    assert.ok(resumedLogs.includes("step context: reused from checkpoint"), "context step not redone");
    assert.ok(resumedLogs.includes("step draft: reused from checkpoint"), "draft (model call) not redone");

    await assertNoDuplicateWork(runId, projectId);

    const report = run!.report as { headline: string; recoveries: unknown[]; next_steps: string[]; final_status: string };
    assert.equal(run!.status, "stopped", "no KiCad worker is online, so the run stops short of complete");
    assert.equal(report.recoveries.length, 1, "report lists the recovery");
    assert.match(report.headline, /3 of 4 task\(s\) in scope complete; 1 not started/);
    assert.ok(report.next_steps.some((s) => /schematic needs a worker that can run schematic tasks/.test(s)));
  } finally {
    await stopWorker(a);
    if (b) await stopWorker(b);
  }
});

test("a frozen worker that lost its lease cannot commit or repeat work", { skip, timeout: 120_000 }, async () => {
  const { runId, projectId } = await setupRun("freeze");
  const a = startWorker("worker-A", { VX_STEP_DELAY_MS: "1500" });
  let b: ChildProcess | undefined;
  try {
    const frozen = await waitFor("worker A to start a task", async () =>
      (await executions(runId)).find((e) => e.worker_id === "worker-A" && e.status === "running" && e.checkpoint_seq >= 1));
    a.kill("SIGSTOP");     // frozen, not dead: its process and timers survive

    b = startWorker("worker-B");
    await waitFor("worker B to take over and finish the frozen task", async () =>
      (await executions(runId)).find((e) => e.resumed_from_id === frozen.id && e.status === "succeeded"));

    a.kill("SIGCONT");     // A wakes up still believing it owns the task
    await waitFor("worker A to notice it lost the lease", async () =>
      (await logs(frozen.id)).some((m) => m.startsWith("lease lost")), 30_000);
    await waitFor("the run report", async () =>
      (await admin().from("runs").select("report").eq("id", runId).single()).data?.report, 90_000);

    const execs = await executions(runId);
    assert.equal(execs.find((e) => e.id === frozen.id)!.status, "interrupted", "frozen execution never succeeded");
    await assertNoDuplicateWork(runId, projectId);
  } finally {
    a.kill("SIGCONT");
    await stopWorker(a);
    if (b) await stopWorker(b);
  }
});

test("pause stops new work, resume continues, cancel ends the run with a report", { skip, timeout: 120_000 }, async () => {
  const { user, runId } = await setupRun("controls");
  assert.ifError((await user.rpc("control_run", { p_run_id: runId, p_action: "pause" })).error);
  const w = startWorker("worker-C", { VX_STEP_DELAY_MS: "500" });
  try {
    await new Promise((r) => setTimeout(r, 2000));
    assert.equal((await executions(runId)).length, 0, "nothing starts while paused");
    assert.ifError((await user.rpc("control_run", { p_run_id: runId, p_action: "resume" })).error);
    await waitFor("architecture to complete", async () =>
      (await executions(runId)).find((e) => e.key === "architecture" && e.status === "succeeded"));
    assert.ifError((await user.rpc("control_run", { p_run_id: runId, p_action: "cancel" })).error);
    const { data: run } = await waitFor("the cancel report", async () => {
      const r = await admin().from("runs").select("status, report").eq("id", runId).single();
      return r.data?.report ? r : null;
    });
    assert.equal(run!.status, "canceled");
    assert.equal((run!.report as { final_status: string }).final_status, "canceled");
    const live = (await executions(runId)).filter((e) => e.status === "running");
    assert.equal(live.length, 0, "in-flight work yielded");
    // Users cannot call worker functions.
    const { error } = await user.rpc("claim_next_task", { p_worker_id: "x", p_run_id: runId });
    assert.ok(error, "claim_next_task is not callable by users");
  } finally {
    await stopWorker(w);
  }
});
