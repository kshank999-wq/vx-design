// End-to-end test of assembly instructions.
//  - Drafted (offline stand-in) from a chosen part, a manufacturing route and a reference image used as a figure.
//  - A step is edited (fasteners with torque), steps are moved and added, the checks run again.
//  - The owner approves: the version locks; a revision starts a new draft.
//  - The printable document and the assembler's ZIP (document, figures, steps.csv, bom.csv) are exported.
//
// Needs the app running (VX_LLM=offline) and the local Supabase stack (./scripts/test-e2e-assembly.sh).
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
const { SUPABASE_URL: URL, SUPABASE_SERVICE_ROLE_KEY: SERVICE, SUPABASE_ANON_KEY: ANON } = process.env;
if (!URL || !SERVICE || !ANON) throw new Error("SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and SUPABASE_ANON_KEY are required");
const SHOTS = process.env.SCREENSHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true }); };
const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });
const stamp = Date.now();
const owner = { email: `asm-${stamp}@example.test`, password: "correct-horse-battery" };
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==", "base64");

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
  const { data: project } = await api.from("projects").insert({ name: `Asm ${stamp}`, description: "Touchscreen movie slate" }).select("id").single();
  assert.ifError((await api.rpc("save_project_part", { p_project: project.id, p_id: null, p_mpn: "RVT101HVHNWC00-B", p_manufacturer: "Riverdi",
    p_role: "10.1-inch touchscreen", p_subsystem: "display", p_status: "selected", p_note: null })).error);
  assert.ifError((await api.rpc("save_part_route", { p_project: project.id, p_id: null, p_name: "Enclosure base", p_source_key: null, p_needs: {},
    p_prototype_option: "fdm_asa", p_prototype_qty: 3, p_production_process: "injection_molding", p_production_material: "pc_abs", p_production_volume: 5000,
    p_finish: null, p_notes: null })).error);
  const path = `${project.id}/references/asm-${stamp}.png`;
  assert.ifError((await admin.storage.from("project-files").upload(path, PNG, { contentType: "image/png" })).error);
  assert.ifError((await api.rpc("add_project_reference", { p_project: project.id, p_kind: "photo", p_title: "Open housing", p_note: null,
    p_filename: "open.png", p_path: path, p_sha256: createHash("sha256").update(`${stamp}`).digest("hex"), p_size: PNG.length, p_mime: "image/png" })).error);
  const P = `${BASE}/projects/${project.id}`;

  // 1. Draft.
  await page.goto(P);
  await page.getByRole("link", { name: "Assembly instructions" }).click();
  await page.waitForURL(/\/assembly$/);
  await page.getByLabel("Assembly guidance").fill("Use the bench jig.");
  await page.getByRole("button", { name: "Draft assembly instructions" }).click();
  await page.getByText(/^Draft ready/).first().waitFor();
  assert.equal(await page.getByTestId("assembly").getAttribute("data-status"), "draft");
  assert.equal(await page.getByTestId("assembly-problems").count(), 0, "the offline draft fits every part");
  const steps = page.getByTestId("steps");
  assert.match(await steps.locator("[data-step='1']").innerText(), /1\. Prepare the housing: press heat-set inserts[\s\S]*Parts: 1 × Enclosure base[\s\S]*REF-1 Open housing/);
  assert.match(await steps.locator("[data-step='2']").innerText(), /2\. Fit RVT101HVHNWC00-B/);

  // 2. Edit a step, move it, add one, check again.
  const s2 = steps.locator("[data-step='2']");
  await s2.locator("summary").click();
  await s2.getByLabel("Step 2 fasteners").fill("4 × M2.5 × 6 pan head @ 0.3 N·m (display frame)\n2 × cable clip @ none (snap in)");
  await s2.getByLabel("Step 2 instructions").fill("Lay the display face down on the soft mat.\nScrew the frame to the display.");
  await s2.getByRole("button", { name: "Save step 2" }).click();
  await page.getByText("Step 2 saved.").first().waitFor();
  const fast = await page.getByTestId("steps").locator("[data-step='2']").getByTestId("fasteners").innerText();
  assert.match(fast, /4\s+M2\.5 × 6 pan head\s+0\.3 N·m\s+display frame/);
  assert.match(fast, /2\s+cable clip\s+—\s+snap in/);
  await page.getByTestId("steps").locator("[data-step='2'] summary").click();
  await page.getByTestId("steps").locator("[data-step='2']").getByRole("button", { name: "Move up" }).click();
  await page.getByText("Step moved to position 1.").first().waitFor();
  assert.match(await page.getByTestId("steps").locator("[data-step='1'] h3").innerText(), /Fit RVT101HVHNWC00-B/);
  await page.getByRole("button", { name: "Add a step" }).click();
  await page.getByText("Step 3 added at the end.").first().waitFor();
  await page.getByRole("button", { name: "Check again" }).click();
  await page.getByText(/^Checks pass/).first().waitFor();
  await shot(page, "01-draft");

  // 3. Approve; locked; revise.
  await page.getByRole("button", { name: "Approve this version" }).click();
  await page.getByText(/^Approved\. This version is locked/).first().waitFor();
  assert.equal(await page.getByTestId("assembly").getAttribute("data-status"), "approved");
  assert.equal(await page.getByRole("button", { name: "Add a step" }).count(), 0, "an approved version cannot be edited");

  // 4. Exports.
  const { data: v1 } = await admin.from("assembly_instructions").select("id").eq("project_id", project.id).eq("status", "approved").single();
  const html = await (await page.request.get(`${P}/assembly/${v1.id}/export?format=html`)).text();
  assert.match(html, /<title>Asm \d+: assembly instructions v1<\/title>/);
  assert.match(html, /version 1 · Approved \d{4}-\d{2}-\d{2} · 3 steps/);
  assert.match(html, /<td class="q">4<\/td><td>M2\.5 × 6 pan head<\/td><td>0\.3 N·m/);
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "Download for the assembler" }).click()]);
  assert.match(download.suggestedFilename(), /^asm-\d+-assembly-v1\.zip$/);
  const files = unzipSync(new Uint8Array(readFileSync(await download.path())));
  assert.deepEqual(Object.keys(files).sort(), ["assembly-instructions.html", "bom.csv", "figures/REF-1.png", "steps.csv"]);
  assert.match(strFromU8(files["assembly-instructions.html"]), /<img src="figures\/REF-1\.png"/);
  assert.match(strFromU8(files["bom.csv"]), /^4,M2\.5 × 6 pan head,fastener$/m);
  assert.match(strFromU8(files["steps.csv"]), /^1,Fit RVT101HVHNWC00-B,1 x RVT101HVHNWC00-B,4 x M2\.5 × 6 pan head @ 0\.3 N·m; 2 x cable clip,/m);
  await page.getByRole("button", { name: "Start a revision" }).click();
  await page.getByText(/^Revision started/).first().waitFor();
  assert.equal(await page.getByTestId("assembly").getAttribute("data-status"), "draft");
  assert.match(await page.getByTestId("versions").innerText(), /v2 · draft[\s\S]*v1 · approved/);
  await shot(page, "02-revision");
  console.log("Assembly flow passed: drafted from parts, routes and a figure; edited, moved, added, rechecked; approved and locked; exported; revised.");
} catch (e) {
  if (page && process.env.FAIL_SHOT) await page.screenshot({ path: process.env.FAIL_SHOT, fullPage: true });
  throw e;
} finally {
  await browser.close();
}
