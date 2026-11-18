// End-to-end test of build-and-validation evidence (S6). The owner registers two units built from the approved fab
// package, drafts procedures from the requirements (limits read from the requirement text), reviews and approves them
// (one by the reviewer); records a passing test with conditions, equipment and a scope capture, and a failing one on
// the second unit, which opens a fault; the fault is corrected by rework and verified by a retest that supersedes the
// failing run. The verification matrix and the client's workspace follow along; results cannot be edited.
//
// Needs the app running and the local Supabase stack (./scripts/test-e2e-validation.sh).
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });
const stamp = Date.now();
const pw = "correct-horse-battery";
const owner = { email: `val-owner-${stamp}@example.test`, password: pw };
const reviewer = { email: `val-reviewer-${stamp}@example.test`, password: pw };
const client = { email: `val-client-${stamp}@example.test`, password: pw };
// A tiny valid PNG standing in for a scope capture.
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000" + "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082", "hex");
const scope = join(mkdtempSync(join(tmpdir(), "vx-val-")), "scope-3v3.png");
writeFileSync(scope, PNG);

async function signUp(browser, who) {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1 })).newPage();
  await page.goto(`${BASE}/login`);
  await page.getByLabel("Email").fill(who.email);
  await page.getByLabel("Password").fill(who.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL(/\/projects$/);
  const api = createClient(URL, ANON, { auth: { persistSession: false } });
  assert.ifError((await api.auth.signInWithPassword(who)).error);
  return { page, api };
}
const matrixStatus = async (page, ref) => (await page.getByTestId("matrix").locator(`tr[data-ref='${ref}']`).innerText());

const browser = await chromium.launch();
try {
  const o = await signUp(browser, owner);
  const r = await signUp(browser, reviewer);
  const c = await signUp(browser, client);
  const { data: project } = await o.api.from("projects").insert({ name: `Slate validation ${stamp}` }).select("id").single();
  for (const [who, role] of [[reviewer, "reviewer"], [client, "client"]]) {
    assert.equal((await o.api.rpc("invite_member", { p_project_id: project.id, p_email: who.email, p_role: role })).data, "added");
  }
  await o.api.from("requirements").insert([
    { project_id: project.id, ref_code: "REQ-PWR-001", kind: "power", priority: "must", status: "confirmed", text: "The 3.3 V rail shall stay between 3.2 V and 3.4 V." },
    { project_id: project.id, ref_code: "REQ-PWR-002", kind: "power", priority: "must", status: "confirmed", text: "Standby current shall be at most 50 uA." },
    { project_id: project.id, ref_code: "REQ-IF-001", kind: "interface", priority: "must", status: "confirmed", text: "The board shall decode LTC at 30 fps.",
      acceptance_criteria: "Decode a reference LTC source for 10 minutes without dropped frames." },
  ]);
  const fab = new TextEncoder().encode(`fab package ${stamp}`);
  const fabPath = `${project.id}/artifacts/fab-${stamp}.zip`;
  await admin.storage.from("project-files").upload(fabPath, fab, { contentType: "application/zip" });
  const { data: art } = await admin.from("artifacts").insert({ project_id: project.id, kind: "fab_package", name: "timecode/fab-package" }).select("id").single();
  await admin.from("artifact_versions").insert({ artifact_id: art.id, project_id: project.id, version: 1, status: "committed", storage_path: fabPath,
    sha256: createHash("sha256").update(fab).digest("hex"), size_bytes: fab.length, tool_name: "e2e" });

  // 1. Units built from the approved fab package.
  const page = o.page;
  await page.goto(`${BASE}/projects/${project.id}`);
  await page.getByRole("link", { name: "Validation" }).click();
  for (const sn of ["SN-001", "SN-002"]) {
    await page.locator("summary", { hasText: "Register a unit" }).click();
    await page.getByLabel("Serial").fill(sn);
    await page.getByLabel("Board revision").fill("A");
    await page.getByLabel("Built from").selectOption({ label: "timecode/fab-package v1" });
    await page.getByLabel("Assembled by").fill("Fab Example");
    await page.getByRole("button", { name: "Register unit" }).click();
    await page.getByText(`Unit ${sn} registered.`).waitFor();
  }
  assert.match(await page.getByTestId("units").innerText(), /SN-001\s+A\s+timecode\/fab-package v1/);
  console.log("✓ two units registered, traced to the fab package they were built from");

  // 2. Draft procedures from the requirements; limits are read from the text, with their source.
  await page.getByRole("button", { name: "Draft from requirements" }).click();
  await page.getByText(/3 draft procedure\(s\) written from the requirements/).waitFor();
  const procs = page.getByTestId("procedures");
  await procs.locator("tr", { hasText: "REQ-PWR-001" }).getByRole("link").click();
  const defs = page.getByTestId("measurement-defs");
  assert.equal(await defs.getByLabel("Min 1").inputValue(), "3.2");
  assert.equal(await defs.getByLabel("Max 1").inputValue(), "3.4");
  assert.match(await defs.getByLabel("Basis 1").inputValue(), /read from REQ-PWR-001: "between 3.2 V and 3.4 V"/);
  await defs.getByLabel("Key 2").fill("input_ma");
  await defs.getByLabel("Label 2").fill("Input current");
  await defs.getByLabel("Unit 2").fill("mA");
  await page.getByLabel("Setup (equipment, fixtures, firmware)").fill("Bench supply 5.0 V; DMM on TP1");
  await page.getByRole("button", { name: "Save draft" }).click();
  await page.getByText("Saved.").waitFor();
  await page.getByRole("button", { name: "Approve procedure" }).click();
  await page.getByTestId("procedure-status").filter({ hasText: /^approved$/ }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Save draft" }).count(), 0, "approved versions are frozen");
  const tp1 = page.url().split("?")[0];
  // The reviewer approves the LTC procedure (a yes/no check: no number in the requirement).
  await r.page.goto(`${BASE}/projects/${project.id}/validation`);
  await r.page.getByTestId("procedures").locator("tr", { hasText: "REQ-IF-001" }).getByRole("link").click();
  assert.match(await r.page.getByTestId("measurement-defs").innerText(), /REQ-IF-001 met\s+boolean[\s\S]*yes/);
  await r.page.getByRole("button", { name: "Approve procedure" }).click();
  await r.page.getByTestId("procedure-status").filter({ hasText: /^approved$/ }).waitFor();
  console.log("✓ procedures drafted from requirement text (limits cited), reviewed, approved; approved versions frozen");

  // 3. A passing run with conditions, equipment and a scope capture.
  await page.goto(tp1);
  await page.getByRole("link", { name: "Record a test" }).click();
  const form = page.getByTestId("record-form");
  await form.getByLabel("Unit").selectOption({ label: "SN-001 (rev A, built)" });
  await form.getByLabel("Temperature (°C)").fill("23");
  await form.getByLabel("Firmware version").fill("0.3.1");
  await form.getByLabel(/^Equipment/).fill("DMM, DMM-7, 2027-03-01");
  await form.getByLabel(/REQ-PWR-001: between/).fill("3.31");
  await form.getByLabel("Pasted values").fill("input_ma,82");
  await form.getByRole("button", { name: "Record result" }).click();
  await page.getByTestId("run-verdict").filter({ hasText: /^pass$/ }).waitFor();
  assert.match(await page.getByTestId("measurements").innerText(), /REQ-PWR-001: between 3\.2 V and 3\.4 V\s+3\.31 V\s+3\.2 – 3\.4 V\s+REQ-PWR-001\s+pass[\s\S]*Input current\s+82 mA\s+recorded only[\s\S]*info/);
  assert.match(await page.locator("dl.facts").innerText(), /23 °C · firmware 0\.3\.1[\s\S]*DMM \(DMM-7\), calibrated until 2027-03-01/);
  await page.getByLabel("Evidence files").setInputFiles(scope);
  await page.getByRole("button", { name: "Attach evidence" }).click();
  await page.getByTestId("evidence").getByText("scope-3v3.png").waitFor();
  console.log("✓ passing run: verdict computed from the approved limits; conditions, equipment calibration and scope capture recorded");

  // 4. A failing run opens a fault; the matrix shows it.
  await page.goto(`${tp1.replace(/procedures\/.*/, "record")}?procedure=${tp1.split("/").pop()}`);
  await form.getByLabel("Unit").selectOption({ label: "SN-002 (rev A, built)" });
  await form.getByLabel(/REQ-PWR-001: between/).fill("3.05");
  await form.getByRole("button", { name: "Record result" }).click();
  await page.getByTestId("run-verdict").filter({ hasText: /^fail$/ }).waitFor();
  assert.match(await page.locator("main").innerText(), /Fault opened: F-001 \(open\)/);
  const failRun = page.url().split("?")[0];
  await page.goto(`${BASE}/projects/${project.id}/validation`);
  assert.match(await matrixStatus(page, "REQ-PWR-001"), /TP-\d+\s+1 \/ 1 \/ 0\s+failing/);
  assert.match(await matrixStatus(page, "REQ-PWR-002"), /no procedure|not tested/);
  console.log("✓ failing run on SN-002: fault F-001 opened, requirement shown as failing");

  // 5. Rework, retest (a correction that supersedes the failing run), fault verified.
  const faults = page.getByTestId("faults");
  await faults.locator("summary", { hasText: "Update" }).click();
  await faults.getByLabel("Root cause of F-1").fill("R5 fitted as 10k instead of 1k");
  await faults.getByLabel("Correction for F-1").fill("Replaced R5 with 1k");
  await faults.getByRole("button", { name: "Update fault" }).click();
  await page.getByText("Fault updated.").waitFor();
  await page.goto(failRun);
  await page.getByRole("link", { name: "Record a correction or retest of this run" }).click();
  await form.getByLabel(/REQ-PWR-001: between/).fill("3.29");
  await form.getByLabel("Pasted values").fill("input_ma,80");
  await form.getByLabel(/^Notes/).fill("Retest after replacing R5");
  await form.getByRole("button", { name: "Record result" }).click();
  await page.getByTestId("run-verdict").filter({ hasText: /^pass$/ }).waitFor();
  assert.match(await page.locator("main").innerText(), /Corrects an earlier run: Retest after replacing R5/);
  await page.goto(failRun);
  assert.match(await page.locator("main").innerText(), /Superseded by run 3/);
  await page.goto(`${BASE}/projects/${project.id}/validation`);
  await faults.locator("summary", { hasText: "Update" }).click();
  await faults.getByLabel("Status of F-1").selectOption("verified");
  const verifying = faults.getByLabel("Verifying run for F-1");
  await verifying.selectOption(await verifying.locator("option", { hasText: "run 3: SN-002" }).getAttribute("value"));
  await faults.getByRole("button", { name: "Update fault" }).click();
  await page.getByText("Fault updated.").waitFor();
  assert.match(await faults.innerText(), /verified\s+F-001[\s\S]*Cause: R5 fitted as 10k instead of 1k[\s\S]*Correction \(rework\): Replaced R5 with 1k/);
  assert.match(await matrixStatus(page, "REQ-PWR-001"), /2 \/ 0 \/ 0\s+verified by test/);
  assert.match(await page.getByTestId("units").innerText(), /SN-002[\s\S]*reworked/);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "01-validation.png"), fullPage: true });
  console.log("✓ fault corrected by rework and verified by a superseding retest; requirement verified on both units");

  // 6. Clients read the evidence and see the workspace step; nobody can edit results.
  await c.page.goto(`${BASE}/projects/${project.id}/workspace`);
  assert.match(await c.page.getByTestId("validation-step").innerText(), /Build and validation\n1 of 3 requirement\(s\) verified by test/);
  await c.page.goto(`${BASE}/projects/${project.id}/validation`);
  assert.equal(await c.page.locator("summary", { hasText: "Register a unit" }).count(), 0);
  assert.match(await c.page.getByTestId("matrix").innerText(), /REQ-PWR-001[\s\S]*verified by test/);
  assert.match((await c.api.rpc("create_unit", { p_project_id: project.id, p_serial: "SN-X", p_revision: "A" })).error?.message ?? "", /only owner, engineer/);
  const { data: run1 } = await admin.from("test_runs").select("id").eq("project_id", project.id).eq("run_no", 1).single();
  assert.match((await admin.from("test_runs").update({ verdict: "fail" }).eq("id", run1.id)).error?.message ?? "", /immutable/, "not even the service role can edit a result");
  const { data: ev } = await admin.from("audit_events").select("event_type").eq("project_id", project.id).order("id");
  const types = ev.map((e) => e.event_type);
  for (const t of ["unit.registered", "procedure.approved", "test.recorded", "test.evidence_added", "fault.corrected", "fault.verified"]) assert.ok(types.includes(t), t);
  console.log("✓ client sees the evidence and the workspace step; results immutable; every step audited");
  console.log("\nValidation end-to-end flow passed.");
} catch (e) {
  console.error("\n✗ Validation end-to-end flow failed:", e.message);
  for (const ctx of browser.contexts()) for (const p of ctx.pages()) {
    const alert = await p.getByRole("alert").allInnerTexts().catch(() => []);
    if (alert.length) console.error(`  ${p.url()}: ${alert.join(" | ")}`);
  }
  process.exitCode = 1;
} finally {
  await browser.close();
}
