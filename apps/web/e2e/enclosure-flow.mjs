// End-to-end test of M-ENC in the browser. Schematic and layout are produced and approved through the API;
// the enclosure task runs on the KiCad worker; the reviewer sees the housing drawing in the approval panel,
// the fit report (no collisions, every part checked, openings, standoffs, mass) with the exploded 3D view,
// approves, and the outputs commit.
//
// Needs the app running, the local Supabase stack and the vx-engineering-worker image (./scripts/test-e2e-enclosure.sh).
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
const owner = { email: `enc-owner-${Date.now()}@example.test`, password: "correct-horse-battery" };

let step = 0;
async function shot(page, name) {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${String(++step).padStart(2, "0")}-${name}.png`), fullPage: true });
}
async function waitFor(what, fn, timeoutMs = 900_000) {
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
  const user = createClient(URL, ANON, { auth: { persistSession: false } });
  assert.ifError((await user.auth.signInWithPassword(owner)).error);
  const { data: project } = await user.from("projects").insert({ name: "Timecode sub-board (enclosure e2e)" }).select("id").single();
  const { data: planId } = await user.rpc("create_plan_version", { p_project_id: project.id, p_payload: { summary: "enclosure e2e", tasks: [
    { key: "schematic", title: "Schematic", discipline: "schematic" },
    { key: "pcb-layout", title: "Layout", discipline: "pcb_layout", upstream_keys: ["schematic"] },
    { key: "enclosure", title: "Enclosure", discipline: "enclosure", upstream_keys: ["pcb-layout"] },
  ] } });
  await user.rpc("submit_plan", { p_plan_id: planId });
  await user.rpc("decide_plan", { p_plan_id: planId, p_approve: true, p_note: null });
  const task = async (key) => (await admin.from("tasks").select("id, status").eq("plan_id", planId).eq("key", key).single()).data;
  eng = execFileSync("docker", ["run", "-d", "--rm", "--network", "host", "--name", `e2e-enc-${Date.now()}`, ...proxyArgs(),
    "-e", `SUPABASE_URL=${URL}`, "-e", `SUPABASE_SERVICE_ROLE_KEY=${SERVICE}`, "-e", "VX_LLM=offline",
    "-e", "WORKER_ID=kicad-worker", "-e", "WORKER_POLL_MS=500", IMAGE], { encoding: "utf8" }).trim();
  let runId;
  for (const key of ["schematic", "pcb-layout", "enclosure"]) {
    ({ data: runId } = await user.rpc("authorize_run", { p_plan_id: planId, p_mode: "autonomous", p_max_ai_spend_usd: 5, p_max_compute_spend_usd: 5, p_name: key }));
    await waitFor(key, async () => {
      const s = (await task(key)).status;
      if (["failed", "blocked"].includes(s)) throw new Error(`${key} ${s}`);
      return s === "awaiting_approval";
    });
    if (key === "enclosure") break;
    await user.rpc("decide_task", { p_task_id: (await task(key)).id, p_approve: true, p_note: "ok" });
    await waitFor(`${key} report`, async () => (await admin.from("runs").select("report").eq("id", runId).single()).data?.report, 120_000);
  }
  console.log("✓ schematic and layout approved; enclosure awaits approval");

  const runUrl = `${BASE}/projects/${project.id}/runs/${runId}`;
  await page.goto(runUrl);
  const panel = page.locator(".approval[data-task=enclosure]");
  await panel.getByText(/Offline stand-in: the fixture enclosure/).waitFor();
  await panel.locator("img.render").waitFor();
  await panel.locator("a:has(img.render)").click();
  assert.match(await page.getByTestId("fit-status").innerText(), /^Fits: 0 collision\(s\); 6 of 6 parts checked/);
  const facts = await page.getByTestId("fit-facts").innerText();
  assert.match(facts, /FDM 3D print \(PETG\/PLA\/ASA\), PETG/);
  assert.match(facts, /4 standoff\(s\), 6 mm high, heat set insert \(hole 4.2 mm/);
  await page.getByText(/fit check: Fit: no part or the board touches the housing/).waitFor();
  await page.getByTestId("board-3d").waitFor();
  await page.waitForFunction(() => document.querySelector("model-viewer")?.loaded === true, null, { timeout: 60_000 });
  await page.waitForTimeout(1000);
  await shot(page, "fit-report");
  console.log("✓ fit report: no collisions, all 6 parts checked, standoffs, openings, exploded 3D view loaded");

  await page.goto(runUrl);
  await page.locator(".approval[data-task=enclosure]").getByRole("button", { name: "Approve and commit" }).click();
  await page.getByText("Approved: outputs committed").waitFor();
  const { data: versions } = await admin.from("artifact_versions").select("status").eq("produced_by_task_id", (await task("enclosure")).id);
  assert.equal(versions.length, 12);
  assert.ok(versions.every((v) => v.status === "committed"));
  console.log("✓ approved: 12 enclosure outputs committed");
  console.log("\nEnclosure end-to-end flow passed.");
} catch (e) {
  console.error("\n✗ Enclosure end-to-end flow failed:", e.message);
  process.exitCode = 1;
} finally {
  if (eng) try { execFileSync("docker", ["rm", "-f", eng], { stdio: "ignore" }); } catch { /* gone */ }
  await browser.close();
}
