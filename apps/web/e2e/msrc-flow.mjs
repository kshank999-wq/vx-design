// End-to-end test of M-SRC in the browser. The schematic is produced and approved through the API; the
// sourcing task waits (no worker has distributor keys) and the run page says so; a worker with the
// fixture distributors then sources the BOM; the reviewer sees the sourced BOM (fixture banner, cost per
// board, rule-chosen passives, offers), approves, and the BOM commits.
//
// Needs the app running, the local Supabase stack and the vx-engineering-worker image (./scripts/test-e2e-msrc.sh).
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
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
const IMAGE = process.env.ENGINEERING_WORKER_IMAGE ?? "vx-engineering-worker";
const SHOTS = process.env.SCREENSHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });
const owner = { email: `msrc-owner-${Date.now()}@example.test`, password: "correct-horse-battery" };

let step = 0;
async function shot(page, name) {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${String(++step).padStart(2, "0")}-${name}.png`), fullPage: true });
}
async function waitFor(what, fn, timeoutMs = 600_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}
function proxyArgs() {
  const args = [];
  for (const k of ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"]) if (process.env[k]) args.push("-e", `${k}=${process.env[k]}`);
  if (process.env.HTTPS_PROXY) args.push("-e", "NODE_USE_ENV_PROXY=1");
  if (process.env.NODE_EXTRA_CA_CERTS) args.push("-v", `${process.env.NODE_EXTRA_CA_CERTS}:/etc/vx-extra-ca.crt:ro`, "-e", "NODE_EXTRA_CA_CERTS=/etc/vx-extra-ca.crt");
  return args;
}

await admin.from("workers").delete().neq("id", "");
const browser = await chromium.launch();
let eng, plain;
try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1 })).newPage();
  await page.goto(`${BASE}/login`);
  await page.getByLabel("Email").fill(owner.email);
  await page.getByLabel("Password").fill(owner.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL(/\/projects$/);

  const user = createClient(URL, ANON, { auth: { persistSession: false } });
  assert.ifError((await user.auth.signInWithPassword(owner)).error);
  const { data: project } = await user.from("projects").insert({ name: "Timecode sub-board (sourcing e2e)" }).select("id").single();
  const { data: planId } = await user.rpc("create_plan_version", { p_project_id: project.id, p_payload: { summary: "M-SRC e2e", tasks: [
    { key: "schematic", title: "Schematic", discipline: "schematic" },
    { key: "sourcing", title: "Source the BOM", discipline: "sourcing", upstream_keys: ["schematic"] },
  ] } });
  await user.rpc("submit_plan", { p_plan_id: planId });
  await user.rpc("decide_plan", { p_plan_id: planId, p_approve: true, p_note: null });
  const task = async (key) => (await admin.from("tasks").select("id, status").eq("plan_id", planId).eq("key", key).single()).data;
  eng = execFileSync("docker", ["run", "-d", "--rm", "--network", "host", "--name", `e2e-msrc-${Date.now()}`, ...proxyArgs(),
    "-e", `SUPABASE_URL=${URL}`, "-e", `SUPABASE_SERVICE_ROLE_KEY=${SERVICE}`, "-e", "VX_LLM=offline",
    "-e", "WORKER_ID=kicad-worker", "-e", "WORKER_POLL_MS=500", IMAGE], { encoding: "utf8" }).trim();
  const { data: run1 } = await user.rpc("authorize_run", { p_plan_id: planId, p_mode: "autonomous", p_max_ai_spend_usd: 5, p_max_compute_spend_usd: 5, p_name: "schematic" });
  await waitFor("schematic", async () => (await task("schematic")).status === "awaiting_approval");
  await user.rpc("decide_task", { p_task_id: (await task("schematic")).id, p_approve: true, p_note: "ok" });
  await waitFor("run 1 report", async () => (await admin.from("runs").select("report").eq("id", run1).single()).data?.report, 120_000);

  // Sourcing: no worker has distributor keys, so the run page says what is missing.
  await page.goto(`${BASE}/projects/${project.id}/plans/${planId}`);
  await page.getByLabel("Name", { exact: true }).fill("Sourcing run");
  await page.getByLabel("Supervision").selectOption("autonomous");
  await page.getByRole("button", { name: "Authorize run" }).click();
  await page.waitForURL(/\/runs\/[0-9a-f-]{36}/);
  const runUrl = page.url().split("?")[0];
  await waitFor("the uncovered banner", async () => { await page.reload(); return (await page.getByTestId("uncovered").count()) > 0; }, 90_000);
  assert.match(await page.getByTestId("uncovered").innerText(), /sourcing tasks: start a worker with distributor API keys/);
  await shot(page, "sourcing-waits-for-keys");
  console.log("✓ sourcing waits; the run page names the missing distributor keys");

  plain = spawn(process.execPath, [join(here, "../../../services/orchestrator/src/main.ts")], {
    env: { ...process.env, WORKER_ID: "sourcing-worker", VX_LLM: "offline", VX_ENGINEERING: "off", VX_SOURCING: "fixture", WORKER_POLL_MS: "500" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  await waitFor("sourcing", async () => (await task("sourcing")).status === "awaiting_approval");
  await page.goto(runUrl);
  const panel = page.locator(".approval[data-task=sourcing]");
  await panel.getByText(/Fixture sourcing data/).waitFor();
  await panel.getByRole("link", { name: /sourcing\/sourced-bom v1/ }).click();
  assert.match(await page.getByTestId("bom-status").innerText(), /Fixture data from the offline stand-in/);
  assert.match(await page.getByTestId("bom-counts").innerText(), /5 of 5 lines sourced · 4 with LCSC numbers · 0 error\(s\)/);
  const caps = page.locator("tr[data-refs='C1,C2']");
  await caps.getByText("FX-C0603-105-16V").waitFor();
  await caps.getByText("chosen by rules: review").waitFor();
  await page.locator("tr[data-refs='J1']").getByText("none").waitFor();
  await page.locator("tr[data-refs='U1'] details summary").click();
  await page.locator("tr[data-refs='U1'] details").getByRole("cell", { name: "Fixture Distributor A", exact: true }).waitFor();
  await shot(page, "sourced-bom");
  console.log("✓ sourced BOM page: fixture banner, cost per board, rule-chosen passives, offers");

  await page.goto(runUrl);
  await page.locator(".approval[data-task=sourcing]").getByRole("button", { name: "Approve and commit" }).click();
  await page.getByText("Approved: outputs committed").waitFor();
  const { data: versions } = await admin.from("artifact_versions").select("status").eq("produced_by_task_id", (await task("sourcing")).id);
  assert.equal(versions.length, 3);
  assert.ok(versions.every((v) => v.status === "committed"));
  console.log("✓ approved: sourced BOM committed");
  console.log("\nM-SRC end-to-end flow passed.");
} catch (e) {
  console.error("\n✗ M-SRC end-to-end flow failed:", e.message);
  process.exitCode = 1;
} finally {
  plain?.kill("SIGKILL");
  if (eng) try { execFileSync("docker", ["rm", "-f", eng], { stdio: "ignore" }); } catch { /* gone */ }
  await browser.close();
}
