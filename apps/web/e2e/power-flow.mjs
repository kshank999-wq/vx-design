// End-to-end test of the power calculator in the browser: a power task runs on a plain worker (the model
// proposes the tree, the calculator checks it), and the reviewer sees the tree, the findings, the battery
// runtime and the basis of every number, then approves.
//
// Needs the app running (VX_LLM=offline) and the local Supabase stack (./scripts/test-e2e-power.sh).
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const { createClient } = createRequire(join(here, "../../../services/orchestrator/package.json"))("@supabase/supabase-js");

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const { SUPABASE_URL: URL, SUPABASE_SERVICE_ROLE_KEY: SERVICE, SUPABASE_ANON_KEY: ANON } = process.env;
if (!URL || !SERVICE || !ANON) throw new Error("SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and SUPABASE_ANON_KEY are required");
const SHOTS = process.env.SCREENSHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });
const owner = { email: `power-owner-${Date.now()}@example.test`, password: "correct-horse-battery" };

let step = 0;
async function shot(page, name) {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${String(++step).padStart(2, "0")}-${name}.png`), fullPage: true });
}
async function waitFor(what, fn, timeoutMs = 120_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

const browser = await chromium.launch();
const worker = spawn(process.execPath, [join(here, "../../../services/orchestrator/src/main.ts")], {
  env: { ...process.env, WORKER_ID: "power-worker", VX_LLM: "offline", VX_ENGINEERING: "off", VX_SOURCING: "off", WORKER_POLL_MS: "500" },
  stdio: ["ignore", "ignore", "inherit"],
});
try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1 })).newPage();
  await page.goto(`${BASE}/login`);
  await page.getByLabel("Email").fill(owner.email);
  await page.getByLabel("Password").fill(owner.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL(/\/projects$/);
  const user = createClient(URL, ANON, { auth: { persistSession: false } });
  assert.ifError((await user.auth.signInWithPassword(owner)).error);
  const { data: project } = await user.from("projects").insert({ name: "Timecode slate power (e2e)" }).select("id").single();
  await user.from("requirements").insert([{ project_id: project.id, ref_code: "REQ-PWR-001", kind: "power", priority: "must",
    text: "The slate shall run a full 12 hour shooting day from one 1S Li-ion pack." }]);
  const { data: planId } = await user.rpc("create_plan_version", { p_project_id: project.id, p_payload: { summary: "power e2e", tasks: [
    { key: "power-budget", title: "Power tree and budget", discipline: "power", requirement_refs: ["REQ-PWR-001"],
      acceptance_tests: [{ id: "AT1", description: "Power budget passes the calculator", method: "validation", validationKind: "power_budget" }] },
  ] } });
  await user.rpc("submit_plan", { p_plan_id: planId });
  await user.rpc("decide_plan", { p_plan_id: planId, p_approve: true, p_note: null });
  const { data: runId } = await user.rpc("authorize_run", { p_plan_id: planId, p_mode: "autonomous", p_max_ai_spend_usd: 5, p_max_compute_spend_usd: 5, p_name: "power" });
  const task = async () => (await admin.from("tasks").select("id, status, blocker_reason").eq("plan_id", planId).single()).data;
  await waitFor("power task", async () => (await task()).status === "awaiting_approval");
  console.log("✓ power task ran on a plain worker and awaits approval");

  await page.goto(`${BASE}/projects/${project.id}/runs/${runId}`);
  const panel = page.locator(".approval[data-task=power-budget]");
  await panel.getByText(/Offline stand-in: the fixture power tree/).waitFor();
  await panel.getByRole("link", { name: /power-budget\/power-budget v1/ }).click();
  await page.getByText(/power budget: Power calculator: 1 source\(s\), 1 converter\(s\)/).waitFor();
  assert.match(await page.getByTestId("power-status").innerText(), /0 error\(s\)/);
  const tree = await page.getByTestId("power-tree").innerText();
  assert.match(tree, /1S Li-ion pack VBAT 3–4.2 V 40.\d mA worst case \(at 3 V\)/, "worst battery current is at the lowest cell voltage");
  assert.match(tree, /3.3 V buck-boost/);
  assert.match(tree, /Timecode reference oscillator/);
  const runtime = await page.getByTestId("power-runtime").innerText();
  assert.match(runtime, /5\.92 Wh/);
  assert.match(runtime, /day\(s\)/);
  await page.getByText("Offline stand-in: typical 2000 mAh 18650-class cell").waitFor();
  await shot(page, "power-budget");
  console.log("✓ power page: tree, findings, battery runtime, basis of every number");

  await page.goto(`${BASE}/projects/${project.id}/runs/${runId}`);
  await page.locator(".approval[data-task=power-budget]").getByRole("button", { name: "Approve and commit" }).click();
  await page.getByText("Approved: outputs committed").waitFor();
  const { data: versions } = await admin.from("artifact_versions").select("status, artifacts(kind)").eq("produced_by_task_id", (await task()).id);
  assert.equal(versions.length, 1);
  assert.equal(versions[0].artifacts.kind, "power_budget");
  assert.equal(versions[0].status, "committed");
  console.log("✓ approved: power budget committed");
  console.log("\nPower end-to-end flow passed.");
} catch (e) {
  console.error("\n✗ Power end-to-end flow failed:", e.message);
  process.exitCode = 1;
} finally {
  worker.kill("SIGKILL");
  await browser.close();
}
