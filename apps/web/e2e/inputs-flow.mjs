// End-to-end test of project inputs.
//  - Two specifications uploaded at once and extracted together; a requirement that both state is flagged.
//  - A mock-up (image) as a reference and a prior-design file under prior work; a Flux audit as prior work.
//  - A part already chosen, with its datasheet and STEP model attached; the earlier-work register reviewed and corrected.
//  - The plan is generated from all of it: it cites REF-1, PW-1 and PR-1, and tasks say whether they adapt earlier work.
//  - A reference left out of the plan disappears from what the planner reads; a concept round takes the mock-up.
//
// Needs the app running (VX_LLM=offline) and the local Supabase stack (./scripts/test-e2e-inputs.sh).
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
const { SUPABASE_URL: URL, SUPABASE_SERVICE_ROLE_KEY: SERVICE, SUPABASE_ANON_KEY: ANON } = process.env;
if (!URL || !SERVICE || !ANON) throw new Error("SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and SUPABASE_ANON_KEY are required");
const SHOTS = process.env.SCREENSHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true }); };
const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });
const stamp = Date.now();
const owner = { email: `inputs-${stamp}@example.test`, password: "correct-horse-battery" };

const SPEC_MAIN = `# Slate main board\n\n## Display\n\nThe slate shall show timecode on a 7 inch touchscreen readable at 3 m.\n\n## Power\n\nThe slate shall run for 8 hours from a replaceable battery.\n`;
const SPEC_TC = `# Timecode board\n\n## Timing\n\nThe slate shall show timecode on a 7 inch touchscreen readable at 3 m.\n\nThe timecode board shall keep time within 1 frame over 24 hours without the main computer.\n`;
// A 2 × 2 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==", "base64");
/** A one-page PDF with real text (what a datasheet reader extracts). */
function textPdf(lines) {
  const ops = lines.map((l, j) => `BT /F1 12 Tf 72 ${720 - j * 24} Td (${l}) Tj ET`).join("\n");
  const objects = [null, "<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${ops.length} >>\nstream\n${ops}\nendstream`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  let out = "%PDF-1.4\n"; const off = [];
  for (let i = 1; i < objects.length; i++) { off[i] = out.length; out += `${i} 0 obj\n${objects[i]}\nendobj\n`; }
  const x = out.length;
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n${off.slice(1).map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  return out + `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
}
const PDF = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n");

const AUDIT = {
  current: {
    revision: "2026-11-20",
    components: [
      { designator: "U1", mpn: "STM32L476RGT6", manufacturer: "STMicroelectronics", value: null, design: { role: "Timecode MCU", details: "Autonomous LTC" } },
      { designator: "Y1", mpn: "SiT5356AI-FQ-33E0-10.000000", manufacturer: "SiTime", value: null, design: { role: "Clock Source", details: "10 MHz TCXO" } },
    ],
    connectors: [], power_rails: [{ net: "GND" }, { net: "TC_3V3" }], board: { width_mm: 160, height_mm: 100, thickness_mm: 1.46, copper_layers: 4 },
  },
  findings: [{ severity: "warning", title: "The layout is not routed", category: "routing" }],
  history: { decisions: [], claims: [] }, migration: [{ title: "Route the board", scope: "The parts are placed but no copper is routed." }],
};

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
  const { data: project } = await api.from("projects").insert({ name: `Inputs ${stamp}`, description: "Touchscreen movie slate" }).select("id").single();
  const P = `${BASE}/projects/${project.id}`;
  // A finished Flux audit to build on.
  const reportPath = `${project.id}/flux/e2e/report-${stamp}.json`;
  assert.ifError((await admin.storage.from("project-files").upload(reportPath, Buffer.from(JSON.stringify(AUDIT)), { contentType: "application/json" })).error);
  assert.ifError((await admin.from("flux_audits").insert({ project_id: project.id, audit_no: 1, title: "VC Smart Slate", status: "ready", report_path: reportPath, report_md_path: reportPath.replace(".json", ".md"),
    summary: { components: 2, blockers: 0, warnings: 1 }, completed_at: new Date().toISOString() })).error);

  // 1. Two specifications at once, extracted together.
  await page.goto(`${P}`);
  await page.getByTestId("inputs-link").getByRole("link", { name: "Project inputs" }).click();
  await page.waitForURL(/\/inputs$/);
  await page.getByLabel("Specification files").setInputFiles([
    { name: "main-board.md", mimeType: "text/markdown", buffer: Buffer.from(SPEC_MAIN) },
    { name: "timecode-board.md", mimeType: "text/markdown", buffer: Buffer.from(SPEC_TC) },
  ]);
  await page.getByRole("button", { name: "Upload specifications" }).click();
  const st = page.getByTestId("upload-specification-status");
  await st.getByText(/^main-board\.md: \d+ sections$/).waitFor();
  await st.getByText(/^timecode-board\.md: \d+ sections$/).waitFor();
  await page.getByRole("button", { name: "Extract requirements from 2 document(s)" }).waitFor();
  await page.getByRole("button", { name: "Extract requirements from 2 document(s)" }).click();
  await page.getByText(/^Extracted \d+ requirement\(s\) from 2 document\(s\)\.$/).waitFor();
  assert.equal(await page.getByTestId("specs").locator("tr[data-status='done']").count(), 2);
  const { data: refs } = await admin.from("requirements").select("ref_code").eq("project_id", project.id);
  assert.equal(new Set(refs.map((r) => r.ref_code)).size, refs.length, "numbering continues across documents");
  assert.match(await page.getByTestId("duplicates").innerText(), /1 requirement\(s\) appear in more than one document/);
  await shot(page, "01-specs");

  // 2. References: a mock-up (step 2) and a prior-design file (step 4).
  await page.getByRole("link", { name: "Continue: Mock-ups →" }).click();
  await page.waitForURL(/inputs\?step=2/);
  const up = page.getByTestId("upload-reference");
  await up.getByLabel("Reference kind").selectOption("mockup");
  await up.getByLabel("Reference title").fill("Front view");
  await up.getByLabel("Reference note").fill("7 inch screen, clapper bar on top, three buttons on the right");
  await up.getByLabel("Reference files").setInputFiles([{ name: "front.png", mimeType: "image/png", buffer: PNG }]);
  await up.getByRole("button", { name: "Add references" }).click();
  await page.getByTestId("upload-reference-status").getByText("front.png: added").waitFor();
  await page.goto(`${P}/inputs?step=4`);
  const pu = page.getByTestId("upload-prior");
  await pu.getByLabel("Prior-work title").fill("Old slate schematic");
  await pu.getByLabel("Prior-work files").setInputFiles([{ name: "old-slate.pdf", mimeType: "application/pdf", buffer: PDF }]);
  await pu.getByRole("button", { name: "Add prior-work files" }).click();
  await page.getByTestId("upload-prior-status").getByText("old-slate.pdf: added").waitFor();
  await page.reload();
  assert.match(await page.getByTestId("prior-files").locator("[data-ref='REF-2']").innerText(), /Old slate schematic\s+Prior design/);
  await page.goto(`${P}/inputs?step=2`);
  const cards = page.getByTestId("references");
  assert.equal(await cards.locator("[data-ref='REF-1'] img").count(), 1, "the mock-up shows as an image");
  assert.equal(await cards.locator("[data-ref='REF-2']").count(), 0, "prior-work files are not shown with the mock-ups");
  // A refused file: SVG can carry script.
  await up.getByLabel("Reference files").setInputFiles([{ name: "x.svg", mimeType: "image/svg+xml", buffer: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>") }]);
  await up.getByRole("button", { name: "Add references" }).click();
  await page.getByTestId("upload-reference-status").getByText(/^x\.svg: This file was not accepted/).waitFor();
  await shot(page, "02-references");

  // 2b. Parts already chosen, from their files: the datasheet gives the part, the STEP model is matched to it by the number inside.
  await page.goto(`${P}/inputs?step=3`);
  const pf = page.getByTestId("part-files");
  const STEP = Buffer.from("ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('display_model','2024-01-01',(''),(''),'','','');\nENDSEC;\nDATA;\n#1=PRODUCT('RVT101HVHNWC00-B','RVT101HVHNWC00-B 3D','',(#2));\nENDSEC;\nEND-ISO-10303-21;\n");
  await pf.getByLabel("Part files").setInputFiles([
    { name: "riverdi-datasheet.pdf", mimeType: "application/pdf", buffer: Buffer.from(textPdf(["Riverdi display module", "Part number: RVT101HVHNWC00-B", "Manufacturer: Riverdi",
      "Description: 10.1 inch IPS TFT display with capacitive touch", "Resolution: 1280 x 800", "Supply voltage: 3.3 V"])) },
    { name: "display_model.step", mimeType: "application/step", buffer: STEP },
    { name: "bracket.step", mimeType: "application/step", buffer: Buffer.from(STEP.toString().replace(/RVT101HVHNWC00-B/g, "BRKT").replace("display_model", "bracket")) },
  ]);
  await pf.getByRole("button", { name: "Upload and read the files" }).click();
  await page.getByTestId("upload-partfiles-status").getByText(/^Found 1 part\(s\): RVT101HVHNWC00-B \(Riverdi\)\. Attached 1 model file\(s\)\.$/).waitFor();
  await page.reload();
  const row = page.getByTestId("parts-display").locator("tr[data-part='RVT101HVHNWC00-B']");
  const files = await row.innerText();
  assert.match(files, /Riverdi[\s\S]*10\.1 inch IPS TFT display with capacitive touch[\s\S]*2 key specs[\s\S]*Selected/);
  assert.match(files, /Datasheet\s+riverdi-datasheet\.pdf/);
  assert.match(files, /3D model \(STEP or STL\)\s+display_model\.step/);
  // The bracket model matches no part: a person places it.
  const un = page.getByTestId("unplaced-files").locator("[data-file='bracket.step']");
  assert.match(await un.innerText(), /no part number of a listed part found/);
  await un.getByLabel("Part for bracket.step").selectOption({ label: "RVT101HVHNWC00-B" });
  await un.getByRole("button", { name: "Place" }).click();
  await page.getByText("File attached.").first().waitFor();
  assert.equal(await page.getByTestId("unplaced-files").count(), 0);
  // Typing a part by hand is still possible; the same part number cannot be listed twice.
  await page.getByTestId("add-part").locator("summary").click();
  await page.getByTestId("add-part").getByLabel("Part number").fill("rvt101hvhnwc00b");
  await page.getByTestId("add-part").getByLabel("What it is for").fill("duplicate");
  await page.getByTestId("add-part").getByRole("button", { name: "Add part" }).click();
  await page.getByText(/already listed/).waitFor();
  await shot(page, "02b-parts");

  // 2c. The earlier-work register (a worker builds it; here it is stored as a worker would) is reviewed and corrected.
  await page.goto(`${P}/inputs?step=4`);
  assert.equal(await page.getByTestId("prior-files").locator("[data-ref]").count(), 1, "part files stay with the part");
  await page.getByRole("button", { name: "Build the list of earlier work" }).click();
  await page.getByTestId("register-building").waitFor();
  const { data: reg } = await admin.from("prior_work_registers").select("id").eq("project_id", project.id).single();
  assert.ifError((await admin.from("prior_work_registers").update({ status: "ready", completed_at: new Date().toISOString(), model: "offline",
    sources: [{ file: "Display Study.md", origin: "Flux import #1", chars: 4000, items: 2 }],
    items: [
      { id: "PR-1", key: "display:mpn:RVT101HVHNWC00B", subsystem: "display", kind: "part", title: "10.1-inch front touchscreen", detail: "IPS, PCAP touch",
        mpn: "RVT101HVHNWC00-B", manufacturer: "Riverdi", status: "selected", issues: ["frame freeze blocked"], stated_by_owner: true,
        sources: [{ file: "parts chosen (entered by the owner)", origin: "owner", quote: "RVT101HVHNWC00-B" }, { file: "Display Study.md", origin: "Flux import #1", quote: "Riverdi RVT101HVHNWC00-B" }] },
      { id: "PR-2", key: "timecode:mpn:DS3231", subsystem: "timecode", kind: "part", title: "RTC", detail: "Real-time clock", mpn: "DS3231", manufacturer: null,
        status: "designed", issues: [], sources: [{ file: "Old Basis.md", origin: "Flux import #1", quote: "DS3231 RTC" }] },
    ] }).eq("id", reg.id)).error);
  await page.reload();
  assert.match(await page.getByTestId("register-summary").innerText(), /^2 item\(s\) from 1 document\(s\).*· 2 the plan must address/);
  assert.match(await page.getByTestId("register-display").locator("tr[data-item='PR-1']").innerText(), /Selected[\s\S]*RVT101HVHNWC00-B 10\.1-inch front touchscreen[\s\S]*Issues: frame freeze blocked/);
  const pr2 = page.getByTestId("register-timecode").locator("tr[data-item='PR-2']");
  await pr2.locator("summary").click();
  await pr2.getByLabel("Note PR-2").fill("replaced by the TCXO");
  await pr2.getByLabel("Leave out PR-2").check();
  await pr2.getByRole("button", { name: "Save PR-2" }).click();
  await page.getByText("PR-2 saved.").waitFor();
  assert.match(await page.getByTestId("register-summary").innerText(), /1 the plan must address · 1 left out/);

  // 3. What the planner reads, and the plan.
  await page.reload();
  assert.match(await page.getByTestId("prior-work").innerText(), /Flux audit #1 VC Smart Slate\s+ready\s+2 parts, 0 blocker\(s\), 1 warning\(s\)\s+yes/);
  await page.getByRole("link", { name: "Continue: Plan →" }).click();
  await page.waitForURL(/inputs\?step=5/);
  const ctx = await page.getByTestId("plan-context").locator("pre").textContent();
  assert.match(ctx, /^- \[REF-1\] Front view \(mockup, file front\.png\): 7 inch screen, clapper bar on top, three buttons on the right$/m);
  assert.match(ctx, /^Prior work \[PW-1\] Flux audit #1: VC Smart Slate, revision 2026-11-20/m);
  assert.match(ctx, /^- board: 160 × 100 mm, 1\.46 mm thick, 4 copper layers; parts placed but NOT routed$/m);
  assert.match(ctx, /^ {2}- \[PR-1\] \(selected, owner\) part: RVT101HVHNWC00-B \(Riverdi\) — 10\.1-inch front touchscreen\./m);
  assert.doesNotMatch(ctx, /DS3231/, "a left-out item is not given to the planner");
  await page.getByRole("button", { name: "Generate plan from these inputs" }).click();
  await page.waitForURL(/\/plans\//);
  assert.match(await page.getByTestId("built-from").innerText(), /Built on REF-1 Front view \(mockup\); REF-2 Old slate schematic \(prior design\); PW-1 Flux audit #1: VC Smart Slate; the earlier-work register \(1 item\(s\), PR-1 onwards\);/);
  assert.match(await page.locator("li.task", { hasText: "System and component architecture" }).getByTestId("basis").innerText(),
    /^adapts PW-1, REF-2, PR-1 RVT101HVHNWC00-B 10\.1-inch front touchscreen \(selected\) Continue the earlier work/);
  const schematic = page.locator("li.task", { hasText: "Schematic capture" }).getByTestId("basis");
  assert.equal(await schematic.getAttribute("data-mode"), "adapt");
  assert.match(await schematic.innerText(), /^adapts PW-1, REF-2 Start from the prior design/);
  assert.match(await page.locator("li.task", { hasText: "Mechanical envelope" }).getByTestId("basis").innerText(), /^adapts REF-1 /);
  assert.match(await page.locator("li.task", { hasText: "Preliminary power budget" }).getByTestId("basis").innerText(), /^starts fresh/);
  await shot(page, "03-plan");

  // 4. Leave a reference out; use the mock-up for concepts.
  await page.goto(`${P}/inputs?step=4`);
  const r2 = page.getByTestId("prior-files").locator("[data-ref='REF-2']");
  await r2.locator("summary").click();
  await r2.getByLabel("Use REF-2 in the plan").uncheck();
  const before = await page.evaluate(() => window.scrollY);
  await r2.getByRole("button", { name: "Save" }).click();
  await page.getByText("Reference saved.").waitFor();
  await page.getByTestId("toast").waitFor();
  assert.ok(await page.evaluate(() => window.scrollY) > Math.min(before, 300) - 50, "the page stays where it was after a form is sent");
  assert.equal(await page.getByTestId("toast").getAttribute("data-text"), "Reference saved.");
  assert.equal(await page.getByTestId("input-step").getAttribute("data-step"), "4", "the form returns to the step it was sent from");
  await page.goto(`${P}/inputs?step=5`);
  assert.doesNotMatch(await page.getByTestId("plan-context").locator("pre").textContent(), /REF-2/);
  await page.goto(`${P}/concepts`);
  await page.getByLabel("Use REF-1 Front view").check();
  await page.getByLabel("Direction").fill("Brushed aluminium, rubber grip");
  await page.getByRole("button", { name: "Generate concepts" }).click();
  await page.getByText(/Concepts requested/).waitFor();
  const { data: round } = await admin.from("concept_rounds").select("reference_ids").eq("project_id", project.id).single();
  const { data: ref1 } = await admin.from("project_references").select("id").eq("project_id", project.id).eq("ref_no", 1).single();
  assert.deepEqual(round.reference_ids, [ref1.id]);
  await admin.from("concept_rounds").update({ status: "canceled" }).eq("project_id", project.id);

  // 5. A Flux export dropped on the specifications box is pointed to prior work; a Flux import runs from this page.
  await page.goto(`${P}/inputs?step=1`);
  await page.getByLabel("Specification files").setInputFiles([{ name: "vc-smart-slate - Flux project data.zip", mimeType: "application/zip", buffer: Buffer.from("PK\x03\x04") }]);
  await page.getByRole("button", { name: "Upload specifications" }).click();
  await page.getByTestId("upload-specification-status").getByText(/this looks like a Flux or CAD export, not a specification\. Add it under 4\. Prior work/).waitFor();
  await page.goto(`${P}/inputs?step=4`);
  await page.getByTestId("flux-start").getByLabel("Flux import title").fill("Timecode board");
  await page.getByRole("button", { name: "Start a Flux import" }).click();
  await page.getByText("Flux import started.").waitFor();
  const fu = page.getByTestId("flux-open").getByTestId("flux-upload");
  await fu.getByLabel("Revision", { exact: true }).fill("2026-11-20");
  await fu.getByLabel("Files", { exact: true }).setInputFiles([{ name: "board.d356", mimeType: "text/plain", buffer: Buffer.from("P  JOB   x\n327GND              U1    -1         A01X-030947Y-010857X0291Y1098R090 S2\n999\n") }]);
  await fu.getByRole("button", { name: "Upload" }).click();
  await fu.getByTestId("upload-status").getByText("board.d356: added").waitFor();
  await page.getByTestId("flux-open").getByText(/1 file\(s\) added/).waitFor();
  await page.getByRole("button", { name: "Run the audit" }).click();
  await page.getByText(/Audit requested/).waitFor();
  await page.getByTestId("flux-running").waitFor();
  await page.locator(".live-dot").waitFor();   // the page refreshes itself while the audit runs
  await shot(page, "04-flux-import");
  console.log("Inputs flow passed: two specs extracted together with a duplicate flagged, references, prior work, plan built on REF/PW with task basis, concepts from a mock-up, Flux import from the inputs page.");
} catch (e) {
  if (page && process.env.FAIL_SHOT) await page.screenshot({ path: process.env.FAIL_SHOT, fullPage: true });
  throw e;
} finally {
  await browser.close();
}
