// End-to-end test of the Flux import and audit (G5). The owner creates an import, uploads three revisions of a
// synthetic Flux export from the browser (straight to storage), runs the audit, and reads the report: findings
// (with the planted schematic/layout mismatch as a blocker), the current-state map, revision comparison with a
// change made and undone, earlier decisions and claims (quotes checked; DRC claim has a file, bench test does not),
// and the migration plan. Clients cannot see audits.
//
// Needs the app running and the local Supabase stack (./scripts/test-e2e-flux.sh).
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const { createClient } = createRequire(join(here, "../../../services/orchestrator/package.json"))("@supabase/supabase-js");
const { writeFixture } = await import(join(here, "../../../packages/flux/test/fixture.ts"));

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const { SUPABASE_URL: URL, SUPABASE_SERVICE_ROLE_KEY: SERVICE, SUPABASE_ANON_KEY: ANON } = process.env;
if (!URL || !SERVICE || !ANON) throw new Error("SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and SUPABASE_ANON_KEY are required");
const SHOTS = process.env.SCREENSHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });
const stamp = Date.now();
const owner = { email: `flux-owner-${stamp}@example.test`, password: "correct-horse-battery" };
const client = { email: `flux-client-${stamp}@example.test`, password: "correct-horse-battery" };

let step = 0;
async function shot(page, name) {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${String(++step).padStart(2, "0")}-${name}.png`), fullPage: true });
}

const [revA, revB, revC] = writeFixture(mkdtempSync(join(tmpdir(), "flux-fixture-")));
const browser = await chromium.launch();
const worker = spawn(process.execPath, [join(here, "../../../services/orchestrator/src/main.ts")], {
  env: { ...process.env, WORKER_ID: "flux-worker", VX_LLM: "offline", VX_IMAGES: "off", VX_ENGINEERING: "off", VX_SOURCING: "off", WORKER_POLL_MS: "500" },
  stdio: ["ignore", "ignore", "inherit"],
});
try {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1 })).newPage();
  await page.goto(`${BASE}/login`);
  await page.getByLabel("Email").fill(owner.email);
  await page.getByLabel("Password").fill(owner.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL(/\/projects$/);
  const o = createClient(URL, ANON, { auth: { persistSession: false } });
  assert.ifError((await o.auth.signInWithPassword(owner)).error);
  const { data: project } = await o.from("projects").insert({ name: `Smart Slate Flux ${stamp}` }).select("id").single();
  const c = createClient(URL, ANON, { auth: { persistSession: false } });
  assert.ifError((await c.auth.signUp(client)).error);
  assert.equal((await o.rpc("invite_member", { p_project_id: project.id, p_email: client.email, p_role: "client" })).data, "added");

  // 1. Create the import and upload three revisions from the browser.
  await page.goto(`${BASE}/projects/${project.id}`);
  await page.getByRole("link", { name: "Flux import" }).click();
  await page.getByLabel("Title").fill("Smart Slate timecode board in Flux");
  await page.getByRole("button", { name: "New import" }).click();
  await page.getByText(/Import created/).waitFor();
  const upload = page.getByTestId("flux-upload");
  for (const [file, rev, date] of [[revA, "Rev A", "2026-10-02"], [revB, "Rev B", "2026-11-02"], [revC, "Rev C", "2026-11-09"]]) {
    await upload.getByLabel("Revision", { exact: true }).fill(rev);
    await upload.getByLabel("Date of this revision (optional)").fill(date);
    await upload.getByLabel("Files").setInputFiles(file);
    await upload.getByRole("button", { name: "Upload" }).click();
    await page.getByTestId("flux-files").getByText(file.split("/").pop()).waitFor();
  }
  assert.equal(await page.getByTestId("flux-files").locator("tbody tr").count(), 3);
  const { data: rows } = await admin.from("flux_audit_files").select("storage_path, sha256").eq("project_id", project.id);
  assert.ok(rows.every((r) => r.storage_path.startsWith(`${project.id}/flux/`)), "uploaded straight into the audit's folder");
  console.log("✓ three revisions uploaded from the browser into the project's storage");

  // 2. Run the audit.
  await page.getByRole("button", { name: "Run the audit" }).click();
  await page.getByTestId("audit-status").filter({ hasText: /^ready$/ }).waitFor({ timeout: 90_000 });
  assert.match(await page.getByTestId("statement").innerText(), /never assumed verified/);
  const findings = page.getByTestId("findings");
  const blocker = findings.locator("li[data-severity=blocker]", { hasText: "The layout does not match the schematic" });
  assert.match(await blocker.innerText(), /net LTC_RX is split in the layout[\s\S]*pin J2\.2 \(GND\) is not connected/);
  assert.match(await findings.innerText(), /U2 mpn: AP2112K-3\.3TRG1 → MCP1700T-3302E\/TT → AP2112K-3\.3TRG1 \(Rev A → Rev B → Rev C\)/);
  assert.match(await findings.innerText(), /models\/USB4105-GF-A\.step/);
  assert.match(await findings.innerText(), /J1: USB4105-GF-A vs USB4110-GF-A/);
  console.log("✓ audit: layout/schematic mismatch is a blocker; undone change, missing asset and part-number conflict found");

  // 3. Current state, revisions, history, plan.
  assert.match(await page.getByTestId("parts").locator("tr[data-ref=D1]").innerText(), /uncertain[\s\S]*no manufacturer part number/);
  assert.match(await page.getByTestId("parts").locator("tr[data-ref=U1]").innerText(), /consistent/);
  assert.match(await page.getByTestId("connectors").innerText(), /J1[\s\S]*left edge/);
  assert.equal(await page.getByTestId("comparison").count(), 2);
  const history = page.getByTestId("history");
  assert.match(await history.locator("li[data-kind=drc]").innerText(), /evidence file present, not re-run[\s\S]*drc_report\.txt/);
  assert.match(await history.locator("li[data-kind=bench_test]").innerText(), /unverifiable[\s\S]*Bench tested LTC decode at 30 fps/);
  assert.match(await history.innerText(), /decision[\s\S]*We decided to use the AP2112K because the MCP1700 dropout was too high/);
  const plan = await page.getByTestId("migration").innerText();
  for (const t of ["Resolve the schematic/layout differences", "Rebuild the design in KiCad from the export", "Re-establish the claimed validations", "Record the repeated decisions"]) assert.ok(plan.includes(t), t);
  const md = await (await fetch(await page.getByRole("link", { name: "Markdown" }).getAttribute("href"))).text();
  assert.match(md, /^# Flux audit: Smart Slate timecode board in Flux/);
  await shot(page, "flux-audit");
  console.log("✓ report: current-state map, 2 revision comparisons, quoted history with evidence status, migration plan, Markdown");

  // 4. Clients do not see audits; the trail is audited.
  assert.ifError((await c.auth.signInWithPassword(client)).error);
  assert.equal((await c.from("flux_audits").select("id").eq("project_id", project.id)).data.length, 0, "clients do not see audits");
  const { data: audit } = await admin.from("audit_events").select("event_type").eq("project_id", project.id).like("event_type", "flux.%").order("id");
  assert.deepEqual(audit.map((a) => a.event_type), ["flux.created", "flux.audit_requested", "flux.audit_completed"]);
  console.log("✓ clients see nothing; import and audit are in the audit log");
  console.log("\nFlux import end-to-end flow passed.");
} catch (e) {
  console.error("\n✗ Flux import end-to-end flow failed:", e.message);
  process.exitCode = 1;
} finally {
  worker.kill("SIGKILL");
  await browser.close();
}
