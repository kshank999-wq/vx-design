// End-to-end test of G2: authorize a run in the browser, close the browser, kill the worker
// mid-task, let another worker resume it, then come back to approve, continue and read the
// completion report. Checks the database for duplicate committed work.
//
// Needs: the app running (BASE_URL, default http://localhost:3000) with VX_LLM=offline, the
// local Supabase stack, and SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY for the workers and the
// database checks. ./scripts/test-e2e-g2.sh sets these up.
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const { chromium } = createRequire(import.meta.url)("playwright");

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SB_KEY) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
const SHOTS = process.env.SCREENSHOTS;
const here = dirname(fileURLToPath(import.meta.url));
const SPEC = join(here, "../../../tests/fixtures/specs/sample-timecode-board.md");
const WORKER = join(here, "../../../services/orchestrator/src/main.ts");
const owner = { email: `g2-owner-${Date.now()}@example.test`, password: "correct-horse-battery" };
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

let step = 0;
const workers = new Set();

/** Service-role read through PostgREST (the test's view of the truth). */
async function db(path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return r.json();
}
async function waitFor(what, fn, timeoutMs = 60_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}
function startWorker(id, env = {}) {
  const child = spawn(process.execPath, [WORKER], {
    env: { ...process.env, WORKER_ID: id, VX_LLM: "offline", WORKER_CONCURRENCY: "1", WORKER_POLL_MS: "300",
           WORKER_LEASE_SECONDS: "5", VX_UNCOVERED_GRACE_MS: "3000", VX_ENGINEERING: "off", ...env },
    stdio: ["ignore", "pipe", "inherit"],
  });
  child.stdout.on("data", (d) => process.env.WORKER_VERBOSE && process.stdout.write(d));
  workers.add(child);
  child.once("exit", () => workers.delete(child));
  return child;
}
async function kill(child) {
  if (child.exitCode !== null || child.signalCode) return;
  const exited = new Promise((r) => child.once("exit", r));
  child.kill("SIGKILL");
  await exited;
}
async function newPage(browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1 });
  return context.newPage();
}
async function shot(page, name) {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${String(++step).padStart(2, "0")}-${name}.png`), fullPage: true });
}
async function expectNoError(page) {
  const alert = page.locator(".banner-error");
  if (await alert.count()) throw new Error(`Unexpected error banner: ${await alert.first().innerText()}`);
}
async function signIn(page, user, create = false) {
  await page.goto(`${BASE}/login`);
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: create ? "Create account" : "Sign in" }).click();
  await page.waitForURL(/\/projects$/);
}
const runStatus = async (runId) => (await db(`runs?id=eq.${runId}&select=status,report,stop_reason`))[0];
const taskStatus = async (planId) => Object.fromEntries((await db(`tasks?plan_id=eq.${planId}&select=key,status`)).map((t) => [t.key, t.status]));

let browser = await chromium.launch();
try {
  // --- Setup through the UI: project, spec, requirements, approved plan -------------------
  let page = await newPage(browser);
  await signIn(page, owner, true);
  await page.getByLabel("Name").fill("Timecode board (G2 e2e)");
  await page.getByLabel(/Stage gates/).uncheck();  // this flow tests runs without stage sign-offs
  await page.getByRole("button", { name: "Create project" }).click();
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}$/);
  const projectUrl = page.url();
  const projectId = projectUrl.split("/").pop();
  await page.getByLabel("Specification file").setInputFiles(SPEC);
  await page.getByRole("button", { name: "Upload" }).click();
  await page.getByText(/Uploaded sample-timecode-board\.md/).waitFor();
  await page.getByRole("button", { name: "Extract requirements" }).click();
  await page.locator("table.reqs tbody tr").first().waitFor();
  await page.getByRole("button", { name: "Generate plan from requirements" }).click();
  await page.waitForURL(/\/plans\/[0-9a-f-]{36}/);
  const planUrl = page.url().split("?")[0];
  const planId = planUrl.split("/").pop();
  await page.getByRole("button", { name: "Submit for approval" }).click();
  await page.locator(".pill-awaiting_approval").first().waitFor();
  await page.getByRole("button", { name: "Approve as baseline" }).click();
  await page.getByText("Plan approved: it is now the project baseline.").waitFor();
  console.log("✓ plan approved (offline stand-in)");

  // --- Authorize an unattended run, then close the browser --------------------------------
  await page.getByLabel("Name", { exact: true }).fill("Overnight 1");
  await page.getByLabel("Supervision").selectOption("professional");
  await page.getByLabel("AI budget (USD)").fill("2");
  await page.getByRole("button", { name: "Authorize run" }).click();
  await page.waitForURL(/\/runs\/[0-9a-f-]{36}/);
  await expectNoError(page);
  const run1Url = page.url().split("?")[0];
  const run1 = run1Url.split("/").pop();
  await page.getByText("you can close this page").waitFor();
  await shot(page, "run-authorized");
  await browser.close();
  browser = null;
  console.log("✓ run authorized; browser closed");

  // --- Worker A starts, checkpoints, and is killed mid-task -------------------------------
  const a = startWorker("worker-A", { VX_STEP_DELAY_MS: "2000" });
  const victim = await waitFor("worker A to checkpoint the architecture draft", async () =>
    (await db(`executions?run_id=eq.${run1}&worker_id=eq.worker-A&status=eq.running&checkpoint_seq=gte.2&select=id,attempt,task_id`))[0]);
  await kill(a);
  console.log("✓ worker A killed after drafting (checkpoint 2)");

  const b = startWorker("worker-B");
  const r1 = await waitFor("run 1 report", async () => { const r = await runStatus(run1); return r?.report ? r : null; }, 90_000);
  const execs1 = await db(`executions?run_id=eq.${run1}&select=id,status,attempt,resumed_from_id,worker_id&order=created_at`);
  const resumed = execs1.find((e) => e.resumed_from_id === victim.id);
  assert.ok(resumed, "worker B resumed the killed execution");
  assert.equal(resumed.attempt, victim.attempt, "same attempt, no retry used");
  assert.equal(execs1.find((e) => e.id === victim.id).status, "interrupted");
  assert.equal(r1.status, "stopped");
  assert.match(r1.report.headline, /0 of 6 task\(s\) in scope complete; 1 awaiting your approval/);
  console.log("✓ worker B resumed from the checkpoint; run 1 stopped awaiting approval");

  // --- Come back: the report and the approval are waiting ---------------------------------
  browser = await chromium.launch();
  page = await newPage(browser);
  await signIn(page, owner);
  await page.goto(run1Url);
  await page.getByTestId("run-report").waitFor();
  assert.equal(await page.getByTestId("run-status").innerText(), "Stopped");
  await page.getByText("Review and approve architecture (unblocks power-budget, enclosure-envelope).").waitFor();
  await page.getByText(/attempt 1 \(resumed from checkpoint\)/).waitFor();
  await page.getByText("Recovered interruptions").waitFor();
  const approval = page.locator(".approval[data-task=architecture]");
  await approval.getByRole("link", { name: /architecture\/brief v1/ }).waitFor();
  await shot(page, "run1-report-awaiting-approval");

  // The brief is labelled as offline output, not engineering.
  await approval.getByRole("link", { name: /architecture\/brief v1/ }).click();
  await page.getByText("Offline stand-in.", { exact: false }).first().waitFor();
  await page.getByText("Validated, awaiting approval").waitFor();
  await shot(page, "artifact-brief");
  await page.goto(run1Url);

  await page.locator(".approval[data-task=architecture]").getByRole("button", { name: "Approve and commit" }).click();
  await page.getByText("Approved: outputs committed").waitFor();
  console.log("✓ architecture approved and committed from the run page");

  // --- Continue: power budget and envelope run; schematic has no executor yet -------------
  await page.getByRole("button", { name: "Continue in a new run" }).click();
  await page.waitForURL((u) => u.pathname.includes("/runs/") && !u.href.startsWith(run1Url));
  const run2Url = page.url().split("?")[0];
  const run2 = run2Url.split("/").pop();
  await waitFor("run 2 report", async () => (await runStatus(run2))?.report, 90_000);
  await page.reload();
  await page.getByTestId("run-report").waitFor();
  for (const key of ["power-budget", "enclosure-envelope"]) {
    await page.locator(`.approval[data-task=${key}]`).getByRole("button", { name: "Approve and commit" }).click();
    await page.getByText("Approved: outputs committed").waitFor();
  }
  await page.getByRole("button", { name: "Continue in a new run" }).click();
  await page.waitForURL((u) => u.pathname.includes("/runs/") && !u.href.startsWith(run2Url));
  const run3Url = page.url().split("?")[0];
  const run3 = run3Url.split("/").pop();
  await waitFor("run 3 report", async () => (await runStatus(run3))?.report, 90_000);
  await page.reload();
  await page.getByTestId("run-report").waitFor();
  await page.getByText(/schematic needs a worker that can run schematic tasks \(the KiCad engineering worker\)/).waitFor();
  await shot(page, "run3-report-waiting-for-kicad");
  const tasks = await taskStatus(planId);
  assert.deepEqual(tasks, {
    architecture: "complete", "power-budget": "complete", "enclosure-envelope": "complete",
    schematic: "ready", "pcb-layout": "ready", verification: "ready",
  });
  console.log("✓ runs 2 and 3: briefs approved and committed; schematic waits for a KiCad worker (report says so)");

  // --- No duplicate committed work, no repeated model calls -------------------------------
  const versions = await db(`artifact_versions?project_id=eq.${projectId}&select=id,status,produced_by_task_id,artifact_id`);
  const committed = versions.filter((v) => v.status === "committed");
  assert.equal(committed.length, 3, "three committed briefs");
  assert.equal(new Set(committed.map((v) => v.produced_by_task_id)).size, 3, "one committed version per task");
  assert.equal(versions.length, 3, "no duplicate scratch versions");
  const allExecs = await db(`executions?project_id=eq.${projectId}&select=id,task_id,tasks(key)`);
  const calls = {};
  for (const e of allExecs) {
    const logs = await db(`execution_logs?execution_id=eq.${e.id}&message=like.model%20call*&select=id`);
    calls[e.tasks.key] = (calls[e.tasks.key] ?? 0) + logs.length;
  }
  assert.deepEqual(calls, { architecture: 1, "power-budget": 1, "enclosure-envelope": 1 });
  console.log("✓ exactly one model call and one committed version per task");

  // --- Project overview lists the runs; outsiders see nothing -----------------------------
  await page.goto(projectUrl);
  await page.getByText(/Overnight 1 \(continued\)/).first().waitFor();
  await shot(page, "project-runs");
  const other = await newPage(browser);
  await signIn(other, { email: `g2-outsider-${Date.now()}@example.test`, password: "correct-horse-battery" }, true);
  const resp = await other.goto(run1Url);
  assert.equal(resp.status(), 404, "outsider gets 404 for the run");
  console.log("✓ outsiders cannot open the run");

  await kill(b);
  console.log("\nG2 end-to-end flow passed.");
} catch (e) {
  console.error("\n✗ G2 end-to-end flow failed:", e.message);
  process.exitCode = 1;
} finally {
  for (const w of workers) w.kill("SIGKILL");
  await browser?.close();
}
