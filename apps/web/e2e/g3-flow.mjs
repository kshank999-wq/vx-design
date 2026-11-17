// End-to-end test of G3 in the browser: a schematic task waits while only a worker without
// KiCad is online, then the KiCad engineering worker designs and checks the circuit; the
// reviewer sees the drawing, ERC report and component evidence, approves, and the outputs commit.
//
// Needs the app running (VX_LLM=offline), the local Supabase stack, the vx-engineering-worker
// image, and SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY (./scripts/test-e2e-g3.sh).
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
const owner = { email: `g3-owner-${Date.now()}@example.test`, password: "correct-horse-battery" };

let step = 0;
async function shot(page, name) {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${String(++step).padStart(2, "0")}-${name}.png`), fullPage: true });
}
async function waitFor(what, fn, timeoutMs = 300_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}
function proxyArgs() {
  const args = [];
  for (const k of ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"]) if (process.env[k]) args.push("-e", `${k}=${process.env[k]}`);
  if (process.env.HTTPS_PROXY) args.push("-e", "NODE_USE_ENV_PROXY=1");
  if (process.env.NODE_EXTRA_CA_CERTS) args.push("-v", `${process.env.NODE_EXTRA_CA_CERTS}:/etc/vx-extra-ca.crt:ro`, "-e", "NODE_EXTRA_CA_CERTS=/etc/vx-extra-ca.crt");
  return args;
}

// Forget workers from earlier runs so "online" reflects only the workers this test starts.
await admin.from("workers").delete().neq("id", "");
const browser = await chromium.launch();
const plain = spawn(process.execPath, [join(here, "../../../services/orchestrator/src/main.ts")], {
  env: { ...process.env, WORKER_ID: "plain-worker", VX_LLM: "offline", WORKER_POLL_MS: "500", VX_ENGINEERING: "off" },
  stdio: ["ignore", "ignore", "inherit"],
});
let eng;
try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1 })).newPage();
  await page.goto(`${BASE}/login`);
  await page.getByLabel("Email").fill(owner.email);
  await page.getByLabel("Password").fill(owner.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL(/\/projects$/);

  // Plan setup through the API as the same user (G1 covers doing this in the browser).
  const user = createClient(URL, ANON, { auth: { persistSession: false } });
  assert.ifError((await user.auth.signInWithPassword(owner)).error);
  const { data: project } = await user.from("projects").insert({ name: "Timecode sub-board (G3 e2e)" }).select("id").single();
  await user.from("requirements").insert([{ project_id: project.id, ref_code: "REQ-PWR-001", kind: "power", priority: "must",
    text: "The board shall regulate the 5 V input to 3.3 V for the timecode logic." }]);
  const { data: planId } = await user.rpc("create_plan_version", { p_project_id: project.id, p_payload: { summary: "G3 e2e", tasks: [
    { key: "schematic", title: "Power sub-board schematic", discipline: "schematic", requirement_refs: ["REQ-PWR-001"],
      acceptance_tests: [{ id: "AT1", description: "ERC passes with zero errors", method: "validation", validationKind: "erc" }] }] } });
  await user.rpc("submit_plan", { p_plan_id: planId });
  await user.rpc("decide_plan", { p_plan_id: planId, p_approve: true, p_note: null });

  await page.goto(`${BASE}/projects/${project.id}/plans/${planId}`);
  await page.getByLabel("Name", { exact: true }).fill("Schematic run");
  await page.getByLabel("Supervision").selectOption("autonomous");
  await page.getByRole("button", { name: "Authorize run" }).click();
  await page.waitForURL(/\/runs\/[0-9a-f-]{36}/);
  const runUrl = page.url().split("?")[0];
  console.log("✓ run authorized for a schematic task");

  // Only the plain worker is online: the task waits and the page says why.
  await waitFor("the uncovered-discipline banner", async () => {
    await page.reload();
    return (await page.getByTestId("uncovered").count()) > 0;
  }, 60_000);
  assert.match(await page.getByTestId("uncovered").innerText(), /No online worker can run schematic tasks/);
  const t0 = (await admin.from("tasks").select("status").eq("plan_id", planId).single()).data;
  assert.equal(t0.status, "ready", "plain worker left the task alone");
  await shot(page, "waiting-for-kicad-worker");
  console.log("✓ schematic task waits; page says no online worker can run it");

  eng = execFileSync("docker", ["run", "-d", "--rm", "--network", "host", "--name", `e2e-eng-${Date.now()}`, ...proxyArgs(),
    "-e", `SUPABASE_URL=${URL}`, "-e", `SUPABASE_SERVICE_ROLE_KEY=${SERVICE}`, "-e", "VX_LLM=offline",
    "-e", "WORKER_ID=kicad-worker", "-e", "WORKER_POLL_MS=500", IMAGE], { encoding: "utf8" }).trim();
  await waitFor("the schematic task to await approval", async () =>
    (await admin.from("tasks").select("status").eq("plan_id", planId).single()).data?.status === "awaiting_approval");
  await page.goto(runUrl);
  const panel = page.locator(".approval[data-task=schematic]");
  await panel.locator("img.schematic").waitFor();
  await page.getByText("Offline stand-in: the fixture circuit is not derived from your requirements").waitFor();
  await shot(page, "awaiting-approval-with-schematic");
  console.log("✓ KiCad worker produced the schematic; approval panel shows the drawing");

  await panel.getByRole("link", { name: /schematic\/kicad-project v1/ }).click();
  await page.getByRole("heading", { name: "Open in KiCad" }).waitFor();
  await page.locator("img.schematic").waitFor();
  await page.getByText(/erc: KiCad ERC: 0 errors/).waitFor();
  await shot(page, "kicad-project");
  await page.getByRole("link", { name: /schematic\/erc-report v1/ }).click();
  assert.match(await page.getByTestId("erc-summary").innerText(), /0 error\(s\), 0 warning\(s\)/);
  await page.getByRole("link", { name: /schematic\/component-evidence v1/ }).click();
  const counts = await page.getByTestId("evidence-counts").innerText();
  const u1 = page.locator("tr[data-ref=U1]");
  await u1.getByText("every pin has a pad").waitFor();
  console.log(`  component evidence: ${counts}`);
  if (/^1 verified/.test(counts)) await u1.getByText("600mA", { exact: true }).waitFor();
  await shot(page, "component-evidence");
  console.log("✓ project, ERC report and component evidence pages render");

  await page.goto(runUrl);
  await page.locator(".approval[data-task=schematic]").getByRole("button", { name: "Approve and commit" }).click();
  await page.getByText("Approved: outputs committed").waitFor();
  const { data: versions } = await admin.from("artifact_versions").select("status").eq("project_id", project.id);
  assert.equal(versions.length, 8);
  assert.ok(versions.every((v) => v.status === "committed"), "all eight outputs committed");
  console.log("✓ approved: 8 outputs committed");
  console.log("\nG3 end-to-end flow passed.");
} catch (e) {
  console.error("\n✗ G3 end-to-end flow failed:", e.message);
  process.exitCode = 1;
} finally {
  plain.kill("SIGKILL");
  if (eng) try { execFileSync("docker", ["rm", "-f", eng], { stdio: "ignore" }); } catch { /* gone */ }
  await browser.close();
}
