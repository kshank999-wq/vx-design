// End-to-end test of manufacturing routes and the 3D-printing export.
//  - A part model (STL) is uploaded; its route's needs are pre-filled from the requirements (sun, 50 °C, drops).
//  - Production is injection molding in PC/ABS; the suggestions rank a UV-stable, tough material first; one is chosen.
//  - The export downloads a ZIP with the STL in the part's folder, a print sheet and parts.csv.
//  - The route reaches the planner's context on the Project inputs page.
//
// Needs the app running (VX_LLM=offline) and the local Supabase stack (./scripts/test-e2e-manufacturing.sh).
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const orch = createRequire(join(here, "../../../services/orchestrator/package.json"));
const { createClient } = orch("@supabase/supabase-js");
const { unzipSync, strFromU8 } = orch("fflate");

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const { SUPABASE_URL: URL, SUPABASE_ANON_KEY: ANON } = process.env;
if (!URL || !ANON) throw new Error("SUPABASE_URL and SUPABASE_ANON_KEY are required");
const SHOTS = process.env.SCREENSHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true }); };
const stamp = Date.now();
const owner = { email: `mfg-${stamp}@example.test`, password: "correct-horse-battery" };

// A 40 × 30 × 20 mm box as a binary STL.
function boxStl() {
  const v = [[0, 0, 0], [40, 0, 0], [40, 30, 0], [0, 30, 0], [0, 0, 20], [40, 0, 20], [40, 30, 20], [0, 30, 20]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const b = Buffer.alloc(84 + f.length * 50);
  b.writeUInt32LE(f.length, 80);
  f.forEach((t, i) => t.forEach((vi, k) => v[vi].forEach((c, a) => b.writeFloatLE(c, 84 + i * 50 + 12 + (k * 3 + a) * 4))));
  return b;
}

const browser = await chromium.launch();
let page;
try {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1, acceptDownloads: true });
  page = await ctx.newPage();
  await page.goto(`${BASE}/login`);
  await page.getByLabel("Email").fill(owner.email);
  await page.getByLabel("Password").fill(owner.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL(/\/projects$/);
  const api = createClient(URL, ANON, { auth: { persistSession: false } });
  assert.ifError((await api.auth.signInWithPassword(owner)).error);
  const { data: project } = await api.from("projects").insert({ name: `Mfg ${stamp}`, description: "Touchscreen movie slate" }).select("id").single();
  assert.ifError((await api.from("requirements").insert([
    { project_id: project.id, ref_code: "REQ-ENV-001", kind: "environmental", priority: "must", text: "The slate shall work in direct sunlight at up to 50 °C." },
    { project_id: project.id, ref_code: "REQ-MECH-001", kind: "mechanical", priority: "must", text: "The slate shall survive a 1.2 m drop onto concrete." },
  ])).error);
  const P = `${BASE}/projects/${project.id}`;

  // 1. Upload a part model; set up its route.
  await page.goto(P);
  await page.getByRole("link", { name: "Manufacturing routes" }).click();
  await page.waitForURL(/\/manufacturing$/);
  await page.getByTestId("no-parts").waitFor();
  const up = page.getByTestId("upload-model");
  await up.getByLabel("Model part name").fill("Front bezel");
  await up.getByLabel("Part model files").setInputFiles([{ name: "bezel.stl", mimeType: "model/stl", buffer: boxStl() }]);
  await up.getByRole("button", { name: "Add part models" }).click();
  await page.getByTestId("upload-model-status").getByText("bezel.stl: added").waitFor();
  await page.reload();
  const card = page.locator("[data-model='Front bezel']");
  await card.locator("summary").click();
  assert.equal(await card.getByLabel("Used outdoors or in sun Front bezel").isChecked(), true, "needs pre-filled from the requirements");
  assert.equal(await card.getByLabel("Gets dropped or knocked Front bezel").isChecked(), true);
  assert.equal(await card.getByLabel("Hottest Front bezel").inputValue(), "50");
  await card.getByLabel("Production process Front bezel").selectOption("injection_molding");
  await card.getByLabel("Production material Front bezel").selectOption("pc_abs");
  await card.getByLabel("Production volume Front bezel").fill("5000");
  await card.getByLabel("Prototypes needed Front bezel").fill("3");
  await card.getByLabel("Finish Front bezel").fill("matte black");
  await card.getByRole("button", { name: "Save route" }).click();
  await page.getByText("Front bezel: route saved.").first().waitFor();

  // 2. Suggestions: UV-stable and tough first; choose it.
  const route = page.locator("[data-route='Front bezel']");
  assert.match(await route.innerText(), /40 × 30 × 20 mm, 24 cm³/);
  const first = route.getByTestId("suggestions").locator("tr[data-option]").first();
  const option = await first.getAttribute("data-option");
  assert.ok(["fdm_asa", "mjf_pa12", "mjf_pa11", "cast_abs"].includes(option), `top suggestion: ${option}`);
  assert.doesNotMatch(await route.getByTestId("suggestions").innerText(), /Standard resin|\bPLA\b/, "sun- and drop-sensitive materials are not suggested");
  await route.getByTestId("suggestions").locator("tr[data-option='fdm_asa']").getByRole("button").click();
  await page.getByText("Front bezel: prototype in ASA.").first().waitFor();
  const summary = await page.locator("[data-route='Front bezel']").getByTestId("route-summary").innerText();
  assert.match(summary, /Prototype\s+ASA, 3D printing, FDM \(filament\) × 3 · about 15 to 23 g each/);
  assert.match(summary, /Production\s+Injection molding, PC\/ABS, about 5,000 a year/);
  await shot(page, "01-routes");

  // 3. The 3D-printing export.
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export for 3D printing" }).click()]);
  assert.match(download.suggestedFilename(), /^mfg-\d+-3d-print-\d{4}-\d{2}-\d{2}\.zip$/);
  const files = unzipSync(new Uint8Array(readFileSync(await download.path())));
  assert.deepEqual(Object.keys(files).sort(), ["01-front-bezel/bezel.stl", "PRINT-SHEET.md", "parts.csv"]);
  const sheet = strFromU8(files["PRINT-SHEET.md"]);
  assert.match(sheet, /^## Front bezel$/m);
  assert.match(sheet, /^- \*\*Print in:\*\* ASA, 3D printing, FDM \(filament\)$/m);
  assert.match(sheet, /^- \*\*Colour and finish:\*\* matte black$/m);
  assert.match(sheet, /This print is a fair stand-in for fit, feel and light functional tests/);
  assert.match(strFromU8(files["parts.csv"]), /^Front bezel,bezel\.stl,fdm,ASA,3,matte black,40x30x20,24,15-23$/m);

  // 3b. Injection molding: the design check flags the solid block (no draft, thick), the spec is saved, the package downloads.
  const mold = page.locator("[data-route='Front bezel']").getByTestId("molding");
  if (!(await mold.getAttribute("open") !== null)) await mold.locator("summary").first().click();
  const facts = await mold.getByTestId("molding-facts").innerText();
  assert.match(facts, /Draft\s+\d+(\.\d+)?% of the surface below 1° \(\d+(\.\d+)?% with none\), pulled \+z/);
  assert.match(facts, /Tool\s+SPI Class 104/);
  assert.match(await mold.innerText(), /Fix: .*no draft: add at least 1°/);
  assert.match(await mold.innerText(), /Fix: .*thicker than 3\.5 mm/);
  await mold.getByLabel("Mold finish Front bezel").selectOption("MT-11010");
  await mold.getByLabel("Material grade Front bezel").fill("Cycoloy C2950 or equal");
  await mold.getByLabel("Flammability Front bezel").selectOption("UL94 V-0");
  await mold.getByLabel("Critical dimensions Front bezel").fill("display opening 222.5 ± 0.1");
  await mold.getByRole("button", { name: "Save molding spec" }).click();
  await page.getByText("Molding spec saved.").first().waitFor();
  assert.match(await page.locator("[data-route='Front bezel']").getByTestId("molding-facts").innerText(), /below 2\.5°/, "a light texture needs more draft");
  const [pkg] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "Download the mold maker's package" }).click()]);
  assert.match(pkg.suggestedFilename(), /^mfg-\d+-front-bezel-mold-package-\d{4}-\d{2}-\d{2}\.zip$/);
  const mz = unzipSync(new Uint8Array(readFileSync(await pkg.path())));
  assert.deepEqual(Object.keys(mz).sort(), ["MOLDING-SPEC.md", "cad/bezel.stl", "critical-dimensions.txt", "design-check.csv"]);
  const spec = strFromU8(mz["MOLDING-SPEC.md"]);
  assert.match(spec, /^- \*\*Material:\*\* PC\/ABS, Cycoloy C2950 or equal, UL94 V-0$/m);
  assert.match(spec, /mold finish MT-11010 \(light texture\)/);
  assert.match(spec, /^- \*\*Volume:\*\* about 5,000 a year$/m);
  assert.match(spec, /^- \*\*Prototypes so far:\*\* ASA \(fdm\)/m);
  assert.match(strFromU8(mz["design-check.csv"]), /^error,.*no draft/m);
  await shot(page, "02-molding");

  // 4. The planner reads the route.
  await page.goto(`${P}/inputs`);
  const planCtx = await page.getByTestId("plan-context").locator("pre").textContent();
  assert.match(planCtx, /^- Front bezel: prototype ASA \(fdm\) × 3; production Injection molding, PC\/ABS, about 5,000 a year; finish matte black$/m);
  console.log("Manufacturing flow passed: model upload, needs from requirements, ranked suggestions, chosen material, 3D-print export, route in the plan context.");
} catch (e) {
  if (page && process.env.FAIL_SHOT) await page.screenshot({ path: process.env.FAIL_SHOT, fullPage: true });
  throw e;
} finally {
  await browser.close();
}
