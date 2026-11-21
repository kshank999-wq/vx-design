// End-to-end test of the G1 flow: sign up -> project -> upload spec -> extract requirements
// -> review -> generate plan -> edit -> submit -> approve -> revise, plus access control.
//
// Needs the app running (BASE_URL, default http://localhost:3000) against a Supabase
// instance with email confirmation off (local `supabase start`), and VX_LLM=offline
// unless you intend to spend real model calls.
//
//   node apps/web/e2e/g1-flow.mjs
//   SCREENSHOTS=./g1-shots node apps/web/e2e/g1-flow.mjs
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Resolved with require so a globally installed Playwright works via NODE_PATH.
const { chromium } = createRequire(import.meta.url)("playwright");

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const SHOTS = process.env.SCREENSHOTS;
const here = dirname(fileURLToPath(import.meta.url));
const SPEC = join(here, "../../../tests/fixtures/specs/sample-timecode-board.md");
const run = Date.now();
const owner = { email: `owner-${run}@example.test`, password: "correct-horse-battery" };
const outsider = { email: `outsider-${run}@example.test`, password: "correct-horse-battery" };

if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const browser = await chromium.launch();
let step = 0;

async function newPage() {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1 });
  return context.newPage();
}
async function shot(page, name) {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${String(++step).padStart(2, "0")}-${name}.png`), fullPage: true });
}
async function expectNoError(page) {
  // Next.js's route announcer also has role="alert"; match the app's banner.
  const alert = page.locator(".banner-error");
  if (await alert.count()) throw new Error(`Unexpected error banner: ${await alert.first().innerText()}`);
}
/** Every task must appear after all the tasks it depends on. */
async function assertDependencyOrder(page) {
  const rows = await page.locator("li.task").evaluateAll((cards) => cards.map((c) => {
    const key = c.querySelector("h3 .mono").textContent.replace(/^\d+\.\s*/, "").trim();
    const dt = [...c.querySelectorAll("dt")].find((d) => d.textContent === "After");
    const after = dt.nextElementSibling.textContent.trim();
    return { key, after: after === "start" ? [] : after.split(",").map((x) => x.trim()) };
  }));
  const seen = new Set();
  for (const r of rows) {
    for (const up of r.after) assert.ok(seen.has(up), `task ${r.key} is listed before its dependency ${up}`);
    seen.add(r.key);
  }
}

async function signUp(page, user) {
  await page.goto(`${BASE}/projects`);
  assert.match(page.url(), /\/login$/, "signed-out users are redirected to /login");
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL(/\/projects$/);
}

try {
  const page = await newPage();
  await signUp(page, owner);
  console.log("✓ sign up and redirect");

  await page.getByLabel("Name").fill("Timecode board (e2e)");
  await page.getByLabel(/Stage gates/).uncheck();  // this flow tests runs without stage sign-offs
  await page.getByRole("button", { name: "Create project" }).click();
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}$/);
  const projectUrl = page.url();
  console.log("✓ project created");

  await page.getByTestId("project-tabs").getByRole("link", { name: /^Documents/ }).click();
  await page.waitForURL(/tab=documents/);
  await page.getByLabel("Specification file").setInputFiles(SPEC);
  await page.getByRole("button", { name: "Upload" }).click();
  await page.getByText(/Uploaded sample-timecode-board\.md: \d+ sections/).waitFor();
  await expectNoError(page);
  console.log("✓ spec uploaded and parsed");

  // Uploading the same file twice is refused.
  await page.getByLabel("Specification file").setInputFiles(SPEC);
  await page.getByRole("button", { name: "Upload" }).click();
  await page.locator(".banner-error").filter({ hasText: "already uploaded" }).waitFor();
  console.log("✓ duplicate upload refused");

  await page.getByRole("button", { name: "Extract requirements" }).click();
  await page.getByText(/\d+ requirements · /).first().waitFor();
  await page.goto(`${projectUrl}?tab=requirements`);
  await page.locator("table.reqs tbody tr").first().waitFor();
  await page.waitForLoadState("networkidle");
  await expectNoError(page);
  const reqRows = page.locator("table.reqs tbody tr");
  const reqCount = await reqRows.count();
  assert.ok(reqCount >= 10, `expected >= 10 requirements, got ${reqCount}`);
  const firstRow = reqRows.first();
  assert.match(await firstRow.locator("td").first().innerText(), /^REQ-[A-Z]{3}-\d{3}/);
  await firstRow.locator("summary").click();
  assert.ok((await firstRow.locator("blockquote").innerText()).length > 10, "citation excerpt shown");
  await shot(page, "requirements");
  console.log(`✓ ${reqCount} requirements extracted with citations`);

  // Reject the last requirement; it must not be required by the plan.
  const lastRow = reqRows.last();
  const rejectedRef = (await lastRow.locator("td").first().innerText()).split("\n")[0];
  await lastRow.getByRole("button", { name: "Reject" }).click();
  await page.locator("tr.rejected").first().waitFor();
  console.log(`✓ rejected ${rejectedRef}`);

  await page.goto(`${projectUrl}?tab=plans`);
  await page.getByRole("button", { name: "Generate plan from requirements" }).click();
  await page.waitForURL(/\/plans\/[0-9a-f-]{36}/);
  await expectNoError(page);
  const planUrl = page.url().split("?")[0];
  await page.getByText("Generated by the offline heuristic, not by AI").waitFor();
  const taskCards = page.locator("li.task");
  assert.equal(await taskCards.count(), 6);
  assert.equal(await page.locator(".banner-error").count(), 0, "every requirement covered");
  const chips = await page.locator(".chip").allInnerTexts();
  assert.ok(!chips.includes(rejectedRef), "rejected requirement not linked to tasks");
  assert.equal(await taskCards.first().locator(".pill-gate").count(), 1, "architecture task is an approval gate");
  await assertDependencyOrder(page);
  await shot(page, "plan-draft");
  console.log("✓ draft plan v1 generated: 6 tasks, all requirements covered");

  // Edit a task while in draft.
  const schematic = taskCards.filter({ hasText: "schematic Schematic capture" });
  assert.equal(await schematic.count(), 1);
  await schematic.locator("summary", { hasText: "Edit task" }).click();
  await schematic.getByLabel("Title").fill("Schematic capture and ERC");
  await schematic.getByRole("button", { name: "Save task" }).click();
  await page.getByText('Saved "Schematic capture and ERC".').waitFor();
  console.log("✓ task edited in draft");

  await page.getByRole("button", { name: "Submit for approval" }).click();
  await page.locator(".pill-awaiting_approval").first().waitFor();
  assert.equal(await page.getByText("Edit task").count(), 0, "editing locked after submit");
  console.log("✓ submitted; edits locked");

  // Returning requires a note.
  await page.getByRole("button", { name: "Return to draft" }).click();
  await page.locator(".banner-error").filter({ hasText: "Say what needs to change" }).waitFor();
  await page.getByLabel("Review note").fill("Baseline for first board spin");
  await page.getByRole("button", { name: "Approve as baseline" }).click();
  await page.getByText("Plan approved: it is now the project baseline.").waitFor();
  assert.equal(await page.locator("li.task .pill-ready").count(), 6, "all tasks ready");
  await assertDependencyOrder(page);
  await shot(page, "plan-approved");
  console.log("✓ approved: baseline frozen, 6 tasks ready");

  await page.getByRole("button", { name: "Revise as new draft" }).click();
  await page.waitForURL((u) => u.pathname.includes("/plans/") && !u.href.startsWith(planUrl));
  await page.getByRole("heading", { name: "Plan v2" }).waitFor();
  assert.equal(await page.locator("li.task").count(), 6);
  assert.ok(await page.getByText("Schematic capture and ERC").count(), "revision keeps the edited task");
  await assertDependencyOrder(page);
  console.log("✓ revision v2 created as draft with the same tasks");

  await page.goto(projectUrl);
  await shot(page, "project-overview");

  // A different user cannot see the project.
  const other = await newPage();
  await signUp(other, outsider);
  assert.equal(await other.getByText("Timecode board (e2e)").count(), 0, "outsider does not see the project");
  const resp = await other.goto(projectUrl);
  assert.equal(resp.status(), 404, "outsider gets 404 for the project URL");
  console.log("✓ other users cannot see the project");

  console.log("\nG1 end-to-end flow passed.");
} catch (e) {
  console.error("\n✗ G1 end-to-end flow failed:", e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
