// End-to-end test of the S0 requirement wizard.
//  - A client opens the wizard from the workspace's S0 step and answers all six steps; they can review but not apply.
//  - The owner reviews and creates the requirements: drafts with acceptance criteria and their basis, numbered per
//    kind; the intake is filled, so compliance suggestions follow from the answers.
//  - A changed answer updates its requirement (back to draft) instead of adding a duplicate.
//
// Needs the app running and the local Supabase stack (./scripts/test-e2e-wizard.sh).
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
const { SUPABASE_URL: URL, SUPABASE_SERVICE_ROLE_KEY: SERVICE, SUPABASE_ANON_KEY: ANON } = process.env;
if (!URL || !SERVICE || !ANON) throw new Error("SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and SUPABASE_ANON_KEY are required");
const SHOTS = process.env.SCREENSHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true }); };
const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });
const stamp = Date.now();
const owner = { email: `wiz-owner-${stamp}@example.test`, password: "correct-horse-battery" };
const client = { email: `wiz-client-${stamp}@example.test`, password: "correct-horse-battery" };

async function signIn(page, who, create) {
  await page.goto(`${BASE}/login`);
  await page.getByLabel("Email").fill(who.email);
  await page.getByLabel("Password").fill(who.password);
  await page.getByRole("button", { name: create ? "Create account" : "Sign in" }).click();
  await page.waitForURL(/\/projects/);
}

const browser = await chromium.launch();
let page;
try {
  const ctx = { viewport: { width: 1360, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1 };
  page = await (await browser.newContext(ctx)).newPage();
  await signIn(page, owner, true);
  const api = createClient(URL, ANON, { auth: { persistSession: false } });
  assert.ifError((await api.auth.signInWithPassword(owner)).error);
  const { data: project } = await api.from("projects").insert({ name: `Wizard ${stamp}` }).select("id").single();
  const { data: cu } = await admin.auth.admin.createUser({ email: client.email, password: client.password, email_confirm: true });
  assert.ifError((await admin.from("project_members").insert({ project_id: project.id, user_id: cu.user.id, role: "client" })).error);
  const P = `${BASE}/projects/${project.id}`;

  // 1. The client answers from the workspace.
  const cpage = await (await browser.newContext(ctx)).newPage();
  await signIn(cpage, client, false);
  await cpage.goto(`${P}/workspace`);
  await cpage.getByTestId("wizard-link").click();
  await cpage.getByTestId("step-product").waitFor();
  await cpage.getByLabel("Purpose").fill("Show and send film timecode on set");
  await cpage.getByLabel("Users").fill("camera crews");
  await cpage.getByLabel("Outdoors").check();
  await cpage.getByLabel("Quantity").fill("300");
  await cpage.getByLabel("Target unit cost").fill("85");
  await cpage.getByRole("button", { name: "Save and continue" }).click();
  await cpage.getByTestId("step-markets").waitFor();
  await cpage.getByLabel("US", { exact: true }).check();
  await cpage.getByLabel("EU", { exact: true }).check();
  await cpage.getByRole("button", { name: "Save and continue" }).click();
  await cpage.getByTestId("step-power").waitFor();
  await cpage.getByLabel("Power source").selectOption("li_ion");
  await cpage.getByLabel("Battery hours").fill("12");
  await cpage.getByLabel("Hours per day").fill("10");
  await cpage.getByLabel("Charges from USB-C").check();
  await cpage.getByRole("button", { name: "Save and continue" }).click();
  await cpage.getByTestId("step-connectivity").waitFor();
  await cpage.getByLabel("Bluetooth LE").check();
  await cpage.getByLabel("Radio range").fill("30");
  await cpage.getByLabel("Works with a phone app").check();
  await cpage.getByLabel("USB-C", { exact: true }).check();
  await cpage.getByLabel("Display", { exact: true }).selectOption("LED segment");
  await cpage.getByLabel("Buttons").fill("3");
  await cpage.getByRole("button", { name: "Save and continue" }).click();
  await cpage.getByTestId("step-physical").waitFor();
  await cpage.getByLabel("Max length").fill("280");
  await cpage.getByLabel("Max width").fill("120");
  await cpage.getByLabel("Max height").fill("30");
  await cpage.getByLabel("Min temperature").fill("-10");
  await cpage.getByLabel("Max temperature").fill("45");
  await cpage.getByLabel("IP rating").selectOption("IP54");
  await cpage.getByLabel("Drop height").fill("1.2");
  await cpage.getByRole("button", { name: "Save and continue" }).click();
  await cpage.getByTestId("step-extras").waitFor();
  await cpage.getByLabel("Other needs").fill("Readable in direct sunlight");
  // Back keeps what was typed on this step, then forward again.
  await cpage.getByRole("button", { name: "← Back" }).click();
  await cpage.getByTestId("step-physical").waitFor();
  assert.equal(await cpage.getByLabel("Max length").inputValue(), "280");
  await cpage.getByRole("button", { name: "Save and continue" }).click();
  assert.equal(await cpage.getByLabel("Other needs").inputValue(), "Readable in direct sunlight");
  await cpage.getByRole("button", { name: "Save and review" }).click();
  const review = cpage.getByTestId("wizard-review");
  await review.waitFor();
  const rows = await review.locator("tbody tr").count();
  assert.ok(rows >= 15, `${rows} requirements from the answers`);
  assert.match(await review.locator("tr[data-key=battery_life]").innerText(), /run for at least 12 hours on one charge when used 10 hours a day[\s\S]*Power: Rechargeable lithium battery, battery life[\s\S]*new/);
  assert.equal(await cpage.getByRole("button", { name: "Create and update requirements" }).count(), 0, "clients cannot apply");
  await cpage.getByText("The engineering team turns these answers into requirements.").waitFor();
  await shot(cpage, "01-client-review");

  // 2. The owner applies them.
  await page.goto(`${P}/wizard?step=6`);
  await page.getByRole("button", { name: "Create and update requirements" }).click();
  await page.getByText(new RegExp(`Wizard applied: ${rows} requirement\\(s\\) added; 0 updated; 0 unchanged`)).waitFor();
  const { data: reqs } = await api.from("requirements").select("ref_code, text, status, origin, source_section").eq("project_id", project.id).order("ref_code");
  assert.equal(reqs.length, rows);
  assert.ok(reqs.every((r) => r.origin === "wizard" && r.status === "extracted" && r.source_section.startsWith("Requirement wizard: ")));
  assert.equal(reqs.find((r) => r.ref_code === "REQ-ENV-001")?.text, "The product shall operate from -10 °C to 45 °C.");
  const { data: intake } = await api.from("project_intake").select("regions, quantity, power_source, radios, max_dimensions").eq("project_id", project.id).single();
  assert.deepEqual(intake.regions, ["US", "EU"]);
  assert.equal(intake.max_dimensions, "280 × 120 × 30 mm");
  assert.equal(intake.power_source, "Rechargeable lithium battery, 12 h per charge, USB-C charging");
  await page.goto(`${P}/compliance`);
  for (const key of ["us_fcc_15c", "eu_red", "un38_3"]) assert.equal(await page.getByTestId("suggestions").locator(`[data-key=${key}]`).count(), 1, key);
  await shot(page, "02-compliance-from-wizard");

  // 3. A changed answer updates its requirement.
  await page.goto(`${P}/wizard?step=2`);
  await page.getByLabel("Battery hours").fill("16");
  await page.getByRole("button", { name: "Save and continue" }).click();
  await page.getByTestId("step-connectivity").waitFor();
  await page.goto(`${P}/wizard?step=6`);
  const battery = await page.getByTestId("wizard-review").locator("tr[data-key=battery_life]").innerText();
  assert.match(battery, /16 hours[\s\S]*REQ-PWR-\d+, will be updated/);
  await page.getByRole("button", { name: "Create and update requirements" }).click();
  await page.getByText(new RegExp(`Wizard applied: 0 requirement\\(s\\) added; 1 updated; ${rows - 1} unchanged`)).waitFor();
  const { count } = await api.from("requirements").select("id", { count: "exact", head: true }).eq("project_id", project.id);
  assert.equal(count, rows, "no duplicates");
  await shot(page, "03-project-requirements");
  console.log(`Wizard flow passed: client answered, owner created ${rows} requirements and the intake, a changed answer updated one.`);
} catch (e) {
  if (page && process.env.FAIL_SHOT) await page.screenshot({ path: process.env.FAIL_SHOT, fullPage: true });
  throw e;
} finally {
  await browser.close();
}
