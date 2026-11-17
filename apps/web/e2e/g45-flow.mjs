// End-to-end test of G4.5 in the browser. The schematic and layout are produced and approved through the
// API (G3/G4 flows cover doing that in the browser); the fab package task then runs on the KiCad worker
// and the reviewer sees the order card with the fab notes, the independent checks and the panel, approves,
// and every file commits.
//
// Needs the app running (VX_LLM=offline), the local Supabase stack and the vx-engineering-worker image
// (./scripts/test-e2e-g45.sh).
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
const owner = { email: `g45-owner-${Date.now()}@example.test`, password: "correct-horse-battery" };

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

  const user = createClient(URL, ANON, { auth: { persistSession: false } });
  assert.ifError((await user.auth.signInWithPassword(owner)).error);
  const { data: project } = await user.from("projects").insert({ name: "Timecode sub-board (G4.5 e2e)" }).select("id").single();
  const { data: planId } = await user.rpc("create_plan_version", { p_project_id: project.id, p_payload: { summary: "G4.5 e2e", tasks: [
    { key: "schematic", title: "Schematic", discipline: "schematic" },
    { key: "pcb-layout", title: "Layout", discipline: "pcb_layout", upstream_keys: ["schematic"] },
    { key: "fab-package", title: "Fab package", discipline: "manufacturing", upstream_keys: ["pcb-layout"] },
  ] } });
  await user.rpc("submit_plan", { p_plan_id: planId });
  await user.rpc("decide_plan", { p_plan_id: planId, p_approve: true, p_note: null });
  const task = async (key) => (await admin.from("tasks").select("id, status").eq("plan_id", planId).eq("key", key).single()).data;
  eng = execFileSync("docker", ["run", "-d", "--rm", "--network", "host", "--name", `e2e-g45-${Date.now()}`, ...proxyArgs(),
    "-e", `SUPABASE_URL=${URL}`, "-e", `SUPABASE_SERVICE_ROLE_KEY=${SERVICE}`, "-e", "VX_LLM=offline",
    "-e", "WORKER_ID=kicad-worker", "-e", "WORKER_POLL_MS=500", IMAGE], { encoding: "utf8" }).trim();

  let runId;
  for (const key of ["schematic", "pcb-layout", "fab-package"]) {
    ({ data: runId } = await user.rpc("authorize_run", { p_plan_id: planId, p_mode: "autonomous", p_max_ai_spend_usd: 5,
                                                          p_max_compute_spend_usd: 5, p_name: key }));
    await waitFor(`${key} to await approval`, async () => {
      const s = (await task(key)).status;
      if (["failed", "blocked"].includes(s)) throw new Error(`${key} ${s}`);
      return s === "awaiting_approval";
    });
    if (key === "fab-package") break;
    await user.rpc("decide_task", { p_task_id: (await task(key)).id, p_approve: true, p_note: "ok" });
    await waitFor(`${key} report`, async () => (await admin.from("runs").select("report").eq("id", runId).single()).data?.report, 120_000);
  }
  console.log("✓ schematic and layout approved; fab package awaits approval");

  const runUrl = `${BASE}/projects/${project.id}/runs/${runId}`;
  await page.goto(runUrl);
  const panel = page.locator(".approval[data-task=fab-package]");
  await panel.getByText("A fab package is a release").waitFor();
  await panel.locator("img.render").waitFor();
  await shot(page, "fab-awaiting-approval");

  await panel.locator("a:has(img.render)").click();
  await page.getByTestId("order-card").waitFor();
  const notes = await page.getByTestId("fab-notes").innerText();
  assert.match(notes, /Dimensions \.+ 34(\.0)? x 22(\.0)? mm/);
  assert.match(notes, /LCSC part numbers \.\. MISSING/);
  await page.getByText(/dfm: Gerbers re-read without KiCad/).waitFor();
  await page.getByText(/Release gate, KiCad DRC with schematic parity: 0 errors/).waitFor();
  await page.getByAltText("Panel render").waitFor();
  await shot(page, "fab-package-order");
  console.log("✓ package page: order steps, fab notes, checks and panel");

  await page.getByRole("link", { name: /fab-package\/fab-check v1/ }).click();
  const checks = await page.getByTestId("fab-checks").innerText();
  assert.match(checks, /Gerbers: 9 layers; outline 34 x 22 mm; 3 plated \+ 4 non-plated holes/);
  assert.match(checks, /6 pick-and-place rows/);
  await page.locator("tr[data-ref=U1]").getByText("missing").waitFor();
  await shot(page, "fab-check");
  console.log("✓ fab check page: independent Gerber, CPL and BOM checks, parts and manifest");

  await page.goto(runUrl);
  await page.locator(".approval[data-task=fab-package]").getByRole("button", { name: "Approve and commit" }).click();
  await page.getByText("Approved: outputs committed").waitFor();
  const { data: versions } = await admin.from("artifact_versions").select("status").eq("produced_by_task_id", (await task("fab-package")).id);
  assert.equal(versions.length, 10);
  assert.ok(versions.every((v) => v.status === "committed"));
  console.log("✓ approved: 10 fab package files committed");
  console.log("\nG4.5 end-to-end flow passed.");
} catch (e) {
  console.error("\n✗ G4.5 end-to-end flow failed:", e.message);
  process.exitCode = 1;
} finally {
  if (eng) try { execFileSync("docker", ["rm", "-f", eng], { stdio: "ignore" }); } catch { /* gone */ }
  await browser.close();
}
