// End-to-end test of mechanical checks.
//  - Stacks from the committed enclosure: board to wall, components to lid, connector opening; the enclosure tolerance
//    is taken from a supplier's FDM process rules and named; board tolerances are marked as assumptions.
//  - The board-to-wall stack passes only statistically; widening the gap makes it pass in the worst case.
//  - A gasket check fails at the tolerance extremes, then passes with a tighter groove; a thermal estimate from the
//    power budget flags a regulator inside the box; a reviewer note is recorded.
//
// Needs the app running and the local Supabase stack (./scripts/test-e2e-mechanical.sh).
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
const owner = { email: `mech-${stamp}@example.test`, password: "correct-horse-battery" };

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
  const { data: project } = await api.from("projects").insert({ name: `Mech ${stamp}` }).select("id").single();
  const P = `${BASE}/projects/${project.id}`;
  await commitJson(project.id, "enc/fit-report", "report", { ok: true, process: { name: "fdm", label: "FDM" }, material: "PETG",
    dimensions_mm: { x: 64, y: 44, z: 24 }, board: { thickness_mm: 1.6 }, levels_mm: { board_top: 1.6, lid_inner: 12 },
    spec: { process: "fdm", wall_mm: 2, edge_gap_mm: 0.5, top_clearance_mm: 2, standoff_height_mm: 4,
            openings: [{ kind: "edge", ref: "J1", side: "front", margin_mm: 0.5 }] } });
  await commitJson(project.id, "power/power-budget", "power_budget", { ambientC: { nominal: 25, max: 40 },
    sources: [{ id: "usb", powerW: { active: 1.1, sleep: 0.02 } }],
    converters: [{ id: "U3", label: "U3 3.3 V LDO", pdissMaxW: 0.6, tjMaxC: 40 + 0.6 * 160 }] });
  // A supplier's FDM rules state ±0.25 mm; a second states ±0.2. The looser one is used.
  for (const [name, t] of [[`Print Farm ${stamp}`, 0.25], [`Layer Works ${stamp}`, 0.2]]) {
    const { data: m } = await admin.from("manufacturers").insert({ display_name: name, categories: ["printing_casting"] }).select("id").single();
    assert.ifError((await admin.from("process_rules").insert({ manufacturer_id: m.id, process: "fdm", rules: { tolerance_mm: t, min_wall_mm: 1.2 },
      source_url: "https://example.test/capabilities", checked_on: "2026-11-01" })).error);
  }

  // 1. Stacks from the enclosure.
  await page.goto(`${P}/mechanical`);
  await page.getByRole("button", { name: "Stacks from the enclosure" }).click();
  await page.getByText("3 stack(s) added from enc/fit-report v1").waitFor();
  const rows = page.getByTestId("analyses");
  assert.equal(await rows.locator("tr[data-title='Board edge to enclosure wall']").getAttribute("data-verdict"), "pass_statistical");
  assert.equal(await rows.locator("tr[data-title='J1 opening alignment']").count(), 1);
  await shot(page, "01-stacks");
  await rows.getByRole("link", { name: /Board edge to enclosure wall/ }).click();
  const result = page.getByTestId("result");
  await result.waitFor();
  assert.match(await result.innerText(), /Worst case -0\.05 to 1\.05 mm/);
  assert.match(await result.innerText(), /Clear statistically but not in the worst case/);
  assert.match(await result.innerText(), /Rests on assumed tolerances: Board outline \(half, per side\), Board shift on its screws/);
  assert.equal(await page.getByLabel("Basis 2").inputValue(), `Print Farm ${stamp}'s FDM process rules (±0.25 mm, read 2026-11-01, not yet verified); loosest of 2 supplier(s)`);
  await page.getByLabel("Nominal 1").fill("0.8");
  await page.getByRole("button", { name: "Save and recalculate" }).click();
  await page.getByText("Saved and recalculated.").waitFor();
  assert.equal(await page.getByTestId("verdict").innerText(), "pass (worst case)");
  await shot(page, "02-stack-detail");

  // 2. Gasket: the example fails at the extremes; a tighter groove depth passes.
  await page.goto(`${P}/mechanical`);
  await page.getByRole("button", { name: "Gasket check" }).click();
  await page.getByText("Gasket check added").waitFor();
  assert.equal(await page.getByTestId("verdict").innerText(), "fail");
  assert.match(await page.getByTestId("result").innerText(), /Compression 19\.3% to 30\.3%/);
  await page.getByLabel("Groove depth (closed gap) plus").fill("0.03");
  await page.getByLabel("Groove depth (closed gap) minus").fill("0.03");
  await page.getByRole("button", { name: "Save and recalculate" }).click();
  await page.getByText("Saved and recalculated.").waitFor();
  assert.equal(await page.getByTestId("verdict").innerText(), "pass (worst case)");
  assert.match(await page.getByTestId("result").innerText(), /groove fill up to 84\.1%/);

  // 3. Thermal from the power budget: 1.1 W in the box; the LDO's θJA (160 °C/W) recovered from the budget.
  await page.goto(`${P}/mechanical`);
  await page.getByRole("button", { name: "Thermal estimate from the power budget" }).click();
  await page.getByText("Thermal estimate added").waitFor();
  const th = await page.getByTestId("result").innerText();
  assert.match(th, /1\.1 W inside a 64 × 44 × 24 mm box \(0\.0108 m² of surface at 5 W\/m²·K\): the air inside rises 20\.3 °C to 60\.3 °C/);
  assert.match(th, /U3 3\.3 V LDO reaches 156\.3 °C inside the box, over its 125 °C limit/);
  assert.equal(await page.getByTestId("verdict").innerText(), "fail");
  await shot(page, "03-thermal");

  // 4. Review.
  await page.getByLabel("Review note").fill("Coefficient is the sealed-box rule of thumb; LDO needs a switcher or copper.");
  await page.getByRole("button", { name: "Mark reviewed" }).click();
  await page.getByText("Reviewed.", { exact: true }).waitFor();
  assert.match(await page.getByTestId("review").innerText(), /sealed-box rule of thumb/);
  await page.goto(`${P}/mechanical`);
  assert.equal(await page.getByTestId("analyses").locator("tbody tr").count(), 5);
  await shot(page, "04-list");
  console.log("Mechanical flow passed: enclosure stacks with supplier tolerance, gasket, thermal, review.");
} catch (e) {
  if (page && process.env.FAIL_SHOT) await page.screenshot({ path: process.env.FAIL_SHOT, fullPage: true });
  throw e;
} finally {
  await browser.close();
}
