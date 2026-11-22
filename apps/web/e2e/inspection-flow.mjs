// End-to-end test of inspection plans.
//  - A PCBA plan drafted from the committed fab check (X-ray for QFN, DNP parts and mounting holes excluded), edited,
//    approved (then frozen) and downloaded as CSV.
//  - An enclosure plan whose tolerance is taken from a supplier's FDM rules and named.
//  - Revising the approved plan makes v2; approving it supersedes v1. A lot is linked to the approved plan.
//
// Needs the app running and the local Supabase stack (./scripts/test-e2e-inspection.sh).
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
const owner = { email: `insp-${stamp}@example.test`, password: "correct-horse-battery" };

async function commitJson(projectId, name, kind, json) {
  const bytes = Buffer.from(JSON.stringify(json));
  const path = `${projectId}/artifacts/${stamp}-${name.replace("/", "-")}.json`;
  assert.ifError((await admin.storage.from("project-files").upload(path, bytes, { contentType: "application/json" })).error);
  const { data: art } = await admin.from("artifacts").insert({ project_id: projectId, kind, name }).select("id").single();
  assert.ifError((await admin.from("artifact_versions").insert({ artifact_id: art.id, project_id: projectId, version: 1, status: "committed",
    storage_path: path, sha256: createHash("sha256").update(bytes).digest("hex"), size_bytes: bytes.length, tool_name: "e2e", committed_at: new Date().toISOString() })).error);
}

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
  const { data: project } = await api.from("projects").insert({ name: `Inspect ${stamp}` }).select("id").single();
  const P = `${BASE}/projects/${project.id}`;
  await commitJson(project.id, "fab/fab-check", "report", { profile: "jlcpcb-2layer-standard",
    board: { width_mm: 34, height_mm: 22, copper_layers: 2, holes: { plated: 3, nonplated: 4, vias: 6 }, min_drill_mm: 0.3, min_track_mm: 0.2 },
    parts: [
      { ref: "U1", value: "AP2112K", footprint: "Package_TO_SOT_SMD:SOT-23-5", side: "top", smd: true, dnp: false },
      { ref: "U2", value: "MCU", footprint: "Package_DFN_QFN:QFN-32-1EP_5x5mm_P0.5mm_EP3.45x3.45mm", side: "top", smd: true, dnp: false },
      { ref: "C1", value: "1u", footprint: "Capacitor_SMD:C_0603_1608Metric", side: "bottom", smd: true, dnp: false },
      { ref: "C9", value: "10u", footprint: "Capacitor_SMD:C_0805_2012Metric", side: "top", smd: true, dnp: true },
      { ref: "J1", value: "Header", footprint: "Connector_PinHeader_2.54mm:PinHeader_1x03_P2.54mm_Vertical", side: "top", smd: false, dnp: false },
      { ref: "H1", value: "M3", footprint: "MountingHole:MountingHole_3.2mm_M3", side: "top", smd: false, dnp: false },
    ] });
  await commitJson(project.id, "enc/fit-report", "report", { ok: true, process: { name: "fdm", label: "FDM" }, material: "PETG",
    dimensions_mm: { x: 64, y: 44, z: 24 }, spec: { wall_mm: 2 }, mounting: { H1: { hole_mm: 2.5, boss_od_mm: 6 } },
    openings: [{ ref: "J1", kind: "edge", side: "front", width_mm: 9.2, height_mm: 3.6 }] });

  // 1. A PCBA plan from the fab check: items follow the board (DNP parts and mounting holes are not components).
  await page.goto(`${P}/inspection`);
  await page.getByRole("button", { name: "Draft board plan" }).click();
  await page.getByText(/Drafted \d+ items from fab\/fab-check v1/).waitFor();
  assert.equal(await page.getByTestId("plan-status").innerText(), "draft");
  const items = page.getByTestId("plan-items");
  assert.equal(await items.locator("tr[data-key='xray'] textarea[name$='characteristic']").inputValue(), "Hidden joints under U2");
  assert.equal(await items.locator("tr[data-key='placement'] textarea[name$='characteristic']").inputValue(), "4 components present, correct part and value");
  assert.match(await items.locator("tr[data-key='thickness'] textarea[name$='characteristic']").inputValue(), /1\.6 mm/);
  await shot(page, "01-draft");

  // 2. Edit: tighten the outline, drop the bottom-side check, add a conformal-coat check; then approve.
  await items.locator("tr[data-key='outline'] textarea[name$='acceptance']").fill("34 × 22 mm ± 0.15 mm (fab's stated routing tolerance)");
  await items.locator("tr[data-key='bottom_side'] input[name$='_remove']").check();
  await items.locator("textarea[name='new_characteristic']").fill("Conformal coat coverage");
  await items.locator("textarea[name='new_method']").fill("UV lamp");
  await items.locator("textarea[name='new_acceptance']").fill("Covered except connectors and test points");
  await page.getByRole("button", { name: "Save plan" }).click();
  await page.getByText(/^Saved \d+ items\.$/).waitFor();
  assert.equal(await items.locator("tr[data-key='bottom_side']").count(), 0);
  assert.equal(await items.locator("tr[data-key='conformal_coat_coverage'] select[name$='stage']").inputValue(), "final");
  await page.getByLabel("Approval note").fill("Matches the fab notes.");
  await page.getByRole("button", { name: "Approve plan" }).click();
  await page.getByText("Plan approved.").waitFor();
  assert.equal(await page.getByTestId("plan-status").innerText(), "approved");
  assert.equal(await page.getByRole("button", { name: "Save plan" }).count(), 0, "approved plans are frozen");
  const planUrl = page.url().split("?")[0];

  // 3. CSV for the supplier.
  const csv = await (await page.request.get(`${planUrl}/csv`)).text();
  assert.match(csv, /^Stage,Characteristic,Method,Sample,Acceptance,Reference,Critical\r\n/);
  assert.match(csv, /"incoming","Board outline 34 × 22 mm","Calliper","sample","34 × 22 mm ± 0\.15 mm \(fab's stated routing tolerance\)"/);
  assert.match(csv, /"final","Conformal coat coverage","UV lamp"/);
  await shot(page, "02-approved");

  // 4. Enclosure plan: the tolerance comes from a supplier's FDM rules, named.
  const { data: m } = await admin.from("manufacturers").insert({ display_name: `Insp Prints ${stamp}`, categories: ["printing_casting"] }).select("id").single();
  assert.ifError((await admin.from("process_rules").insert({ manufacturer_id: m.id, process: "fdm", rules: { tolerance_mm: 9.5 },
    source_url: "https://example.test/capabilities", checked_on: "2026-11-02" })).error);
  try {
    await page.goto(`${P}/inspection`);
    await page.getByRole("button", { name: "Draft enclosure plan" }).click();
    await page.getByText(/Drafted \d+ items from enc\/fit-report v1/).waitFor();
  } finally {
    // The supplier directory is shared: remove this deliberately loose rule so other flows see their own suppliers.
    await admin.from("process_rules").delete().eq("manufacturer_id", m.id);
    await admin.from("manufacturers").delete().eq("id", m.id);
  }
  assert.equal(await items.locator("tr[data-key='opening_j1'] textarea[name$='characteristic']").inputValue(), "Opening for J1 (edge, front): 9.2 × 3.6 mm");
  const overall = await items.locator("tr[data-key='overall'] textarea[name$='acceptance']").inputValue();
  assert.ok(overall.includes(`± 9.5 mm (Insp Prints ${stamp}'s FDM process rules (±9.5 mm, read 2026-11-02, not yet verified)`), overall);

  // 5. Revise the approved board plan: v2 draft; approving it supersedes v1.
  await page.goto(planUrl);
  await page.getByRole("button", { name: "Revise (new version)" }).click();
  await page.getByText("New draft version made").waitFor();
  await page.getByRole("button", { name: "Approve plan" }).click();
  await page.getByText("Plan approved.").waitFor();
  await page.goto(`${P}/inspection`);
  const plans = page.getByTestId("plans");
  assert.equal(await plans.locator("tr[data-plan='IP-001 v1']").getAttribute("data-status"), "superseded");
  assert.equal(await plans.locator("tr[data-plan='IP-001 v2']").getAttribute("data-status"), "approved");
  assert.equal(await plans.locator("tr[data-plan='IP-002 v1']").getAttribute("data-status"), "draft");
  await shot(page, "03-list");

  // 6. A lot inspected against the approved plan.
  const { data: rel } = await admin.from("releases").insert({ project_id: project.id, release_no: 1, revision: "A", status: "released", manifest: [],
    manifest_sha256: "a".repeat(64), released_at: new Date().toISOString() }).select("id").single();
  const { data: lot } = await admin.from("production_lots").insert({ project_id: project.id, lot_no: 1, release_id: rel.id, quantity: 10, sample_size: 5 }).select("id").single();
  await page.goto(`${P}/production/${lot.id}`);
  assert.equal(await page.getByTestId("lot-plan").innerText(), "none set");
  await page.getByRole("tab", { name: "Inspections" }).click();
  assert.equal(await page.getByLabel("Inspection plan").locator("option").count(), 2, "only approved plans are offered");
  await page.getByLabel("Inspection plan").selectOption({ label: "IP-001 v2 Assembled board" });
  await page.getByRole("button", { name: "Set plan" }).click();
  await page.getByText("Inspection plan set.").waitFor();
  assert.equal(await page.getByTestId("lot-plan").innerText(), "IP-001 v2 Assembled board");
  await page.getByTestId("lot-plan-items").locator("summary").click();
  assert.match(await page.getByTestId("lot-plan-items").innerText(), /Hidden joints under U2/);
  await shot(page, "04-lot");
  console.log("Inspection flow passed: PCBA plan from the fab check, edit, approve, CSV, enclosure plan with supplier tolerance, revise, lot link.");
} catch (e) {
  if (page && process.env.FAIL_SHOT) await page.screenshot({ path: process.env.FAIL_SHOT, fullPage: true });
  throw e;
} finally {
  await browser.close();
}
