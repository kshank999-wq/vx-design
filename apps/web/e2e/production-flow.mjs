// End-to-end test of S7 compliance and production tracking.
//  - Release: the owner prepares Rev A from the committed fab package and BOM, checks readiness and issues it; the
//    file list and checksums are frozen.
//  - Compliance: items are added from the intake suggestions (US + EU, Bluetooth LE, Li-ion); an FCC result is
//    recorded with the lab's report against Rev A; the battery transport item is marked not applicable with a reason.
//  - Production: a pilot lot from Rev A with a production test; units registered by serial range; one unit fails its
//    first test; a final inspection meets the sampling plan; acceptance is refused until the unit passes a retest.
//  - Traceability: a serial number traces back to its lot, revision, files and tests. A later Rev B marks the FCC
//    result as tested on an older revision.
//
// Needs the app running and the local Supabase stack (./scripts/test-e2e-production.sh).
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
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
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true }); };
const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });
const stamp = Date.now();
const owner = { email: `production-${stamp}@example.test`, password: "correct-horse-battery" };

async function commit(projectId, kind, name, version, text) {
  const bytes = Buffer.from(text);
  const path = `${projectId}/artifacts/${stamp}-${name.replace(/\//g, "-")}-v${version}`;
  assert.ifError((await admin.storage.from("project-files").upload(path, bytes)).error);
  let { data: art } = await admin.from("artifacts").select("id").eq("project_id", projectId).eq("name", name).maybeSingle();
  if (!art) art = (await admin.from("artifacts").insert({ project_id: projectId, kind, name }).select("id").single()).data;
  assert.ifError((await admin.from("artifact_versions").insert({ artifact_id: art.id, project_id: projectId, version, status: "committed",
    storage_path: path, sha256: createHash("sha256").update(bytes).digest("hex"), size_bytes: bytes.length, tool_name: "e2e", committed_at: new Date().toISOString() })).error);
}

const browser = await chromium.launch();
try {
  const page = await (await browser.newContext({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1 })).newPage();
  await page.goto(`${BASE}/login`);
  await page.getByLabel("Email").fill(owner.email);
  await page.getByLabel("Password").fill(owner.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL(/\/projects$/);
  const api = createClient(URL, ANON, { auth: { persistSession: false } });
  assert.ifError((await api.auth.signInWithPassword(owner)).error);
  const { data: project } = await api.from("projects").insert({ name: `Slate ${stamp}` }).select("id").single();
  const P = `${BASE}/projects/${project.id}`;
  assert.ifError((await api.rpc("save_intake", { p_project: project.id, p_intake: { intended_use: "Timecode slate for film sets",
    regions: ["US", "EU"], radios: ["Bluetooth LE"], power_source: "Li-ion 1S 2000 mAh, USB-C charging", quantity: "50" } })).error);
  await commit(project.id, "fab_package", "board/fab-package", 1, "gerbers v1");
  await commit(project.id, "bom", "board/bom", 1, "R1,10k");
  await commit(project.id, "specification", "spec", 1, "not a release file");
  // The production (jig) test: an approved procedure.
  const { data: tp, error: tpErr } = await api.rpc("save_procedure", { p_project_id: project.id, p_id: null, p_title: "Production jig test", p_stage: "functional",
    p_requirement_refs: [], p_setup: "Jig rev 1, 5 V bench supply", p_steps: "Clamp the board, power it, read +3V3",
    p_measurements: [{ key: "v3v3", label: "+3V3", kind: "numeric", unit: "V", min: 3.2, max: 3.4 }] });
  assert.ifError(tpErr);
  assert.ifError((await api.rpc("approve_procedure", { p_id: tp })).error);

  // 1. Release Rev A.
  await page.goto(`${P}/releases`);
  assert.equal(await page.getByLabel("board/fab-package v1").isChecked(), true);
  assert.equal(await page.getByLabel("board/bom v1").isChecked(), true);
  assert.equal(await page.getByLabel("Revision").inputValue(), "A");
  await page.getByRole("button", { name: "Make draft" }).click();
  await page.getByText("Draft release made").waitFor();
  assert.equal(await page.getByTestId("release-status").innerText(), "draft");
  assert.equal(await page.getByTestId("readiness").locator("[data-severity=block]").count(), 0);
  await shot(page, "01-release-draft");
  await page.getByRole("button", { name: "Issue Rev A" }).click();
  await page.getByText("Released: the files and their checksums are locked").waitFor();
  assert.equal(await page.getByTestId("release-status").innerText(), "released");
  assert.equal(await page.getByTestId("manifest").locator("tbody tr").count(), 2);
  assert.match(await page.getByTestId("manifest-sha").innerText(), /^[0-9a-f]{64}$/);
  await shot(page, "02-release-issued");

  // 2. Compliance from the intake suggestions.
  await page.goto(`${P}/compliance`);
  const sug = page.getByTestId("suggestions");
  for (const key of ["us_fcc_15b", "us_fcc_15c", "eu_red", "eu_rohs", "un38_3"]) assert.equal(await sug.locator(`[data-key=${key}]`).count(), 1, key);
  assert.equal(await sug.locator("[data-key=eu_emc]").count(), 0, "radio equipment uses RED, not the EMC directive");
  await shot(page, "03-compliance-suggestions");
  await page.getByRole("button", { name: /^Add all \d+$/ }).click();
  await page.getByText(/items added/).waitFor();
  const items = page.getByTestId("items");
  const fcc = items.locator("li[data-item]", { hasText: "FCC Part 15 Subpart B" });
  const code = await fcc.getAttribute("data-item");
  await fcc.locator("summary", { hasText: "Record a lab result" }).click();
  const form = page.getByTestId(`result-form-${code}`);
  await form.getByLabel("Outcome").selectOption("pass");
  await form.getByLabel("Lab name").fill("Example EMC Lab");
  await form.getByLabel("Lab report number").fill("EMC-2026-0412");
  await form.getByLabel("Certificate reference").fill("SDoC-SLATE-A");
  const pdf = join(tmpdir(), `fcc-report-${stamp}.pdf`);
  writeFileSync(pdf, "%PDF-1.4\n1 0 obj <<>> endobj\ntrailer <<>>\n%%EOF\n");
  await form.getByLabel("Lab report", { exact: true }).setInputFiles(pdf);
  await form.locator("[data-staged=yes]").waitFor();
  await form.getByRole("button", { name: "Record result" }).click();
  await page.getByText("Lab result recorded (pass)").waitFor();
  assert.equal(await items.locator(`li[data-item=${code}]`).getAttribute("data-status"), "passed");
  assert.match(await items.locator(`li[data-item=${code}]`).getByTestId("latest-result").innerText(), /Passed at Example EMC Lab \(report EMC-2026-0412\).*testing Rev A/s);
  const battery = items.locator("li[data-item]", { hasText: "UN 38.3" });
  const bcode = await battery.getAttribute("data-item");
  await battery.locator("summary", { hasText: "Not applicable" }).click();
  await page.getByLabel(`Why ${bcode} does not apply`).fill("Cells ship pre-packed by a supplier with their own UN 38.3 summary.");
  await page.getByRole("button", { name: "Mark not applicable" }).click();
  await page.getByText("Marked not applicable").waitFor();
  assert.equal(await items.locator(`li[data-item=${bcode}]`).getAttribute("data-status"), "not_applicable");
  await shot(page, "04-compliance-items");

  // 3. A pilot lot from Rev A.
  await page.goto(`${P}/production`);
  await page.getByLabel("Quantity").fill("3");
  await page.getByLabel("Sample size").fill("3");
  await page.getByLabel("Production test procedure").selectOption({ label: "TP-001 v1 Production jig test" });
  await page.getByLabel("Assembler name").fill("Example Assembly Co");
  await page.getByRole("button", { name: "Plan lot" }).click();
  await page.getByText("Lot planned").waitFor();
  await page.getByLabel("Serial prefix").fill("SLATE-A-");
  await page.getByRole("button", { name: "Register units" }).click();
  await page.getByText("3 unit(s) registered.", { exact: true }).waitFor();
  assert.equal(await page.getByTestId("lot-status").innerText(), "in build");
  const lotUrl = page.url().split("?")[0];
  const { data: units } = await api.from("units").select("id, serial").eq("project_id", project.id).order("serial");
  assert.deepEqual(units.map((u) => u.serial), ["SLATE-A-0001", "SLATE-A-0002", "SLATE-A-0003"]);
  const runTest = async (unit, v, hoursAgo) => {
    const { data, error } = await api.rpc("record_test_run", { p_unit_id: unit.id, p_procedure_id: tp,
      p_performed_at: new Date(Date.now() - hoursAgo * 3600e3).toISOString(), p_conditions: { equipment: [{ name: "Jig", id: "JIG-1", calibrated_until: null }] },
      p_values: { v3v3: v }, p_notes: null, p_supersedes: null });
    assert.ifError(error);
    return data;
  };
  await runTest(units[0], 3.30, 3); await runTest(units[1], 3.31, 3); await runTest(units[2], 3.62, 3);
  await page.goto(lotUrl);
  assert.match(await page.getByTestId("lot-summary").innerText(), /3 tested, 2 passing, 1 failing; first-pass yield 67%/);
  await page.locator("summary", { hasText: "Record an inspection" }).click();
  await page.getByLabel("Inspection stage").selectOption("final");
  await page.getByLabel("Defects found").fill("0");
  await page.getByRole("button", { name: "Record inspection" }).click();
  await page.getByText("Inspection recorded: meets the sampling plan").waitFor();
  await page.getByLabel("Lot status").selectOption("accepted");
  await page.getByRole("button", { name: "Set status" }).click();
  await page.getByText("1 unit(s) have not passed the production test").waitFor();
  const retest = await runTest(units[2], 3.29, 1);
  await page.goto(lotUrl);
  assert.match(await page.getByTestId("lot-summary").innerText(), /3 passing, 0 failing; first-pass yield 67%/);
  await page.getByLabel("Lot status").selectOption("accepted");
  await page.getByRole("button", { name: "Set status" }).click();
  await page.getByText("Lot accepted").waitFor();
  assert.equal(await page.getByTestId("lot-status").innerText(), "accepted");
  assert.deepEqual(await page.getByTestId("lot-units").locator("tbody tr td:nth-child(2)").allInnerTexts(), ["passed", "passed", "passed"]);
  await shot(page, "05-lot-accepted");

  // 4. Trace a serial number.
  await page.goto(`${P}/production`);
  await page.getByTestId("trace-form").getByLabel("Serial number to trace").fill("SLATE-A-0003");
  await page.getByTestId("trace-form").getByRole("button", { name: "Trace" }).click();
  const trace = page.getByTestId("trace");
  await trace.waitFor();
  const text = await trace.innerText();
  assert.match(text, /LOT-001 \(pilot, accepted\)/);
  assert.match(text, /Rev A/);
  assert.match(text, /board\/fab-package v1/);
  assert.equal(await page.getByTestId("trace-runs").locator("tbody tr").count(), 2);
  await shot(page, "06-trace");

  // 5. The failing production test opened a fault (S6); until it is closed it blocks the next release.
  const { data: fault } = await api.from("faults").select("id").eq("project_id", project.id).eq("status", "open").single();
  await page.goto(`${P}/releases`);
  await page.locator("summary", { hasText: "Prepare a release" }).click();
  await page.getByLabel("Revision").fill("B-check");
  await page.getByRole("button", { name: "Make draft" }).click();
  await page.getByText("Draft release made").waitFor();
  assert.match(await page.getByTestId("readiness").locator("[data-severity=block]").innerText(), /fault F-001 \(major\) is not verified/);
  await page.getByLabel("Reason for releasing despite blockers").waitFor();
  await page.locator("summary", { hasText: "Delete this draft" }).click();
  await page.getByLabel("Reason for withdrawing").fill("Only checking readiness.");
  await page.getByRole("button", { name: "Delete draft" }).click();
  await page.getByText("Draft deleted.").waitFor();
  assert.ifError((await api.rpc("update_fault", { p_fault_id: fault.id, p_status: "verified", p_root_cause: "Cold joint on U2 pin 3",
    p_correction_kind: "rework", p_correction: "Reflowed U2", p_verified_by_run: retest, p_note: null })).error);

  // 6. Rev B: the FCC result is now on an older revision; the lot stays on Rev A.
  await commit(project.id, "fab_package", "board/fab-package", 2, "gerbers v2");
  await page.goto(`${P}/releases`);
  await page.locator("summary", { hasText: "Prepare a release" }).click();
  assert.equal(await page.getByLabel("Revision").inputValue(), "B");
  assert.equal(await page.getByLabel("board/fab-package v2").isChecked(), true);
  assert.equal(await page.getByLabel("board/fab-package v1").isChecked(), false);
  await page.getByRole("button", { name: "Make draft" }).click();
  await page.getByText("Draft release made").waitFor();
  const open = await page.getByTestId("readiness").locator("li").allInnerTexts();
  assert.ok(open.some((t) => /C-\d+ identified: EU Radio Equipment Directive/.test(t)), "open compliance items are warnings");
  await page.getByRole("button", { name: "Issue Rev B" }).click();
  await page.getByText("Released:").waitFor();
  await page.goto(`${P}/compliance`);
  assert.match(await page.getByTestId("items").locator(`li[data-item=${code}]`).getByTestId("stale").innerText(), /Tested on Rev A; the current release is Rev B/);
  await shot(page, "07-compliance-after-rev-b");
  const { data: rel } = await api.from("releases").select("revision, status").eq("project_id", project.id).order("release_no");
  assert.deepEqual(rel.map((r) => `${r.revision}:${r.status}`), ["A:superseded", "B:released"]);
  console.log("Production flow passed: release, compliance from suggestions, lab result, lot with inspection and acceptance rules, trace, revision change.");
} finally {
  await browser.close();
}
