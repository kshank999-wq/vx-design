// End-to-end test of S8 lifecycle.
//  - Watch: the committed sourced BOM is loaded; each part gets a calculated risk with reasons (a not-recommended
//    timer short of stock, a clear regulator).
//  - Notice: an end-of-life notice for the regulator, with its source, moves it to high risk.
//  - Case: opened from the watch, assessed; a substitute proposed from the BOM's alternates, its checks filled with a
//    basis and a passing bench test; qualified by the owner; the case resolved with it as a project decision.
//  - Revisions and cost: Rev A and Rev B releases show the BOM change by reference; the cost history lists both BOMs.
//  - Supplier performance: a lot with late delivery and a failed inspection shows on the supplier's page.
//
// Needs the app running and the local Supabase stack (./scripts/test-e2e-lifecycle.sh).
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeMpn, normalizeManufacturer } from "../../../packages/integrations/src/sourcing/normalize.ts";

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
const S = String(stamp).slice(-6);
const owner = { email: `lifecycle-${stamp}@example.test`, password: "correct-horse-battery" };
const day = (n) => new Date(Date.now() + n * 86400e3).toISOString().slice(0, 10);

// Unique part numbers per run, so the shared catalog starts clean for this test.
const LDO = `AP2112K-33-${S}`, TIMER = `NE555-${S}`, RES = `RC0402-10K-${S}`, SUB = `TLV75533-${S}`;
async function seedPart(mpn, manufacturer, lifecycle, offers) {
  const { data: part, error } = await admin.from("parts").insert({ mpn, normalized_mpn: normalizeMpn(mpn), manufacturer,
    normalized_mfr: normalizeManufacturer(manufacturer), lifecycle }).select("id").single();
  assert.ifError(error);
  for (const o of offers) assert.ifError((await admin.from("offers").insert({ part_id: part.id, provider: "fixture", data_status: "fixture", currency: "USD", ...o })).error);
  return part.id;
}
const prices = (p) => [{ quantity: 1, unit_price: p * 2 }, { quantity: 100, unit_price: p }];
async function commitBom(projectId, version, lines, perBoard) {
  const json = { generatedAt: new Date().toISOString(), currency: "USD", quantities: [300], dataStatus: "fixture", providers: [],
    lines: lines.map(([refs, mpn, manufacturer, alternates = []]) => ({ refs, quantityPerBoard: refs.length, class: "ic",
      wanted: { mpn, manufacturer, value: "", footprint: "", package: null, requirements: [] },
      selected: { mpn, manufacturer, description: null, lifecycle: "active", datasheetUrl: null, productUrl: null, identity: "exact", providers: ["fixture"] },
      lcsc: null, offers: [], pricing: [], alternates, flags: [], attempts: [] })),
    totals: [{ boards: 300, perBoard, total: perBoard * 300, missingLines: [] }],
    counts: { lines: lines.length, sourced: lines.length, unsourced: 0, errors: 0, warnings: 0, withLcsc: 0 } };
  const bytes = Buffer.from(JSON.stringify(json));
  const path = `${projectId}/artifacts/${stamp}-sourced-bom-v${version}.json`;
  assert.ifError((await admin.storage.from("project-files").upload(path, bytes, { contentType: "application/json" })).error);
  let { data: art } = await admin.from("artifacts").select("id").eq("project_id", projectId).eq("name", "sourcing/sourced-bom").maybeSingle();
  if (!art) art = (await admin.from("artifacts").insert({ project_id: projectId, kind: "bom", name: "sourcing/sourced-bom" }).select("id").single()).data;
  const { data: v, error } = await admin.from("artifact_versions").insert({ artifact_id: art.id, project_id: projectId, version, status: "committed", storage_path: path,
    sha256: createHash("sha256").update(bytes).digest("hex"), size_bytes: bytes.length, tool_name: "e2e", committed_at: new Date(Date.now() + version * 1000).toISOString() })
    .select("id").single();
  assert.ifError(error);
  return v.id;
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
  const { data: project } = await api.from("projects").insert({ name: `Watch ${stamp}` }).select("id").single();
  const P = `${BASE}/projects/${project.id}`;
  assert.ifError((await api.rpc("save_intake", { p_project: project.id, p_intake: { quantity: "300" } })).error);

  const old = new Date(Date.now() - 200 * 86400e3).toISOString(), recent = new Date(Date.now() - 2 * 86400e3).toISOString();
  await seedPart(LDO, "Diodes Incorporated", "active", [{ seller: "DigiKey", stock: 8000, prices: prices(0.12), observed_at: old },
                                                       { seller: "Mouser", stock: 5000, prices: prices(0.13), observed_at: recent }]);
  await seedPart(TIMER, "Texas Instruments", "nrnd", [{ seller: "DigiKey", stock: 400, prices: prices(0.2), observed_at: recent }]);
  await seedPart(RES, "Yageo", "active", [{ seller: "DigiKey", stock: 90000, prices: prices(0.001), observed_at: recent },
                                           { seller: "LCSC", stock: 500000, prices: prices(0.0008), observed_at: recent }]);
  await seedPart(SUB, "Texas Instruments", "active", [{ seller: "DigiKey", stock: 20000, prices: prices(0.11), observed_at: recent }]);
  const bom1 = await commitBom(project.id, 1, [[["U1"], LDO, "Diodes Incorporated", [{ mpn: SUB, manufacturer: "Texas Instruments", lcsc: null, stock: 20000 }]],
                                               [["U2", "U3"], TIMER, "Texas Instruments"], [["R1", "R2"], RES, "Yageo"]], 1.42);

  // 1. Load the BOM into the watch.
  await page.goto(`${P}/lifecycle`);
  await page.getByRole("button", { name: "Load the BOM (sourcing/sourced-bom v1)" }).click();
  await page.getByText("3 BOM line(s) loaded into the watch.").waitFor();
  const watch = page.getByTestId("watch");
  assert.equal(await watch.locator(`tr[data-mpn="${TIMER}"]`).getAttribute("data-risk"), "medium");
  assert.match(await watch.locator(`tr[data-mpn="${TIMER}"]`).innerText(), /not recommended for new designs; distributor stock 400 is below the 600 needed; stocked by one distributor only \(DigiKey\)/);
  assert.equal(await watch.locator(`tr[data-mpn="${LDO}"]`).getAttribute("data-risk"), "none");
  assert.equal(await watch.locator(`tr[data-mpn="${RES}"]`).getAttribute("data-risk"), "none");
  assert.match(await page.getByTestId("watch-summary").innerText(), /Includes fixture/);
  await shot(page, "01-watch");

  // 2. An end-of-life notice for the regulator.
  await page.locator("summary", { hasText: "Record a change or end-of-life notice" }).click();
  await page.getByLabel("Notice part").selectOption({ label: LDO });
  await page.getByLabel("Notice kind").selectOption("eol");
  await page.getByLabel("Notice title").fill("AP2112K family end of life");
  await page.getByLabel("Notice number").fill("PCN-2026-117");
  await page.getByLabel("Last order date").fill(day(120));
  await page.getByLabel("Source link").fill("https://example.test/pcn-2026-117.pdf");
  await page.getByRole("button", { name: "Record notice" }).click();
  await page.getByText("Notice recorded.").waitFor();
  const ldoRow = page.getByTestId("watch").locator(`tr[data-mpn="${LDO}"]`);
  assert.equal(await ldoRow.getAttribute("data-risk"), "high");
  assert.match(await ldoRow.innerText(), /last-time buy closes in 120 days/);
  assert.match(await ldoRow.innerText(), /2 notice\(s\)/, "the EOL notice and the automatic lifecycle-change notice");

  // 3. A case, a substitute, qualification and resolution.
  await ldoRow.getByRole("button", { name: "Open case" }).click();
  await page.getByText("Case opened").waitFor();
  assert.equal(await page.getByTestId("case-status").innerText(), "open");
  await page.getByLabel("Impact assessment").fill("U1 on every board; 300 boards planned; 40 regulators in stock.");
  await page.getByRole("button", { name: "Save assessment" }).click();
  await page.getByText("Assessment saved.").waitFor();
  await page.locator("summary", { hasText: "Propose a substitute" }).click();
  await page.getByLabel("Alternate").selectOption({ label: `Texas Instruments ${SUB}` });
  await page.getByRole("button", { name: "Propose" }).click();
  await page.getByText(`${SUB} proposed: work through`).waitFor();
  // A bench test of a board fitted with the substitute.
  const { data: unit } = await api.rpc("create_unit", { p_project_id: project.id, p_serial: "SUB-01", p_revision: "A" });
  const { data: tp } = await api.rpc("save_procedure", { p_project_id: project.id, p_id: null, p_title: "Regulator output", p_stage: "functional", p_requirement_refs: [],
    p_setup: null, p_steps: null, p_measurements: [{ key: "v", label: "+3V3", kind: "numeric", unit: "V", min: 3.2, max: 3.4 }] });
  assert.ifError((await api.rpc("approve_procedure", { p_id: tp })).error);
  assert.ifError((await api.rpc("record_test_run", { p_unit_id: unit, p_procedure_id: tp, p_performed_at: new Date().toISOString(), p_conditions: {}, p_values: { v: 3.31 },
    p_notes: null, p_supersedes: null })).error);
  await page.reload();
  const fill = async (label, result, basis) => {
    await page.getByLabel(`${label} result for ${SUB}`).selectOption(result);
    await page.getByLabel(`${label} basis for ${SUB}`).fill(basis);
  };
  await fill("Footprint and pin-out", "pass", "SOT-23-5, same pin-out (datasheet pin table)");
  await fill("Electrical ratings", "pass", "500 mA vs 600 mA needed 150 mA; dropout lower");
  await fill("Temperature and environment", "pass", "-40 to 125 °C");
  await fill("Supply (stock, second source)", "pass", "20,000 at DigiKey");
  await fill("Bench or production test", "pass", "SUB-01 at nominal input");
  await page.getByLabel(`Test run for ${SUB}`).selectOption({ index: 1 });
  await page.getByRole("button", { name: "Save checks" }).click();
  await page.getByText("Checks saved.").waitFor();
  await page.getByLabel(`Decision on ${SUB}`).selectOption("qualify");
  await page.getByLabel(`Reason for ${SUB}`).fill("Drop-in; bench test passed.");
  await page.getByRole("button", { name: "Decide" }).click();
  await page.getByText("Substitute qualified.").waitFor();
  await page.getByRole("tab", { name: "3. Resolution" }).click();
  await page.getByLabel("Resolution", { exact: true }).selectOption("substitute");
  await page.getByLabel("Resolution reason").fill("Pin-compatible, qualified and bench tested.");
  await page.getByRole("button", { name: "Resolve" }).click();
  await page.getByText("Resolved and recorded as a project decision.").waitFor();
  assert.match(await page.getByTestId("resolution").innerText(), /substitute: Pin-compatible/);
  await shot(page, "02-case-resolved");
  const { data: dec } = await api.from("decisions").select("statement, evidence_category").eq("project_id", project.id).like("title", "LC-001%").single();
  assert.equal(dec.statement, `Replace ${LDO} with Texas Instruments ${SUB}.`);
  assert.equal(dec.evidence_category, "hardware_test");

  // 4. Releases before and after the change; the BOM change by reference; cost history.
  const issue = async (rev, ids) => {
    const { data: id, error } = await api.rpc("save_release", { p_project: project.id, p_id: null, p_revision: rev, p_notes: null, p_version_ids: ids });
    assert.ifError(error);
    assert.ifError((await api.rpc("issue_release", { p_release: id, p_waiver: null })).error);
    return id;
  };
  await issue("A", [bom1]);
  const bom2 = await commitBom(project.id, 2, [[["U1"], SUB, "Texas Instruments"], [["U2", "U3"], TIMER, "Texas Instruments"], [["R1", "R2"], RES, "Yageo"]], 1.38);
  const relB = await issue("B", [bom2]);
  await page.goto(`${P}/releases/${relB}`);
  await page.getByRole("tab", { name: "Changes from Rev A" }).click();
  assert.match(await page.getByTestId("release-changes").innerText(), /changed: sourcing\/sourced-bom v1 → v2/);
  assert.equal(await page.getByTestId("bom-changes").innerText(), `U1: ${LDO} (Diodes Incorporated) → ${SUB} (Texas Instruments)`);
  await shot(page, "03-release-changes");
  await page.goto(`${P}/lifecycle`);
  await page.getByRole("tab", { name: "Cost history" }).click();
  const hist = await page.getByTestId("cost-history").innerText();
  assert.match(hist, /sourced-bom v2.*Rev B.*\$1\.38/s);
  assert.match(hist, /sourced-bom v1.*Rev A.*\$1\.42/s);
  await page.getByRole("tab", { name: "Watch" }).click();
  await page.getByRole("button", { name: "Load the newer BOM (sourcing/sourced-bom v2)" }).click();
  await page.getByText("3 BOM line(s) loaded").waitFor();
  const subRow = page.getByTestId("watch").locator(`tr[data-mpn="${SUB}"]`);
  assert.equal(await subRow.getAttribute("data-risk"), "low");
  assert.match(await subRow.innerText(), /stocked by one distributor only \(DigiKey\)/);
  assert.equal(await page.getByTestId("watch").locator(`tr[data-mpn="${LDO}"]`).count(), 0);
  await shot(page, "04-watch-after");

  // 5. Supplier performance from a lot: late delivery and a failed inspection.
  const { data: mfr } = await admin.from("manufacturers").insert({ display_name: `Example Assembly ${stamp}`, categories: ["pcba"] }).select("id").single();
  const { data: lot, error: lotErr } = await api.rpc("create_lot", { p_project: project.id, p_kind: "pilot", p_release: relB, p_quantity: 4, p_sample_size: 2, p_accept_max: 0,
    p_procedure: null, p_manufacturer: mfr.id, p_built_by: null, p_notes: null });
  assert.ifError(lotErr);
  assert.ifError((await api.rpc("record_lot_inspection", { p_lot: lot, p_stage: "incoming", p_inspected: 2, p_defects: 1,
    p_findings: [{ defect: "solder bridge U2", count: 1 }], p_notes: null })).error);
  await page.goto(`${P}/production/${lot}`);
  await page.locator("summary", { hasText: "Delivery dates" }).click();
  await page.getByLabel("Promised date").fill(day(-5));
  await page.getByLabel("Delivered date").fill(day(-2));
  await page.getByRole("button", { name: "Save dates" }).click();
  await page.getByText("Delivery dates saved.").waitFor();
  assert.match(await page.getByTestId("lot-delivery").innerText(), /\(late\)/);
  await page.goto(`${BASE}/suppliers/${mfr.id}`);
  const perf = await page.getByTestId("vendor-performance").innerText();
  assert.match(perf, /1 built, 0 accepted, 0 rejected/);
  assert.match(perf, /1 defect\(s\) in 2 inspected \(50%\)/);
  assert.match(perf, /0 of 1 lot\(s\) \(0%\)/);
  await shot(page, "05-supplier-performance");
  console.log("Lifecycle flow passed: watch, EOL notice, case with qualified substitute, revision BOM change, cost history, supplier performance.");
} catch (e) {
  if (page && process.env.FAIL_SHOT) await page.screenshot({ path: process.env.FAIL_SHOT, fullPage: true });
  throw e;
} finally {
  await browser.close();
}
