// End-to-end test of stage gates and the S0 risk register. The owner creates a project with stage gates on, fills in the
// intake, runs the feasibility check (risks cited from the requirement text), works S0's blockers off and signs it off,
// signs S1 off past its open item with a reason, then handles S2's high risks; the plan and workspace show the stages.
//
// Needs the app running and the local Supabase stack (./scripts/test-e2e-stages.sh).
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
const stamp = Date.now();
const owner = { email: `stages-${stamp}@example.test`, password: "correct-horse-battery" };

const browser = await chromium.launch();
try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1 })).newPage();
  await page.goto(`${BASE}/login`);
  await page.getByLabel("Email").fill(owner.email);
  await page.getByLabel("Password").fill(owner.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL(/\/projects$/);
  const api = createClient(URL, ANON, { auth: { persistSession: false } });
  assert.ifError((await api.auth.signInWithPassword(owner)).error);

  // 1. A new project has stage gates on by default.
  await page.getByLabel("Name").fill(`Stage slate ${stamp}`);
  assert.equal(await page.getByLabel(/Stage gates/).isChecked(), true);
  await page.getByRole("button", { name: "Create project" }).click();
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}$/);
  const projectId = page.url().split("/").pop();
  await api.from("requirements").insert([
    { project_id: projectId, ref_code: "REQ-PWR-001", kind: "power", status: "extracted", text: "The slate shall run for 10 hours on its Li-ion battery." },
    { project_id: projectId, ref_code: "REQ-IF-001", kind: "interface", status: "extracted", text: "The slate shall sync timecode with phones over Bluetooth LE." },
    { project_id: projectId, ref_code: "REQ-MEC-001", kind: "mechanical", status: "ambiguous", text: "The housing shall feel robust." },
  ]);
  console.log("✓ new project with stage gates on");

  // 2. Intake, then the feasibility check files cited risks and lists what the intake still lacks.
  await page.getByRole("link", { name: "Intake and risks" }).click();
  await page.getByRole("tab", { name: "Intake" }).click();
  const intake = page.getByTestId("intake");
  await intake.getByLabel("Intended use").fill("Timecode slate for film sets");
  await intake.getByLabel("Target markets").fill("US, EU");
  await intake.getByLabel("First production quantity").fill("500");
  await intake.getByLabel("Target unit cost").fill("120");
  await intake.getByLabel("Power source").fill("Li-ion 1S, USB-C charging");
  await intake.getByLabel("Radios").fill("Bluetooth LE");
  await page.getByRole("button", { name: "Save intake" }).click();
  await page.getByText("Intake saved.").waitFor();
  await page.getByRole("tab", { name: "Risk register" }).click();
  await page.getByRole("button", { name: "Run feasibility check" }).click();
  await page.getByText(/Feasibility check: \d+ finding\(s\)/).waitFor();
  assert.match(await page.locator(".banner").first().innerText(), /Missing from the intake: maximum dimensions, target standards/);
  const risks = page.getByTestId("risks");
  const radio = risks.locator("li", { hasText: "Radio transmitter" });
  assert.match(await radio.innerText(), /high · 4×4[\s\S]*S2[\s\S]*regulatory[\s\S]*pre-certified radio module/);
  await radio.getByText(/Based on \d passage/).click();
  assert.match(await radio.innerText(), /REQ-IF-001: “The slate shall sync timecode with phones over Bluetooth LE\.”/);
  assert.match(await risks.locator("li", { hasText: "Lithium battery" }).innerText(), /high · 3×4/);
  assert.match(await risks.locator("li", { hasText: "ambiguous requirement" }).innerText(), /medium[\s\S]*S0/);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "01-risks.png"), fullPage: true });
  console.log("✓ feasibility check: risks scored and cited from the requirement text; intake gaps listed");

  // 3. S0: unreviewed requirements block sign-off; once reviewed, it signs off.
  await page.goto(`${BASE}/projects/${projectId}/stages`);
  const s0 = page.locator("li[data-stage='S0']");
  assert.match(await s0.innerText(), /current[\s\S]*REQ-IF-001 is extracted: confirm or reject it[\s\S]*REQ-MEC-001 is ambiguous/);
  await s0.getByRole("button", { name: "Sign off S0" }).click();
  await page.locator(".banner-error").filter({ hasText: "S0 cannot be signed off yet" }).waitFor();
  await api.from("requirements").update({ status: "confirmed" }).eq("project_id", projectId);
  await page.goto(`${BASE}/projects/${projectId}/stages`);
  assert.equal(await page.getByTestId("blockers-S0").innerText(), "Nothing open: ready to sign off.");
  await s0.getByLabel("Sign-off note for S0").fill("Intake reviewed.");
  await s0.getByRole("button", { name: "Sign off S0" }).click();
  await page.getByText("S0 signed off.").waitFor();
  console.log("✓ S0 held by unreviewed requirements, then signed off");

  // 4. S1 without a design freeze: the owner signs off past it, with a reason that is kept.
  const s1 = page.locator("li[data-stage='S1']");
  assert.match(await page.getByTestId("blockers-S1").innerText(), /no design freeze recorded/);
  await s1.getByLabel("Sign off S1 past open items").check();
  await s1.getByLabel("Sign-off note for S1").fill("Internal tool: no industrial design.");
  await s1.getByRole("button", { name: "Sign off S1" }).click();
  await page.getByText("S1 signed off.").waitFor();
  assert.match(await page.locator("li[data-stage='S1'] [data-testid='waived']").innerText(), /Signed off past:[\s\S]*no design freeze recorded/);
  console.log("✓ S1 signed off past its open item; the waiver is recorded");

  // 5. S2 is held by its two high risks: rescore one with its mitigation, accept the other as owner.
  const { data: planId } = await api.rpc("create_plan_version", { p_project_id: projectId, p_payload: { summary: "Slate", tasks: [
    { key: "arch", title: "Architecture", discipline: "architecture" },
    { key: "sch", title: "Schematic", discipline: "schematic", upstream_keys: ["arch"] }] } });
  await page.goto(`${BASE}/projects/${projectId}/plans/${planId}`);
  assert.match(await page.locator("li.task").nth(0).innerText(), /S2[\s\S]*architecture/);
  assert.match(await page.locator("li.task").nth(1).innerText(), /S3[\s\S]*schematic/);
  await page.goto(`${BASE}/projects/${projectId}/stages`);
  assert.match(await page.getByTestId("blockers-S2").innerText(), /no approved plan[\s\S]*RISK-\d+ \(high\) is unresolved: Lithium battery[\s\S]*Radio transmitter/);
  await page.goto(`${BASE}/projects/${projectId}/risks`);
  const radioRisk = page.getByTestId("risks").locator("li", { hasText: "Radio transmitter" });
  await radioRisk.locator("summary", { hasText: "Update" }).click();
  await radioRisk.locator("select[name=likelihood]").selectOption("2");
  await radioRisk.locator("select[name=status]").selectOption("mitigating");
  await radioRisk.locator("input[name=mitigation]").fill("Pre-certified BLE module with its reference antenna.");
  await radioRisk.getByRole("button", { name: "Update risk" }).click();
  await page.getByText("Risk updated.").waitFor();
  assert.match(await page.getByTestId("risks").locator("li", { hasText: "Radio transmitter" }).innerText(), /medium · 2×4[\s\S]*mitigating/);
  const li = page.getByTestId("risks").locator("li", { hasText: "Lithium battery" });
  await li.locator("summary", { hasText: "Update" }).click();
  await li.locator("select[name=status]").selectOption("accepted");
  await li.getByRole("button", { name: "Update risk" }).click();
  await page.locator(".banner-error").filter({ hasText: "say why the risk is accepted" }).waitFor();
  await page.getByTestId("risks").locator("li", { hasText: "Lithium battery" }).locator("summary", { hasText: "Update" }).click();
  const li2 = page.getByTestId("risks").locator("li", { hasText: "Lithium battery" });
  await li2.locator("select[name=status]").selectOption("accepted");
  await li2.locator("input[name=note]").fill("Using a pack with UN 38.3 and IEC 62133-2 reports.");
  await li2.getByRole("button", { name: "Update risk" }).click();
  await page.getByText("Risk updated.").waitFor();
  await page.goto(`${BASE}/projects/${projectId}/stages`);
  assert.equal((await page.getByTestId("blockers-S2").innerText()).trim(), "Before sign-off:\nno approved plan");
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "02-stages.png"), fullPage: true });
  console.log("✓ S2's high risks handled (rescored with a mitigation; accepted by the owner with a reason)");

  // 6. The workspace shows the current stage.
  await page.goto(`${BASE}/projects/${projectId}/workspace`);
  assert.match(await page.getByTestId("stage-step").innerText(), /Stage S2: System architecture\n2 of 9 stages signed off · 1 item\(s\) before sign-off/);
  console.log("✓ the workspace checklist shows the current stage");
  console.log("\nStage gate end-to-end flow passed.");
} catch (e) {
  console.error("\n✗ Stage gate end-to-end flow failed:", e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
