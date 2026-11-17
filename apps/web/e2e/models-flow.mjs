// End-to-end test of the 3D model library in the browser: an engineer uploads a vendor-style STEP for U1,
// the KiCad worker aligns it to the footprint and draws the overlay, the engineer verifies it with a note.
//
// Needs the app running, the local Supabase stack and the vx-engineering-worker image (./scripts/test-e2e-models.sh).
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const { createClient } = createRequire(join(here, "../../../services/orchestrator/package.json"))("@supabase/supabase-js");

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const { SUPABASE_URL: URL, SUPABASE_SERVICE_ROLE_KEY: SERVICE } = process.env;
if (!URL || !SERVICE) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
const IMAGE = process.env.ENGINEERING_WORKER_IMAGE ?? "vx-engineering-worker";
const SHOTS = process.env.SCREENSHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });
const owner = { email: `models-owner-${Date.now()}@example.test`, password: "correct-horse-battery" };

let step = 0;
async function shot(page, name) {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${String(++step).padStart(2, "0")}-${name}.png`), fullPage: true });
}

const dir = mkdtempSync(join(tmpdir(), "vx-models-e2e-"));
chmodSync(dir, 0o777);
execFileSync("docker", ["run", "--rm", "-v", `${dir}:/w`, "-v", `${join(here, "../../../services/engineering/tests")}:/t:ro`, "-e", "PYTHONPATH=/t",
  "--entrypoint", "python3", IMAGE, "-c", "from pathlib import Path; from model_fixtures import sot23_5; sot23_5(Path('/w/AP2112K_vendor.step'))"]);

const browser = await chromium.launch();
let eng;
try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1 })).newPage();
  await page.goto(`${BASE}/login`);
  await page.getByLabel("Email").fill(owner.email);
  await page.getByLabel("Password").fill(owner.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL(/\/projects$/);
  await page.getByLabel("Name").fill("Timecode sub-board (models e2e)");
  await page.getByRole("button", { name: /Create project/ }).click();
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}/);
  const projectUrl = page.url().split("?")[0];
  await page.getByRole("link", { name: "Open the model library" }).click();
  await page.getByRole("heading", { name: "3D model library" }).waitFor();

  await page.getByLabel("Manufacturer part number").fill("AP2112K-3.3TRG1");
  await page.getByLabel("Manufacturer", { exact: true }).fill("Diodes Incorporated");
  await page.getByLabel("KiCad footprint").fill("Package_TO_SOT_SMD:SOT-23-5");
  await page.getByLabel(/Body height/).fill("1.2");
  await page.getByLabel("Source").fill("Vendor CAD pack (test fixture)");
  await page.getByLabel("Licence / terms").fill("test fixture");
  await page.getByLabel("STEP or ZIP file").setInputFiles(join(dir, "AP2112K_vendor.step"));
  await page.getByRole("button", { name: "Add to the library" }).click();
  await page.getByText(/Added\. The KiCad worker checks it/).waitFor();
  assert.match(await page.locator(".model[data-model='AP2112K-3.3TRG1']").getByTestId("model-status").innerText(), /waiting for the KiCad worker/);
  console.log("✓ model uploaded; waiting for the KiCad worker");

  eng = execFileSync("docker", ["run", "-d", "--rm", "--network", "host", "--name", `e2e-models-${Date.now()}`,
    "-e", `SUPABASE_URL=${URL}`, "-e", `SUPABASE_SERVICE_ROLE_KEY=${SERVICE}`, "-e", "VX_LLM=offline",
    "-e", "WORKER_ID=kicad-worker", "-e", "WORKER_POLL_MS=500", IMAGE], { encoding: "utf8" }).trim();
  const card = page.locator(".model[data-model='AP2112K-3.3TRG1']");
  const end = Date.now() + 180_000;
  for (;;) {
    await page.reload();
    if (/checked: verify it/.test(await card.getByTestId("model-status").innerText())) break;
    if (Date.now() > end) throw new Error("model was not checked in time");
    await page.waitForTimeout(1500);
  }
  assert.match(await card.getByTestId("model-check").innerText(), /5 of 5 terminals on pads/);
  await card.locator("img.overlay").waitFor();
  await shot(page, "model-checked");
  console.log("✓ worker aligned the model: 5 of 5 terminals on pads, overlay drawn");

  await card.getByLabel(/Note/).fill("Leads on pads; pin 1 dot at pad 1");
  await card.getByRole("button", { name: "Verify model" }).click();
  await page.getByText("Verified: layouts will use this model.").waitFor();
  assert.match(await card.getByTestId("model-status").innerText(), /verified/);
  await shot(page, "model-verified");
  const { data } = await admin.from("part_models").select("status, verified_by, shared").eq("project_id", projectUrl.split("/").pop()).single();
  assert.equal(data.status, "verified");
  assert.equal(data.shared, false, "private unless marked shared");
  console.log("✓ verified by the engineer; private to the project");
  console.log("\n3D model library end-to-end flow passed.");
} catch (e) {
  console.error("\n✗ 3D model library end-to-end flow failed:", e.message);
  process.exitCode = 1;
} finally {
  if (eng) try { execFileSync("docker", ["rm", "-f", eng], { stdio: "ignore" }); } catch { /* gone */ }
  await browser.close();
}
