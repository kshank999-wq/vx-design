// End-to-end test of G4 in the browser: the schematic is approved, the run is continued, and the
// KiCad engineering worker places, routes and checks the board. The reviewer sees the 3D render,
// the interactive 3D board, the DRC report with schematic parity, the 3D model report and the
// placement, approves, and every output commits.
//
// Needs the app running (VX_LLM=offline), the local Supabase stack, the vx-engineering-worker
// image, and SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY (./scripts/test-e2e-g4.sh).
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
const owner = { email: `g4-owner-${Date.now()}@example.test`, password: "correct-horse-battery" };

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
  const { data: project } = await user.from("projects").insert({ name: "Timecode sub-board (G4 e2e)" }).select("id").single();
  await user.from("requirements").insert([
    { project_id: project.id, ref_code: "REQ-PWR-001", kind: "power", priority: "must", text: "The board shall regulate the 5 V input to 3.3 V." },
    { project_id: project.id, ref_code: "REQ-MEC-001", kind: "mechanical", priority: "must", text: "The board shall have M3 mounting holes." },
  ]);
  const { data: planId } = await user.rpc("create_plan_version", { p_project_id: project.id, p_payload: { summary: "G4 e2e", tasks: [
    { key: "schematic", title: "Power sub-board schematic", discipline: "schematic", requirement_refs: ["REQ-PWR-001"],
      acceptance_tests: [{ id: "AT1", description: "ERC passes with zero errors", method: "validation", validationKind: "erc" }] },
    { key: "pcb-layout", title: "Power sub-board layout", discipline: "pcb_layout", upstream_keys: ["schematic"], requirement_refs: ["REQ-MEC-001"],
      acceptance_tests: [{ id: "AT1", description: "DRC passes with zero errors", method: "validation", validationKind: "drc" }] },
  ] } });
  await user.rpc("submit_plan", { p_plan_id: planId });
  await user.rpc("decide_plan", { p_plan_id: planId, p_approve: true, p_note: null });
  const taskStatus = async (key) => (await admin.from("tasks").select("status").eq("plan_id", planId).eq("key", key).single()).data?.status;

  await page.goto(`${BASE}/projects/${project.id}/plans/${planId}`);
  await page.getByLabel("Name", { exact: true }).fill("Board run");
  await page.getByLabel("Supervision").selectOption("autonomous");
  await page.getByRole("button", { name: "Authorize run" }).click();
  await page.waitForURL(/\/runs\/[0-9a-f-]{36}/);
  const run1 = page.url().split("?")[0];
  const run1Id = run1.split("/").pop();
  eng = execFileSync("docker", ["run", "-d", "--rm", "--network", "host", "--name", `e2e-g4-${Date.now()}`, ...proxyArgs(),
    "-e", `SUPABASE_URL=${URL}`, "-e", `SUPABASE_SERVICE_ROLE_KEY=${SERVICE}`, "-e", "VX_LLM=offline",
    "-e", "WORKER_ID=kicad-worker", "-e", "WORKER_POLL_MS=500", IMAGE], { encoding: "utf8" }).trim();
  console.log("✓ run authorized; KiCad worker started");

  // 1. Schematic: approve in the browser, then continue in a new run once the first one has reported.
  await waitFor("the schematic to await approval", async () => (await taskStatus("schematic")) === "awaiting_approval");
  await page.goto(run1);
  await page.locator(".approval[data-task=schematic]").getByRole("button", { name: "Approve and commit" }).click();
  await page.getByText("Approved: outputs committed").waitFor();
  await waitFor("the first run's report", async () => (await admin.from("runs").select("report").eq("id", run1Id).single()).data?.report, 120_000);
  await page.goto(run1);
  await page.getByRole("button", { name: "Continue in a new run" }).click();
  await page.waitForURL((u) => /\/runs\/[0-9a-f-]{36}/.test(u.pathname) && !u.pathname.endsWith(run1Id));
  const run2 = page.url().split("?")[0];
  console.log("✓ schematic approved; run continued for the layout");

  // 2. Layout awaits approval with a 3D render of the routed board.
  await waitFor("the layout to await approval", async () => {
    const s = await taskStatus("pcb-layout");
    if (["failed", "blocked"].includes(s)) throw new Error(`layout task ${s}`);
    return s === "awaiting_approval";
  });
  await page.goto(run2);
  const panel = page.locator(".approval[data-task=pcb-layout]");
  await panel.locator("img.render").waitFor();
  await page.getByText("Offline stand-in: the fixture layout is not derived from your requirements").waitFor();
  await shot(page, "layout-awaiting-approval");
  console.log("✓ layout awaits approval; the panel shows the 3D render");

  // 3. Project page: open-in-KiCad notes, interactive 3D board, DRC and parity checks.
  await panel.locator("a:has(img.render)").click();
  await page.getByRole("heading", { name: "Open in KiCad" }).waitFor();
  await page.getByText(/the routed board, linked to each other/).waitFor();
  await page.getByText(/drc: KiCad DRC: 0 errors, 0 warnings, 0 unrouted, 0 waived/).waitFor();
  await page.getByText(/Schematic parity: the board matches the schematic/).waitFor();
  await page.getByTestId("board-3d").waitFor();
  await page.waitForFunction(() => document.querySelector("model-viewer")?.loaded === true, null, { timeout: 60_000 });
  await page.waitForTimeout(1000);
  await shot(page, "kicad-project-3d");
  console.log("✓ project page: KiCad notes, checks and the interactive 3D board (GLB loaded)");

  await page.getByRole("link", { name: /pcb-layout\/drc-report v1/ }).click();
  assert.match(await page.getByTestId("drc-summary").innerText(), /0 error\(s\), 0 warning\(s\), 0 unrouted connection\(s\), 0 schematic difference\(s\), 0 waived/);
  await shot(page, "drc-report");
  await page.getByRole("link", { name: /pcb-layout\/model-report v1/ }).click();
  const models = await page.getByTestId("model-counts").innerText();
  console.log(`  3D models: ${models}`);
  await page.locator("tr[data-ref=U1]").getByText("SOT-23-5.step").waitFor();
  await shot(page, "model-report");
  await page.getByRole("link", { name: /pcb-layout\/layout v1/ }).click();
  await page.getByRole("heading", { name: "Board layout" }).waitFor();
  await page.getByText("34 x 22 mm, 1.5 mm corners").waitFor();
  await page.getByRole("link", { name: /pcb-layout\/pcb-top-svg v1/ }).click();
  await page.locator("img.schematic").waitFor();
  await shot(page, "pcb-top");
  console.log("✓ DRC report, 3D model report, placement and copper drawing pages render");

  // 4. Approve: all twelve outputs commit.
  await page.goto(run2);
  await page.locator(".approval[data-task=pcb-layout]").getByRole("button", { name: "Approve and commit" }).click();
  await page.getByText("Approved: outputs committed").waitFor();
  const layoutTaskId = (await admin.from("tasks").select("id").eq("plan_id", planId).eq("key", "pcb-layout").single()).data.id;
  const { data: versions } = await admin.from("artifact_versions").select("status").eq("produced_by_task_id", layoutTaskId);
  assert.equal(versions.length, 12);
  assert.ok(versions.every((v) => v.status === "committed"), "all twelve outputs committed");
  console.log("✓ approved: 12 layout outputs committed");
  console.log("\nG4 end-to-end flow passed.");
} catch (e) {
  console.error("\n✗ G4 end-to-end flow failed:", e.message);
  process.exitCode = 1;
} finally {
  if (eng) try { execFileSync("docker", ["rm", "-f", eng], { stdio: "ignore" }); } catch { /* gone */ }
  await browser.close();
}
