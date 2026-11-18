// End-to-end test of per-account quotas as a user meets them: the account page shows the plan and this month's use;
// a plan limit (here, one project) stops the next project with a plain explanation, and the page shows the limit reached.
//
// Needs the app running and the local Supabase stack (./scripts/test-e2e-quotas.sh).
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
const { SUPABASE_URL: URL, SUPABASE_SERVICE_ROLE_KEY: SERVICE } = process.env;
if (!URL || !SERVICE) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
const SHOTS = process.env.SCREENSHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });
const stamp = Date.now();
const who = { email: `quota-${stamp}@example.test`, password: "correct-horse-battery" };
const planId = `e2e_one_${stamp}`;

const browser = await chromium.launch();
try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1 })).newPage();
  await page.goto(`${BASE}/login`);
  await page.getByLabel("Email").fill(who.email);
  await page.getByLabel("Password").fill(who.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL(/\/projects$/);

  // 1. New accounts are on the standard plan, with nothing used yet.
  await page.getByRole("link", { name: "Account" }).click();
  await page.getByTestId("plan").filter({ hasText: "Standard plan." }).waitFor();
  assert.match(await page.getByTestId("usage-projects").innerText(), /Projects\s+0 of 25/);
  assert.match(await page.getByTestId("usage-ai").innerText(), /AI spend\s+\$0\.00 of \$200\.00/);
  console.log("✓ new account: standard plan, nothing used");

  // 2. Staff move the account to a one-project plan.
  const { data: users } = await admin.auth.admin.listUsers({ perPage: 1000 });
  const userId = users.users.find((u) => u.email === who.email).id;
  assert.ifError((await admin.from("account_plans").insert({ id: planId, name: "One project", description: "Test plan.",
    max_projects: 1, max_active_runs: 1, max_concurrent_tasks: 1, monthly_ai_usd: 5, monthly_compute_usd: 5, monthly_concept_rounds: 2 })).error);
  assert.ifError((await admin.rpc("set_account_plan", { p_user: userId, p_plan: planId })).error);

  // 3. The first project is fine; the second is refused with the reason.
  await page.goto(`${BASE}/projects`);
  await page.getByLabel("Name").fill(`Quota one ${stamp}`);
  await page.getByRole("button", { name: "Create project" }).click();
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}/);
  await page.goto(`${BASE}/projects`);
  await page.getByLabel("Name").fill(`Quota two ${stamp}`);
  await page.getByRole("button", { name: "Create project" }).click();
  await page.locator(".banner-error").filter({ hasText: "Plan limit: the One project plan allows 1 projects per account" }).waitFor();
  console.log("✓ the plan's project limit refuses the next project and says why");

  // 4. The account page shows the limit reached.
  await page.goto(`${BASE}/account`);
  assert.match(await page.getByTestId("usage-projects").innerText(), /Projects\s+1 of 1/);
  assert.equal(await page.getByRole("progressbar", { name: "Projects" }).getAttribute("aria-valuenow"), "100");
  assert.match(await page.getByTestId("usage-tasks").innerText(), /Tasks running at once\s+0 of 1/);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "01-account.png"), fullPage: true });
  console.log("✓ the account page shows the plan, limits and use");

  // 5. Staff lift the limit by changing the plan; the user can carry on at once.
  assert.ifError((await admin.rpc("set_account_plan", { p_user: userId, p_plan: "unlimited" })).error);
  await page.goto(`${BASE}/projects`);
  await page.getByLabel("Name").fill(`Quota two ${stamp}`);
  await page.getByRole("button", { name: "Create project" }).click();
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}/);
  console.log("✓ a plan change applies immediately");
  console.log("\nQuota end-to-end flow passed.");
} catch (e) {
  console.error("\n✗ Quota end-to-end flow failed:", e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
  await admin.from("accounts").delete().eq("plan_id", planId);
  await admin.from("account_plans").delete().eq("id", planId);
}
