// End-to-end test of manufacturer process rules and trade studies.
//  - Rules: an engineer fills a supplier's bare-PCB rules from a published template, a second supplier's from another
//    with a stricter drill, and assembly rules; the project's Manufacturing fit page checks the committed board and
//    enclosure against them, naming the failing limits.
//  - Trade study: a component choice from the template; options by part number; costs, stock and lifecycle filled from
//    the parts catalog (labelled fixture data); ranked with a sensitivity note; decided with a rationale into a decision.
//
// Needs the app running and the local Supabase stack (./scripts/test-e2e-trades.sh).
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
const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });
const stamp = Date.now();
const owner = { email: `trades-${stamp}@example.test`, password: "correct-horse-battery" };

async function commitJson(projectId, name, json) {
  const bytes = Buffer.from(JSON.stringify(json));
  const path = `${projectId}/artifacts/${stamp}-${name.replace("/", "-")}.json`;
  assert.ifError((await admin.storage.from("project-files").upload(path, bytes, { contentType: "application/json" })).error);
  const { data: art } = await admin.from("artifacts").insert({ project_id: projectId, kind: "report", name }).select("id").single();
  assert.ifError((await admin.from("artifact_versions").insert({ artifact_id: art.id, project_id: projectId, version: 1, status: "committed",
    storage_path: path, sha256: createHash("sha256").update(bytes).digest("hex"), size_bytes: bytes.length, tool_name: "e2e" })).error);
}
async function seedPart(mpn, manufacturer, lifecycle, offers) {
  const { data: part, error } = await admin.from("parts").upsert({ mpn, normalized_mpn: normalizeMpn(mpn), manufacturer,
    normalized_mfr: normalizeManufacturer(manufacturer), lifecycle }, { onConflict: "normalized_mpn,normalized_mfr" }).select("id").single();
  assert.ifError(error);
  for (const o of offers) assert.ifError((await admin.from("offers").insert({ part_id: part.id, provider: "fixture", data_status: "fixture", currency: "USD", ...o })).error);
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
  const { data: project } = await api.from("projects").insert({ name: `Fit and trade ${stamp}` }).select("id").single();
  await api.rpc("save_intake", { p_project: project.id, p_intake: { quantity: "500" } });

  // The committed design: a 2-layer 50 × 30 mm board with a 0402 passive, a bottom-side part and a header; a PETG FDM enclosure.
  await commitJson(project.id, "fab/fab-check", { profile: "jlcpcb-2layer-standard",
    board: { width_mm: 50, height_mm: 30, copper_layers: 2, min_track_mm: 0.2, min_drill_mm: 0.3 }, gerbers: { min_drill_mm: 0.3 },
    parts: [{ ref: "R1", footprint: "Resistor_SMD:R_0402_1005Metric", side: "top", smd: true },
            { ref: "U2", footprint: "Package_TO_SOT_SMD:SOT-23", side: "bottom", smd: true },
            { ref: "J1", footprint: "Connector_PinHeader_2.54mm:PinHeader_1x04_P2.54mm_Vertical", side: "top", smd: false }] });
  await commitJson(project.id, "enclosure/fit-report", { process: { name: "fdm" }, material: "PETG", spec: { wall_mm: 2 }, dimensions_mm: { x: 60, y: 40, z: 22 } });

  // 1. Process rules from templates on two suppliers' pages.
  const mfr = {};
  for (const name of [`Board House ${stamp}`, `Purple Boards ${stamp}`]) {
    const { data } = await admin.from("manufacturers").insert({ display_name: name, categories: ["bare_pcb", "pcba"] }).select("id").single();
    mfr[name] = data.id;
  }
  await page.goto(`${BASE}/suppliers/${mfr[`Board House ${stamp}`]}`);
  await page.getByRole("link", { name: "JLCPCB standard 1–2 layer" }).click();
  await page.getByText("(filled from JLCPCB standard 1–2 layer").waitFor();
  assert.equal(await page.getByLabel("Minimum track width (mm)").inputValue(), "0.127");
  await page.getByRole("button", { name: "Save rules" }).click();
  await page.getByText("Bare PCB fabrication rules saved").waitFor();
  await page.locator("summary", { hasText: "Add or edit process rules" }).click();
  await page.getByRole("link", { name: "JLCPCB SMT assembly (economic)" }).click();
  await page.getByText("(filled from JLCPCB SMT assembly").waitFor();
  await page.getByRole("button", { name: "Save rules" }).click();
  await page.getByText("PCB assembly (SMT/THT) rules saved").waitFor();
  const rulesList = page.getByTestId("process-rules");
  assert.match(await rulesList.locator("[data-process='pcb_fab']").innerText(), /Bare PCB fabrication\s+not verified[\s\S]*Layer counts\s+1, 2[\s\S]*Largest board\s+400 × 500 mm/);
  assert.match(await rulesList.locator("[data-process='pcb_assembly']").innerText(), /Parts on both sides\s+no/);
  await page.goto(`${BASE}/suppliers/${mfr[`Purple Boards ${stamp}`]}`);
  await page.getByRole("link", { name: "OSH Park 2-layer" }).click();
  await page.getByText("(filled from OSH Park 2-layer").waitFor();
  await page.getByLabel("Minimum drill (mm)").fill("0.35");
  await page.getByLabel("Largest board (mm)").fill("100 × 100 × 3");
  await page.getByRole("button", { name: "Save rules" }).click();
  await page.locator(".banner-error").filter({ hasText: "Largest board: give 2 sizes" }).waitFor();
  await page.getByRole("link", { name: "OSH Park 2-layer" }).click();
  await page.getByText("(filled from OSH Park 2-layer").waitFor();
  await page.getByLabel("Minimum drill (mm)").fill("0.35");
  await page.getByLabel("Source URL").fill("");
  await page.getByLabel("Or a note").fill("Capability email, 10 Nov");
  await page.getByRole("button", { name: "Save rules" }).click();
  await page.getByText("Bare PCB fabrication rules saved").waitFor();
  console.log("✓ process rules filled from templates, edited, with sources; bad sizes refused");

  // 2. Manufacturing fit for the project.
  await page.goto(`${BASE}/projects/${project.id}`);
  await page.getByRole("link", { name: "Manufacturing fit" }).click();
  assert.match(await page.getByTestId("board-facts").innerText(), /50 × 30 mm · 2 layers · track 0.2 mm · clearance 0.2 mm · drill 0.3 mm · 1.6 mm HASL[\s\S]*Smallest passive 0402 · parts on both sides · through-hole parts/);
  const fit = page.getByTestId("fit");
  const row = (s, p) => fit.locator(`tr[data-supplier='${s} ${stamp}'][data-process='${p}']`);
  assert.equal(await row("Board House", "pcb_fab").getAttribute("data-verdict"), "fits");
  assert.equal(await row("Purple Boards", "pcb_fab").getAttribute("data-verdict"), "does_not_fit");
  assert.match(await row("Purple Boards", "pcb_fab").innerText(), /Smallest drill: 0.3 mm vs ≥ 0.35 mm[\s\S]*Surface finish: HASL \(lead-free\) vs ENIG/);
  assert.match(await row("Board House", "pcb_assembly").innerText(), /does not fit[\s\S]*Parts on both sides: has bottom-side parts vs not offered/);
  assert.match(await row("Board House", "pcb_fab").innerText(), /rules not verified/);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "01-manufacturing-fit.png"), fullPage: true });
  console.log("✓ manufacturing fit: board checked against each supplier's rules, failing limits named");

  // 3. A component-choice trade study filled from the catalog.
  await seedPart(`TPS7A02-${stamp}`, "Texas Instruments", "active", [
    { seller: "DigiKey", sku: "TPS-1", stock: 12000, moq: 1, multiple: 1, prices: [{ quantity: 1, unit_price: 0.62 }, { quantity: 500, unit_price: 0.41 }] }]);
  await seedPart(`AP2112K-${stamp}`, "Diodes Incorporated", "nrnd", [
    { seller: "Mouser", sku: "AP-1", stock: 900, moq: 1, multiple: 1, prices: [{ quantity: 1, unit_price: 0.35 }, { quantity: 500, unit_price: 0.19 }] }]);
  await page.goto(`${BASE}/projects/${project.id}/trades`);
  await page.getByLabel("Question").fill("3.3 V regulator: which LDO?");
  await page.getByLabel("Start from").selectOption("component_choice");
  await page.getByRole("button", { name: "Start study" }).click();
  await page.getByText("Study started").waitFor();
  await page.getByLabel("Option 1").fill("TPS7A02");
  await page.getByLabel("Part number 1").fill(`TPS7A02-${stamp}`);
  await page.getByLabel("Option 2").fill("AP2112K");
  await page.getByLabel("Part number 2").fill(`AP2112K-${stamp}`);
  await page.getByRole("button", { name: "Save and rank" }).click();
  await page.getByText("Saved and ranked.").waitFor();
  await page.getByRole("button", { name: "Fill from parts catalog" }).click();
  await page.getByText("Filled from the parts catalog: TPS7A02, AP2112K.").waitFor();
  const scores = page.getByTestId("scores");
  assert.equal(await scores.getByLabel("TPS7A02: Unit cost at the target quantity", { exact: true }).inputValue(), "0.41");
  assert.match(await scores.getByLabel("Basis, AP2112K: Unit cost at the target quantity").inputValue(), /Mouser via fixture, 500 pcs, \d{4}-\d\d-\d\d \(fixture data, not real\)/);
  assert.equal(await scores.getByLabel("AP2112K: Lifecycle (5 = active, 1 = obsolete)", { exact: true }).inputValue(), "2");
  for (const [o, perf, second] of [["TPS7A02", "25", "3"], ["AP2112K", "55", "4"]]) {
    await scores.getByLabel(`${o}: Meets the requirements`, { exact: true }).fill("yes");
    await scores.getByLabel(`Basis, ${o}: Meets the requirements`).fill("datasheet vs REQ-PWR-002");
    await scores.getByLabel(`${o}: Key performance figure`, { exact: true }).fill(perf);
    await scores.getByLabel(`Basis, ${o}: Key performance figure`).fill("PSRR at 1 kHz, dB, datasheet");
    await scores.getByLabel(`${o}: Second source (5 = drop-in available)`, { exact: true }).fill(second);
    await scores.getByLabel(`Basis, ${o}: Second source (5 = drop-in available)`).fill("pin-compatible parts listed by distributors");
  }
  await page.getByRole("button", { name: "Save and rank" }).click();
  await page.getByText("Saved and ranked.").waitFor();
  const ranking = page.getByTestId("ranking");
  assert.match(await ranking.innerText(), /AP2112K\s+62.5[\s\S]*TPS7A02\s+46.4/);
  assert.equal(await page.getByTestId("sensitivity").innerText(), 'Close call: with "Stock across distributors" doubled, TPS7A02 would win.');
  assert.match(await scores.innerText(), /from the catalog/);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "02-trade-study.png"), fullPage: true });
  console.log("✓ trade study: catalog-filled costs, stock and lifecycle (fixture data labelled); ranked with a sensitivity note");

  // 4. Decide: the owner records the choice and its rationale as a project decision.
  const decide = page.getByTestId("decide");
  await decide.getByLabel("Choice").selectOption({ label: "TPS7A02" });
  await decide.getByLabel("Rationale").fill("Active part with stock; AP2112K is not recommended for new designs.");
  await decide.getByRole("button", { name: "Record the decision" }).click();
  await page.getByText("Decided: recorded as a project decision.").waitFor();
  assert.equal(await page.getByTestId("study-status").innerText(), "decided");
  const { data: dec } = await api.from("decisions").select("title, statement, evidence_category, alternatives").eq("project_id", project.id).single();
  assert.equal(dec.title, "TS-001: 3.3 V regulator: which LDO?");
  assert.equal(dec.statement, "Chose TPS7A02.");
  assert.equal(dec.alternatives[0].option, "AP2112K");
  assert.equal(dec.evidence_category, "deterministic_calculation", "every score had a basis");
  assert.equal(await page.getByRole("button", { name: "Save and rank" }).count(), 0, "a decided study is frozen");
  console.log("✓ decided with a rationale; recorded as a decision; the study is frozen");
  console.log("\nTrade study and process rule end-to-end flow passed.");
} catch (e) {
  console.error("\n✗ Trade study and process rule end-to-end flow failed:", e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
