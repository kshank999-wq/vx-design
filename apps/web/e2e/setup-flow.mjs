// End-to-end test of the guided project setup.
//  - Step 1 saves the name, code, description and product class (chips); readiness rises and step 1 shows done.
//  - Step 3 saves the intake from chips (markets, power, radios, standards) and the size boxes.
//  - Step 5 lists what is still missing; the manifest and readiness ring reflect what was entered.
//
// Needs the app running (VX_LLM=offline) and the local Supabase stack (./scripts/test-e2e-setup.sh).
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const { createClient } = createRequire(join(here, "../../../services/orchestrator/package.json"))("@supabase/supabase-js");

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const { SUPABASE_URL: URL, SUPABASE_ANON_KEY: ANON } = process.env;
if (!URL || !ANON) throw new Error("SUPABASE_URL and SUPABASE_ANON_KEY are required");
const SHOTS = process.env.SCREENSHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true }); };
const stamp = Date.now();
const owner = { email: `setup-${stamp}@example.test`, password: "correct-horse-battery" };

const browser = await chromium.launch();
let page;
try {
  page = await (await browser.newContext({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1 })).newPage();
  await page.goto(`${BASE}/login`);
  await page.getByLabel("Email").fill(owner.email);
  await page.getByLabel("Password").fill(owner.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL(/\/projects$/);
  const api = createClient(URL, ANON, { auth: { persistSession: false } });
  assert.ifError((await api.auth.signInWithPassword(owner)).error);
  const { data: project } = await api.from("projects").insert({ name: `Setup ${stamp}` }).select("id").single();

  await page.goto(`${BASE}/projects/${project.id}`);
  await page.getByRole("link", { name: "Guided setup" }).click();
  await page.waitForURL(/\/setup$/);
  assert.equal(await page.getByTestId("setup-step").getAttribute("data-step"), "1", "starts at the first unfinished step");
  assert.match(await page.getByTestId("readiness").innerText(), /0%/);

  // Step 1.
  await page.getByLabel("Project code").fill("VXS-001");
  await page.getByLabel("Project description").fill("10-inch touchscreen timecode slate for film sets.");
  await page.getByLabel("Handheld device", { exact: true }).check();
  await page.getByRole("button", { name: "Save and continue →" }).click();
  await page.getByText("Project saved.").first().waitFor();
  assert.equal(await page.getByTestId("setup-step").getAttribute("data-step"), "2");
  assert.match(await page.locator(".setup-step.done").first().innerText(), /Project/);
  const { data: p } = await api.from("projects").select("code, product_class, description").eq("id", project.id).single();
  assert.deepEqual(p, { code: "VXS-001", product_class: "handheld", description: "10-inch touchscreen timecode slate for film sets." });

  // Step 3.
  await page.getByRole("link", { name: /Intake/ }).first().click();
  await page.getByLabel("Intended use").fill("Camera departments on film and TV sets.");
  for (const t of ["US", "EU", "Rechargeable Li-ion", "USB-C", "Wi-Fi", "Bluetooth LE", "FCC Part 15", "CE RED"]) await page.getByLabel(t, { exact: true }).check();
  await page.getByLabel("Quantity").fill("250");
  await page.getByLabel("Maximum length").fill("260");
  await page.getByLabel("Maximum width").fill("190");
  await page.getByLabel("Maximum height").fill("28");
  await page.getByRole("button", { name: "Save and continue →" }).click();
  await page.getByText("Intake saved.").first().waitFor();
  const { data: intake } = await api.from("project_intake").select("regions, quantity, max_dimensions, power_source, radios, target_standards").eq("project_id", project.id).single();
  assert.deepEqual(intake, { regions: ["US", "EU"], quantity: 250, max_dimensions: "260 × 190 × 28 mm", power_source: "Rechargeable Li-ion + USB-C",
    radios: ["Wi-Fi", "Bluetooth LE"], target_standards: ["FCC Part 15", "CE RED"] });
  await shot(page, "01-setup-inputs");

  // Step 3 again shows the saved chips; step 5 lists what is missing.
  await page.goto(`${BASE}/projects/${project.id}/setup?step=3`);
  assert.equal(await page.locator(".chip-opt input[value='EU']").isChecked(), true);
  assert.equal(await page.locator(".chip-opt input[value='USB-C']").isChecked(), true);
  await page.goto(`${BASE}/projects/${project.id}/setup?step=5`);
  const checks = await page.getByTestId("readiness-checks").innerText();
  assert.match(checks, /✓\s*Name and purpose/);
  assert.match(checks, /○\s*A specification/);
  assert.match(await page.getByTestId("readiness").innerText(), /55%/);
  assert.match(await page.locator(".manifest").innerText(), /Identity\s+Setup \d+ · VXS-001[\s\S]*Intake\s+2 market\(s\) · 2 radio\(s\)/);
  await shot(page, "02-setup-review");
  console.log("Setup flow passed: identity with chips, intake from chips and size boxes, readiness, manifest and missing items.");
} catch (e) {
  if (page && process.env.FAIL_SHOT) await page.screenshot({ path: process.env.FAIL_SHOT, fullPage: true });
  throw e;
} finally {
  await browser.close();
}
