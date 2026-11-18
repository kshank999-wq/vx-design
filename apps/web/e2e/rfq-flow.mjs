// End-to-end test of manufacturers and RFQ (M-RFQ). In the browser, the owner adds and verifies a supplier and confirms
// its contact; prepares an RFQ (manifest, one requirement and one approved file to disclose); a worker builds the
// packet; the owner approves the disclosure and releases it. The supplier signs up with the contact's address, finds
// the RFQ in the supplier portal, downloads the packet (checked byte for byte) and quotes; the owner compares and
// chooses the quote. Along the way: candidate suppliers and unconfirmed contacts cannot be used, other suppliers and
// clients see nothing, nothing undisclosed is in the packet, and every step is in the audit log.
//
// Needs the app running and the local Supabase stack (./scripts/test-e2e-rfq.sh).
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const orch = createRequire(join(here, "../../../services/orchestrator/package.json"));
const { createClient } = orch("@supabase/supabase-js");
const { unzipSync } = orch("fflate");

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const { SUPABASE_URL: URL, SUPABASE_SERVICE_ROLE_KEY: SERVICE, SUPABASE_ANON_KEY: ANON } = process.env;
if (!URL || !SERVICE || !ANON) throw new Error("SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and SUPABASE_ANON_KEY are required");
const SHOTS = process.env.SCREENSHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });
const stamp = Date.now();
const pw = "correct-horse-battery";
const owner = { email: `rfq-owner-${stamp}@example.test`, password: pw };
const supplier = { email: `quotes-${stamp}@acme-boards.example`, password: pw };
const rival = { email: `sales-${stamp}@rival.example`, password: pw };
const client = { email: `rfq-client-${stamp}@example.test`, password: pw };
const sha = (b) => createHash("sha256").update(b).digest("hex");
const SUPPLIER = `Acme Boards ${stamp}`;

let step = 0;
async function shot(page, name) {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${String(++step).padStart(2, "0")}-${name}.png`), fullPage: true });
}
async function signUp(page, who) {
  await page.goto(`${BASE}/login`);
  await page.getByLabel("Email").fill(who.email);
  await page.getByLabel("Password").fill(who.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL(/\/projects$/);
  return apiAs(who);
}
async function apiAs(who) {
  const api = createClient(URL, ANON, { auth: { persistSession: false } });
  assert.ifError((await api.auth.signInWithPassword(who)).error);
  return api;
}
async function apiSignUp(who) {
  const api = createClient(URL, ANON, { auth: { persistSession: false } });
  assert.ifError((await api.auth.signUp(who)).error);
  return apiAs(who);
}

const browser = await chromium.launch();
const worker = spawn(process.execPath, [join(here, "../../../services/orchestrator/src/main.ts")], {
  env: { ...process.env, WORKER_ID: "rfq-worker", VX_LLM: "offline", VX_IMAGES: "off", VX_ENGINEERING: "off", VX_SOURCING: "off", WORKER_POLL_MS: "500" },
  stdio: ["ignore", "ignore", "inherit"],
});
const ctxOpts = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1 };
try {
  const opage = await (await browser.newContext(ctxOpts)).newPage();
  const o = await signUp(opage, owner);
  const { data: project } = await o.from("projects").insert({ name: `Smart Slate RFQ ${stamp}`, description: "Wireless timecode slate" }).select("id").single();
  await o.from("requirements").insert([
    { project_id: project.id, ref_code: "REQ-ELEC-001", kind: "electrical", priority: "must", text: "The board shall run from a 5 V USB-C supply." },
    { project_id: project.id, ref_code: "REQ-COST-001", kind: "cost", priority: "must", text: "Target bill of materials below 38 USD (confidential)." },
  ]);
  // An approved design file (as a finished fab-package task would leave it).
  const fabZip = new TextEncoder().encode(`fab package ${stamp}: gerbers, drill, CPL, BOM`);
  const fabPath = `${project.id}/artifacts/fab-${stamp}.zip`;
  assert.ifError((await admin.storage.from("project-files").upload(fabPath, fabZip, { contentType: "application/zip" })).error);
  const { data: art } = await admin.from("artifacts").insert({ project_id: project.id, kind: "fab_package", name: "timecode/fab-package" }).select("id").single();
  const { data: ver } = await admin.from("artifact_versions").insert({ artifact_id: art.id, project_id: project.id, version: 1, status: "committed",
    storage_path: fabPath, sha256: sha(fabZip), size_bytes: fabZip.length, tool_name: "test" }).select("id").single();
  const c = await apiSignUp(client);
  assert.equal((await o.rpc("invite_member", { p_project_id: project.id, p_email: client.email, p_role: "client" })).data, "added");

  // 1. The owner adds a supplier, verifies it and confirms the contact (never guessed).
  await opage.goto(`${BASE}/projects`);
  await opage.locator(".topbar").getByRole("link", { name: "Suppliers" }).click();
  await opage.waitForURL(/\/suppliers$/);
  assert.ok(await opage.getByTestId("suppliers").locator("tr[data-name='JLCPCB']").count(), "discovery list is there");
  await opage.locator("summary", { hasText: "Add a supplier" }).click();
  await opage.getByLabel("Name", { exact: true }).fill(SUPPLIER);
  await opage.getByLabel("Website (https)").fill("https://acme-boards.example");
  await opage.getByLabel("PCB assembly (SMT) and test").check();
  await opage.getByLabel("Legal name (as registered)").fill("Acme Boards Ltd");
  await opage.getByLabel("Country (ISO code, e.g. CN, US, GB)").fill("gb");
  await opage.getByLabel("Processes (one per line)").fill("2-6 layer FR-4\nSMT assembly, 0402 and up");
  await opage.getByRole("button", { name: "Add supplier" }).click();
  await opage.getByText(/Added as a candidate/).waitFor();
  assert.match(await opage.getByTestId("mfr-status").innerText(), /Candidate/);
  await opage.getByLabel("How was this confirmed?").fill("Company register entry and capability page");
  await opage.getByRole("button", { name: "Verify supplier" }).click();
  await opage.getByText("Verified.", { exact: true }).waitFor();
  assert.match(await opage.getByTestId("mfr-status").innerText(), /^Verified$/);
  const contactForm = opage.locator("form", { has: opage.getByRole("heading", { name: "Add a contact" }) });
  await contactForm.getByLabel("Name", { exact: true }).fill("Quotes desk");
  await contactForm.getByLabel("Email").fill(supplier.email);
  await contactForm.getByRole("button", { name: "Add contact" }).click();
  await opage.getByText(/Contact added/).waitFor();
  assert.equal(await opage.getByTestId("verify-contact").count(), 1, "new contact shows verify contact");
  await shot(opage, "supplier-verify-contact");
  const mfrUrl = opage.url().split("?")[0];
  console.log("✓ supplier added and verified; contact marked \"verify contact\"");

  // 2. The RFQ: the unconfirmed contact cannot be chosen.
  await opage.goto(`${BASE}/projects/${project.id}`);
  await opage.getByRole("link", { name: "RFQs" }).click();
  await opage.getByLabel("Title").fill("Timecode board, 5 assembled");
  await opage.getByLabel("Category").selectOption("pcba");
  await opage.getByRole("button", { name: "Create RFQ" }).click();
  await opage.getByText(/RFQ drafted/).waitFor();
  const rfqUrl = opage.url().split("?")[0];
  const rfqId = rfqUrl.split("/").pop();
  const opt = opage.getByLabel("Supplier contact").locator("option", { hasText: SUPPLIER });
  assert.equal(await opt.getAttribute("disabled"), "", "unconfirmed contact is not selectable");
  assert.match(await opt.innerText(), /\(verify contact\)/);
  assert.equal(await opage.getByLabel("Supplier contact").locator("option", { hasText: "JLCPCB" }).count(), 0, "candidates are not offered");
  await opage.goto(mfrUrl);
  await opage.getByLabel("How Quotes desk's email was confirmed").fill("Reply received from the address, 18 Nov 2026");
  await opage.getByRole("button", { name: "Confirm email" }).click();
  await opage.getByText("Email confirmed.").waitFor();
  console.log("✓ candidate suppliers and unconfirmed contacts cannot receive an RFQ");

  // 3. Manifest, disclosure choices, supplier.
  await opage.goto(rfqUrl);
  assert.match(await opage.getByTestId("missing").innerText(), /project code, buyer company, classification/);
  await opage.getByLabel("Project code (what suppliers see instead of the project name)").fill("SLATE");
  await opage.getByLabel("Buyer company").fill("VX Design");
  await opage.getByLabel("Buyer contact").fill("Pat Owner");
  await opage.getByLabel("Classification").fill("Prototype PCB assembly, 4-layer");
  await opage.getByLabel("Drawing revision").fill("A");
  await opage.getByLabel("Production quantity").fill("500");
  const due = new Date(Date.now() + 14 * 86400_000).toISOString().slice(0, 10);
  await opage.getByLabel("Response deadline").fill(due);
  await opage.getByLabel("Shipping terms (Incoterm and place)").fill("DAP, London");
  await opage.getByLabel("Standards (one per line)").fill("IPC-A-610 Class 2");
  await opage.getByLabel("Critical-to-quality dimensions (feature | nominal | tolerance)").fill("Board outline | 60 x 40 mm | ±0.2 mm");
  await opage.getByLabel(/REQ-ELEC-001/).check();
  await opage.getByRole("button", { name: "Save manifest" }).click();
  await opage.getByText("Manifest saved.").waitFor();
  assert.match(await opage.getByTestId("missing").innerText(), /^Missing: at least one design file$/);
  await opage.getByLabel(/timecode\/fab-package v1/).check();
  await opage.getByRole("button", { name: "Save files" }).click();
  await opage.getByText("Files to disclose saved.").waitFor();
  await opage.getByLabel("Supplier contact").selectOption({ label: `${SUPPLIER}: Quotes desk <${supplier.email}>` });
  await opage.getByRole("button", { name: "Add supplier" }).click();
  await opage.getByText("Supplier added.").waitFor();
  console.log("✓ manifest complete; one requirement and one approved file chosen; supplier added");

  // 4. The packet: built by the worker, holding exactly what was chosen.
  await opage.getByRole("button", { name: "Build packet" }).click();
  await opage.getByTestId("rfq-status").filter({ hasText: "Packet ready" }).waitFor({ timeout: 60_000 });
  const packetSha = await opage.getByTestId("packet-sha").innerText();
  const zipBytes = new Uint8Array(await (await fetch(await opage.getByRole("link", { name: "Download SLATE-RFQ-001.zip" }).getAttribute("href"))).arrayBuffer());
  assert.equal(sha(zipBytes), packetSha);
  const zip = unzipSync(zipBytes);
  const names = Object.keys(zip).sort();
  assert.deepEqual(names, ["00-README.txt", "01-cover-letter.md", "02-rfq-manifest.json", "02-rfq-manifest.md", "03-nda-template.md",
    "04-requirements.md", "SHA256SUMS", "files/timecode-fab-package-v1.zip"].map((n) => `SLATE-RFQ-001/${n}`).sort());
  assert.equal(sha(zip["SLATE-RFQ-001/files/timecode-fab-package-v1.zip"]), sha(fabZip), "the approved file, byte for byte");
  const all = new TextDecoder().decode(Object.values(zip).reduce((a, b) => new Uint8Array([...a, ...b])));
  assert.match(all, /REQ-ELEC-001/);
  assert.doesNotMatch(all, /REQ-COST-001|below 38 USD/, "undisclosed requirement is not in the packet");
  assert.doesNotMatch(all, new RegExp(`Smart Slate RFQ ${stamp}|${supplier.email}`), "no project name and no supplier contacts in the packet");
  assert.match(new TextDecoder().decode(zip["SLATE-RFQ-001/03-nda-template.md"]), /Template for legal review/);
  console.log(`✓ packet ${packetSha.slice(0, 12)}: 8 files, only the chosen requirement and file, no project name or contacts`);

  // 5. Owner approval of exactly this packet, then release.
  await shot(opage, "rfq-approval");
  await opage.getByLabel("Approval note").fill("Drawings only; NDA not needed to quote");
  await opage.getByRole("button", { name: "Approve disclosure" }).click();
  await opage.getByText(/Disclosure approved/).waitFor();
  await opage.getByLabel("Access window (days)").fill("14");
  await opage.getByRole("button", { name: "Release to suppliers" }).click();
  await opage.getByText(/Released/).waitFor();
  await opage.getByTestId("emails").locator("summary").first().click();
  const draft = await opage.getByTestId("email-draft").first().innerText();
  assert.match(draft, /Subject: SLATE-RFQ-001: request for quotation/);
  assert.match(draft, new RegExp(`${BASE.replace(/[/.:]/g, "\\$&")}/supplier`));
  assert.match(draft, new RegExp(supplier.email.replace(/[.]/g, "\\.")));
  console.log("✓ owner approved the packet and released it; email drafted for the owner to send");

  // 6. Isolation: another supplier, the client, and no direct table access.
  const r = await apiSignUp(rival);
  assert.deepEqual((await r.rpc("supplier_rfqs")).data, [], "other suppliers see nothing");
  assert.equal((await r.from("manufacturers").select("id")).data.length, 0, "suppliers do not see the directory");
  const { data: rfqRow } = await admin.from("rfqs").select("packet_path").eq("id", rfqId).single();
  assert.ok((await r.storage.from("project-files").download(rfqRow.packet_path)).error, "other suppliers cannot download the packet");
  assert.equal((await c.from("rfqs").select("id").eq("project_id", project.id)).data.length, 0, "clients do not see RFQs");
  console.log("✓ other suppliers and clients see nothing");

  // 7. The supplier signs up with the contact's address and quotes.
  const spage = await (await browser.newContext({ ...ctxOpts, acceptDownloads: true })).newPage();
  await signUp(spage, supplier);
  await spage.getByTestId("supplier-invites").getByRole("link", { name: "Open the supplier portal" }).click();
  await spage.waitForURL(/\/supplier$/);
  const card = spage.getByTestId("supplier-rfq");
  assert.equal(await card.getAttribute("data-ref"), "SLATE-RFQ-001");
  const text = await spage.locator("main").innerText();
  assert.doesNotMatch(text, new RegExp(`Smart Slate RFQ ${stamp}`), "the portal does not show the project name");
  assert.match(text, /prototype 5, production 500/);
  const [dl] = await Promise.all([spage.waitForEvent("download"), card.getByRole("link", { name: /Download packet/ }).click()]);
  assert.equal(sha(readFileSync(await dl.path())), packetSha, "supplier downloaded the approved packet");
  await card.getByLabel("Unit price at 5", { exact: true }).fill("42");
  await card.getByLabel("Unit price at 500").fill("9.5");
  await card.getByLabel("Tooling / NRE").fill("120");
  await card.getByLabel("Lead time (days)").fill("12");
  await card.getByLabel("Notes (exceptions, suggestions)").fill("Stencil included");
  await card.getByRole("button", { name: "Submit quote" }).click();
  await spage.getByText(/Quote submitted/).waitFor();
  await card.locator("summary", { hasText: "Revise your quote" }).click();
  await card.getByLabel("Unit price at 5", { exact: true }).fill("40");
  await card.getByRole("button", { name: "Submit revision" }).click();
  await card.getByText(/Your quotes: rev 2/).waitFor();
  assert.match(await card.innerText(), /rev 2 \(5 @ USD 40\.00, 500 @ USD 9\.50\)/);
  await shot(spage, "supplier-portal");
  console.log("✓ supplier downloaded the packet (same sha256) and quoted, then revised");

  // 8. The owner compares and chooses.
  await opage.goto(rfqUrl);
  const row = opage.getByTestId("quotes").locator(`tr[data-name='${SUPPLIER}']`);
  assert.match(await row.innerText(), /rev 2[\s\S]*USD 40\.00[\s\S]*USD 9\.50[\s\S]*USD 120\.00[\s\S]*12 days/);
  assert.match(await opage.getByTestId("recipients").innerText(), /Quoted/);
  await row.getByLabel(`Why choose ${SUPPLIER}`).fill("Only verified PCBA quote; 12-day lead time");
  await row.getByRole("button", { name: "Choose this quote" }).click();
  await opage.getByText(/Supplier chosen and recorded as a decision/).waitFor();
  assert.match(await opage.getByTestId("rfq-status").innerText(), /Closed/);
  await shot(opage, "rfq-quote-chosen");
  const { data: decisions } = await admin.from("current_decisions").select("title, decision_class").eq("project_id", project.id);
  assert.deepEqual(decisions.map((d) => [d.decision_class, d.title]), [["manufacturing", `Supplier selected for RFQ-001: ${SUPPLIER}`]]);
  const { data: audit } = await admin.from("audit_events").select("event_type").eq("project_id", project.id).like("event_type", "rfq.%").order("id");
  assert.deepEqual(audit.map((a) => a.event_type), ["rfq.created", "rfq.packaged", "rfq.disclosure_approved", "rfq.sent", "rfq.packet_opened",
    "rfq.quote_received", "rfq.quote_received", "rfq.awarded"]);
  console.log("✓ owner chose the quote: recorded as a manufacturing decision; full audit trail");

  // 9. Closing ends the supplier's access.
  await spage.goto(`${BASE}/supplier`);
  assert.match(await spage.getByTestId("supplier-rfq").innerText(), /RFQ closed[\s\S]*Access to this RFQ has closed/);
  const s = await apiAs(supplier);
  const recipientId = (await s.rpc("supplier_rfqs")).data[0].recipient_id;
  assert.match((await s.rpc("supplier_open_rfq", { p_recipient_id: recipientId })).error?.message ?? "", /window for this RFQ is closed/);
  assert.ok((await s.storage.from("project-files").download(rfqRow.packet_path)).error, "packet unreadable after close");
  console.log("✓ supplier access ends when the RFQ closes");
  console.log("\nRFQ end-to-end flow passed.");
} catch (e) {
  console.error("\n✗ RFQ end-to-end flow failed:", e.message);
  for (const ctx of browser.contexts()) for (const p of ctx.pages()) {
    const alert = await p.getByRole("alert").allInnerTexts().catch(() => []);
    if (alert.length) console.error(`  page ${p.url()}: ${alert.join(" | ")}`);
  }
  process.exitCode = 1;
} finally {
  worker.kill("SIGKILL");
  await browser.close();
}
