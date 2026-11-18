// End-to-end test of the knowledge base polish.
//  - Fetch: a vendor datasheet page added with "fetch from the official URL" is read and indexed (copy not kept); a
//    re-check finds it unchanged; after the page changes, a re-check re-indexes it and returns it to draft.
//  - OCR: a scanned PDF (image only) is queued, read by the worker's Tesseract, and its excerpts are searchable and
//    marked as OCR text.
//  - Modules: a module without a source for its certification is refused; with sources it is saved and verified;
//    it becomes a trade-study option and is noted on the compliance page when it is in the BOM.
//
// Needs the app started with VX_TEST_FETCH_REWRITE=https://docs.example.test=http://127.0.0.1:4599 (test only), the local
// Supabase stack, and tesseract + pdftoppm for the worker (./scripts/test-e2e-kb-polish.sh).
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
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
const owner = { email: `kbp-${stamp}@example.test`, password: "correct-horse-battery" };

// The "official site": a datasheet page whose content changes once.
let revision = "A";
const pageHtml = () => `<!doctype html><html><head><title>LDO-${stamp} datasheet</title><script>track()</script></head><body><nav>Products</nav>
  <main><h1>LDO-${stamp}</h1><p>Low-dropout regulator, 300 mA, revision ${revision}.</p><h2>Electrical characteristics</h2>
  <ul><li>Dropout ${revision === "A" ? "250" : "230"} mV at 300 mA</li><li>Quiescent current 1 uA</li></ul></main></body></html>`;
const site = createServer((req, res) => {
  if (req.url === "/ldo.html") { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(pageHtml()); return; }
  res.writeHead(404); res.end();
});
await new Promise((r) => site.listen(4599, "127.0.0.1", r));

// A scanned drawing: an image-only PDF.
const scan = join(tmpdir(), `scan-${stamp}.pdf`);
writeFileSync(scan, execFileSync("python3", ["-c", `
import io, sys
from PIL import Image, ImageDraw, ImageFont
img = Image.new("L", (1700, 700), 255); d = ImageDraw.Draw(img)
try: f = ImageFont.truetype("DejaVuSans.ttf", 60)
except Exception: f = ImageFont.load_default()
d.text((80, 120), "ENCLOSURE DRAWING ${String(stamp).slice(-6)}", fill=0, font=f)
d.text((80, 320), "GENERAL TOLERANCE 0.2 MM", fill=0, font=f)
buf = io.BytesIO(); img.save(buf, "PDF", resolution=200); sys.stdout.buffer.write(buf.getvalue())`]));

const browser = await chromium.launch();
const worker = spawn(process.execPath, [join(here, "../../../services/orchestrator/src/main.ts")], {
  env: { ...process.env, WORKER_ID: "kbp-worker", VX_LLM: "offline", VX_ENGINEERING: "off", VX_SOURCING: "off", WORKER_POLL_MS: "500" },
  stdio: ["ignore", "ignore", "inherit"],
});
let page;
try {
  page = await (await browser.newContext({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1 })).newPage();
  await page.goto(`${BASE}/login`);
  await page.getByLabel("Email").fill(owner.email);
  await page.getByLabel("Password").fill(owner.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL(/\/projects$/);
  const api = createClient(URL, ANON, { auth: { persistSession: false } });
  const { data: auth } = await api.auth.signInWithPassword(owner);
  assert.ifError((await admin.from("knowledge_editors").insert({ user_id: auth.user.id, note: "kb polish e2e" })).error);

  // 1. Fetch from the official link.
  await page.goto(`${BASE}/knowledge`);
  const form = page.locator("form", { has: page.getByRole("button", { name: "Add source" }) }).first();
  await form.getByLabel("Publisher").fill("Example Semi");
  await form.getByLabel("Identifier").fill(`LDO-${stamp}`);
  await form.getByLabel("Official URL").fill("https://docs.example.test/ldo.html");
  await form.getByLabel(/Manufacturer document/).check();
  await form.getByLabel("Fetch the document now").check();
  await form.getByRole("button", { name: "Add source" }).click();
  await page.getByText(/Fetched from the official link: \d+ excerpt\(s\) indexed \(web page: text only, no copy kept\)/).waitFor();
  assert.match(await page.getByTestId("fetched").innerText(), /from https:\/\/docs\.example\.test\/ldo\.html on/);
  const excerpts = await page.locator("main").innerText();
  assert.ok(excerpts.includes("Dropout 250 mV at 300 mA") && !excerpts.includes("track()"), "page text indexed without scripts");
  await page.getByLabel("How it was checked").fill("Compared with the publisher's page");
  await page.getByRole("button", { name: "Mark verified" }).click();
  await page.getByText("Verified.").waitFor();
  await page.getByRole("button", { name: "Check the official link for changes" }).click();
  await page.getByText("Checked: the document at the official link is unchanged.").waitFor();
  assert.equal(await page.getByTestId("source-status").innerText(), "verified");
  revision = "B";
  await page.getByRole("button", { name: "Check the official link for changes" }).click();
  await page.getByText(/The document at the official link changed: \d+ excerpt\(s\) re-indexed/).waitFor();
  assert.equal(await page.getByTestId("source-status").innerText(), "draft");
  assert.ok((await page.locator("main").innerText()).includes("Dropout 230 mV"));
  await shot(page, "01-fetched-source");

  // 2. OCR of a scanned PDF.
  await page.goto(`${BASE}/knowledge`);
  await form.getByLabel("Publisher").fill("Example Enclosures");
  await form.getByLabel("Title").fill(`Scanned enclosure drawing ${stamp}`);
  await form.getByLabel(/Open licence/).check();
  await form.locator("input[type=file]").setInputFiles(scan);
  await form.locator("[data-staged=yes]").waitFor();
  await form.getByRole("button", { name: "Add source" }).click();
  await page.getByText(/queued for OCR by the worker/).waitFor();
  const sourceUrl = page.url().split("?")[0];
  for (let i = 0; ; i++) {
    await page.goto(sourceUrl);
    if (/OCR done/.test(await page.getByTestId("text-origin").innerText())) break;
    if (/OCR failed/.test(await page.getByTestId("text-origin").innerText())) throw new Error(await page.getByTestId("text-origin").innerText());
    if (i > 60) throw new Error("OCR did not finish");
    await page.waitForTimeout(1000);
  }
  assert.match(await page.getByTestId("text-origin").innerText(), /OCR done: 1 page\(s\), \d+ excerpt\(s\), mean confidence \d+%/);
  assert.ok((await page.locator("main").innerText()).includes("GENERAL TOLERANCE 0.2 MM"));
  assert.ok((await page.locator("main").innerText()).includes("p. 1 (OCR)"));
  await shot(page, "02-ocr-source");
  await page.goto(`${BASE}/knowledge?q=${encodeURIComponent("general tolerance enclosure drawing")}`);
  assert.ok((await page.locator("main").innerText()).includes(`Scanned enclosure drawing ${stamp}`), "OCR text is searchable");

  // 3. Modules catalog.
  const MPN = `EXR-BLE-${stamp}`;
  await page.goto(`${BASE}/knowledge/modules`);
  const mf = page.getByTestId("module-form");
  // The catalog is shared: earlier runs leave modules, so the add form may start closed.
  if (!(await mf.isVisible())) await page.locator("summary", { hasText: "Add a module" }).click();
  await mf.getByLabel("Module name").fill(`Example BLE module ${stamp}`);
  await mf.getByLabel("Module manufacturer").fill("Example Radio");
  await mf.getByLabel("Module part number").fill(MPN);
  await mf.getByLabel("Radios").fill("Bluetooth LE");
  await mf.getByLabel("Interfaces").fill("UART, SPI");
  await mf.getByLabel("Supply min").fill("1.8");
  await mf.getByLabel("Supply max").fill("3.6");
  await mf.getByLabel("Module source link").fill("https://docs.example.test/exr.html");
  await mf.getByLabel("Certifications").fill("FCC | 2EXR-BLE1");
  await mf.getByRole("button", { name: "Add module" }).click();
  await page.getByText(/certification FCC 2EXR-BLE1: say where it was read/).waitFor();
  await mf.getByLabel("Module name").fill(`Example BLE module ${stamp}`);
  await mf.getByLabel("Module manufacturer").fill("Example Radio");
  await mf.getByLabel("Module part number").fill(MPN);
  await mf.getByLabel("Radios").fill("Bluetooth LE");
  await mf.getByLabel("Module source link").fill("https://docs.example.test/exr.html");
  await mf.getByLabel("Certifications").fill("FCC | 2EXR-BLE1 | https://docs.example.test/grant\nCE RED | DoC 2026-01 | manufacturer DoC PDF");
  await mf.getByRole("button", { name: "Add module" }).click();
  await page.getByText("Module added").waitFor();
  assert.match(await page.getByTestId("module-certs").innerText(), /FCC 2EXR-BLE1 · source[\s\S]*CE RED DoC 2026-01 · manufacturer DoC PDF/);
  await page.getByRole("button", { name: "Verify against the sources" }).click();
  await page.getByText("Verified.").waitFor();
  assert.equal(await page.getByTestId("module-status").innerText(), "verified");
  await page.goto(`${BASE}/knowledge/modules?cert=FCC&q=${MPN}`);
  assert.equal(await page.getByTestId("modules").locator(`tr[data-mpn="${MPN}"]`).count(), 1);
  await shot(page, "03-modules");

  // 4. A trade-study option from the catalog; the compliance page notes the certified module in the BOM.
  const { data: project } = await api.from("projects").insert({ name: `KB polish ${stamp}` }).select("id").single();
  const { data: study } = await api.rpc("create_trade_study", { p_project: project.id, p_question: "Radio: module or chip-down?", p_criteria: [], p_options: [] });
  await page.goto(`${BASE}/projects/${project.id}/trades/${study}`);
  await page.getByLabel("Module to add").selectOption({ label: `Example BLE module ${stamp} (Example Radio ${MPN})` });
  await page.getByRole("button", { name: "Add module as option" }).click();
  await page.getByText(/added as an option from the modules catalog/).waitFor();
  assert.equal(await page.getByLabel("Part number 1").inputValue(), MPN);
  assert.match(await page.getByLabel("Description 1").inputValue(), /certified: FCC 2EXR-BLE1, CE RED DoC 2026-01/);
  const bytes = Buffer.from(JSON.stringify({ lines: [] }));
  const path = `${project.id}/artifacts/${stamp}-bom.json`;
  await admin.storage.from("project-files").upload(path, bytes);
  const { data: art } = await admin.from("artifacts").insert({ project_id: project.id, kind: "bom", name: "s/sourced-bom" }).select("id").single();
  const { data: ver } = await admin.from("artifact_versions").insert({ artifact_id: art.id, project_id: project.id, version: 1, status: "committed", storage_path: path,
    sha256: createHash("sha256").update(bytes).digest("hex"), size_bytes: bytes.length, committed_at: new Date().toISOString() }).select("id").single();
  assert.ifError((await api.rpc("load_bom_parts", { p_project: project.id, p_version: ver.id, p_lines: [{ mpn: MPN, normalized_mpn: MPN, refs: ["U5"], qty_per_board: 1 }] })).error);
  await page.goto(`${BASE}/projects/${project.id}/compliance`);
  assert.match(await page.getByTestId("bom-modules").innerText(), new RegExp(`Example BLE module ${stamp} \\(Example Radio ${MPN}\\): FCC 2EXR-BLE1 · CE RED DoC 2026-01`));
  await shot(page, "04-compliance-modules");
  console.log("KB polish flow passed: fetch with change detection, OCR of a scan, modules catalog, trade-study option, compliance note.");
} catch (e) {
  if (page && process.env.FAIL_SHOT) await page.screenshot({ path: process.env.FAIL_SHOT, fullPage: true });
  throw e;
} finally {
  worker.kill("SIGKILL");
  site.close();
  await browser.close();
}
