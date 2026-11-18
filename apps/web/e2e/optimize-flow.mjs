// End-to-end test of optimization proposals (§14). A project has an approved sourced BOM (offline fixture
// distributor) and an approved power budget with an LDO. The owner runs the analysis in the browser; a worker prices the
// alternates and re-runs the power calculator. The page shows ranked proposals with computed before/after, assumptions
// and constraint checks. The reviewer accepts the LDO → buck proposal (after confirming the constraint marked for
// review) and rejects the resistor swap with a reason. A second analysis carries both decisions over. Clients see none of it.
//
// Needs the app running and the local Supabase stack (./scripts/test-e2e-optimize.sh).
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const { createClient } = createRequire(join(here, "../../../services/orchestrator/package.json"))("@supabase/supabase-js");
const { resolveBom, FixtureProvider } = await import(join(here, "../../../packages/integrations/src/index.ts"));
const { calculate } = await import(join(here, "../../../packages/power/src/index.ts"));

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const { SUPABASE_URL: URL, SUPABASE_SERVICE_ROLE_KEY: SERVICE, SUPABASE_ANON_KEY: ANON } = process.env;
if (!URL || !SERVICE || !ANON) throw new Error("SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and SUPABASE_ANON_KEY are required");
const SHOTS = process.env.SCREENSHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });
const stamp = Date.now();
const pw = "correct-horse-battery";
const owner = { email: `opt-owner-${stamp}@example.test`, password: pw };
const reviewer = { email: `opt-reviewer-${stamp}@example.test`, password: pw };
const client = { email: `opt-client-${stamp}@example.test`, password: pw };
const sha = (b) => createHash("sha256").update(b).digest("hex");

async function signUp(browser, who) {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1 })).newPage();
  await page.goto(`${BASE}/login`);
  await page.getByLabel("Email").fill(who.email);
  await page.getByLabel("Password").fill(who.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL(/\/projects$/);
  const api = createClient(URL, ANON, { auth: { persistSession: false } });
  assert.ifError((await api.auth.signInWithPassword(who)).error);
  return { page, api };
}
async function commit(projectId, name, kind, obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  const path = `${projectId}/artifacts/${name.replace(/\//g, "_")}-${stamp}.json`;
  assert.ifError((await admin.storage.from("project-files").upload(path, bytes, { contentType: "application/json" })).error);
  const { data: art } = await admin.from("artifacts").insert({ project_id: projectId, kind, name }).select("id").single();
  assert.ifError((await admin.from("artifact_versions").insert({ artifact_id: art.id, project_id: projectId, version: 1, status: "committed",
    storage_path: path, sha256: sha(bytes), size_bytes: bytes.length, tool_name: "e2e" })).error);
}

const browser = await chromium.launch();
const worker = spawn(process.execPath, [join(here, "../../../services/orchestrator/src/main.ts")], {
  env: { ...process.env, WORKER_ID: "optimize-worker", VX_LLM: "offline", VX_IMAGES: "off", VX_ENGINEERING: "off", VX_SOURCING: "fixture", WORKER_POLL_MS: "500" },
  stdio: ["ignore", "ignore", "inherit"],
});
try {
  const o = await signUp(browser, owner);
  const r = await signUp(browser, reviewer);
  const c = createClient(URL, ANON, { auth: { persistSession: false } });
  assert.ifError((await c.auth.signUp(client)).error);
  const { data: project } = await o.api.from("projects").insert({ name: `Slate optimize ${stamp}` }).select("id").single();
  for (const [who, role] of [[reviewer, "reviewer"], [client, "client"]]) {
    assert.equal((await o.api.rpc("invite_member", { p_project_id: project.id, p_email: who.email, p_role: role })).data, "added");
  }
  await o.api.from("requirements").insert({ project_id: project.id, ref_code: "REQ-PWR-001", kind: "power", priority: "must",
    text: "The board shall run from USB (5 V, 500 mA)." });

  // Approved inputs, as the sourcing and power tasks would leave them.
  const bom = await resolveBom({
    components: [
      { ref: "R1", symbol: "Device:R", value: "1k", footprint: "Resistor_SMD:R_0603_1608Metric", mpn: null, manufacturer: null },
      { ref: "R2", symbol: "Device:R", value: "1k", footprint: "Resistor_SMD:R_0603_1608Metric", mpn: null, manufacturer: null },
      { ref: "C1", symbol: "Device:C", value: "1uF", footprint: "Capacitor_SMD:C_0603_1608Metric", mpn: null, manufacturer: null },
      { ref: "U1", symbol: "Regulator", value: "AP2112K-3.3", footprint: "Package_TO_SOT_SMD:SOT-23-5", mpn: "AP2112K-3.3TRG1", manufacturer: "Diodes Incorporated" },
    ],
    nets: [{ name: "+5V", pins: ["C1.1", "U1.1"] }, { name: "+3V3", pins: ["R1.1", "R2.1", "U1.5"] }],
    quantities: [1, 10, 100, 1000],
  }, [new FixtureProvider()]);
  await commit(project.id, "sourcing/sourced-bom", "bom", bom);
  const tree = {
    name: "usb_ldo", title: "USB to 3.3 V", summary: "e2e", ambient_c: { nominal: 25, max: 45 },
    sources: [{ id: "VBUS", kind: "usb", label: "USB 5 V", voltage: { min: 4.75, nom: 5, max: 5.25 }, max_current_a: 0.5, battery: null, basis: { kind: "requirement", ref: "REQ-PWR-001" } }],
    converters: [{ id: "U1", label: "AP2112K 3.3 V LDO", kind: "ldo", mpn: "AP2112K-3.3TRG1", input: "VBUS", output_rail: "+3V3", vout: 3.3, vin_range: { min: 2.5, max: 6 },
      max_output_a: 0.6, efficiency: null, quiescent_a: 55e-6, dropout_v: 0.25, ron_ohm: null, theta_ja_c_per_w: 250, tj_max_c: 125, enable_after: null, soft_start_ms: null,
      basis: { kind: "datasheet", ref: "AP2112K" } }],
    rails: [{ id: "+3V3", label: "3.3 V", capacitance_uf: 10 }],
    loads: [{ id: "MCU", label: "Microcontroller", rail: "+3V3", current_a: { run: 0.15, sleep: 0.00005 }, peak_a: 0.2, basis: { kind: "assumption", ref: "e2e" } },
            { id: "TCXO", label: "Timecode TCXO", rail: "+3V3", current_a: { run: 0.002, sleep: 0 }, peak_a: null, basis: { kind: "assumption", ref: "e2e" } }],
    modes: [{ id: "run", label: "Running", hours_per_day: 8 }, { id: "sleep", label: "Sleep", hours_per_day: 16 }],
    sequencing: [], assumptions: [], open_questions: [],
  };
  await commit(project.id, "power/power-budget", "power_budget", { tree, report: calculate(tree), rounds: [] });

  // 1. The owner runs the analysis.
  const page = o.page;
  await page.goto(`${BASE}/projects/${project.id}`);
  await page.getByRole("link", { name: "Optimize" }).click();
  await page.getByRole("button", { name: "Run the analysis" }).click();
  await page.getByTestId("run-status").filter({ hasText: /^ready$/ }).waitFor({ timeout: 60_000 });
  assert.match(await page.getByTestId("run").innerText(), /sourcing\/sourced-bom[\s\S]*power\/power-budget[\s\S]*found at fixture/);
  const cards = page.getByTestId("proposal");
  const titles = await cards.locator("h3").allInnerTexts();
  assert.ok(titles.some((t) => /Use FX-E-R0603-1K for R1, R2: \d+% cheaper at 100 boards/.test(t)), titles.join("\n"));
  assert.ok(titles.some((t) => /Replace LDO U1 \(AP2112K 3.3 V LDO\) with a buck regulator/.test(t)));
  assert.ok(titles.some((t) => /Improve the thermal path of U1/.test(t)));
  const swap = cards.filter({ hasText: "Use FX-E-R0603-1K" });
  assert.match(await swap.getByTestId("impact").innerText(), /R1, R2 cost per board · 100 boards\s+\d/);
  const buck = cards.filter({ hasText: "with a buck regulator" });
  await buck.locator("summary", { hasText: "Basis, constraints and effects" }).click();
  const buckText = await buck.innerText();
  assert.match(buckText, /input power from VBUS · Running/);
  assert.match(buckText, /Assumed: switcher efficiency 88%/);
  assert.match(buckText, /needs review\s+noise: noise-sensitive loads or requirements on \+3V3: TCXO/);
  assert.match(buckText, /CISPR 32/);
  assert.match(await page.locator("main").innerText(), /fixture distributor data/);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "01-proposals.png"), fullPage: true });
  console.log(`✓ analysis: ${titles.length} ranked proposals with computed before/after, assumptions and constraint checks`);

  // 2. Owners/engineers run; owners/reviewers decide. The reviewer must confirm the constraints marked for review.
  assert.equal(await page.getByRole("button", { name: "Accept" }).count() > 0, true, "the owner can decide too");
  const rp = r.page;
  await rp.goto(`${BASE}/projects/${project.id}/optimize`);
  assert.equal(await rp.getByTestId("run-form").count(), 0, "reviewers do not run analyses");
  const rbuck = rp.getByTestId("proposal").filter({ hasText: "with a buck regulator" });
  await rbuck.getByRole("button", { name: "Accept" }).click();
  await rp.getByRole("alert").filter({ hasText: /confirm that the constraints marked for review have been checked/ }).waitFor();
  const rbuck2 = rp.getByTestId("proposal").filter({ hasText: "with a buck regulator" });
  await rbuck2.getByLabel(/have been checked/).check();
  await rbuck2.getByRole("textbox").fill("TCXO gets its own small LDO after the buck");
  await rbuck2.getByRole("button", { name: "Accept" }).click();
  await rp.getByText(/Accepted: recorded as a decision/).waitFor();
  const rswap = rp.getByTestId("proposal").filter({ hasText: "Use FX-E-R0603-1K" });
  await rswap.getByRole("textbox").fill("JLCPCB assembly needs an LCSC part");
  await rswap.getByRole("button", { name: "Reject" }).click();
  await rp.getByText(/Rejected: it will not be proposed again/).waitFor();
  const { data: decisions } = await admin.from("current_decisions").select("decision_class, title, evidence_category").eq("project_id", project.id);
  assert.deepEqual(decisions.map((d) => [d.decision_class, d.evidence_category]), [["power_architecture", "unverified_assumption"]]);
  assert.match(decisions[0].title, /Replace LDO U1/);
  console.log("✓ reviewer accepted the buck proposal (constraints confirmed) → decision; rejected the swap with a reason");

  // 3. A second analysis carries both decisions over.
  await page.goto(`${BASE}/projects/${project.id}/optimize`);
  await page.getByRole("button", { name: "Run the analysis again" }).click();
  await page.waitForFunction(() => /Analysis 2/.test(document.body.innerText) && /\bready\b/.test(document.querySelector("[data-testid=run-status]")?.textContent ?? ""), null, { timeout: 60_000 });
  await page.reload();
  const open = await page.locator("[data-testid=proposal][data-status=open] h3").allInnerTexts();
  assert.ok(!open.some((t) => /FX-E-R0603-1K|buck regulator/.test(t)), open.join("\n"));
  const carried = await page.locator("[data-testid=proposal][data-status=rejected]").innerText();
  assert.match(carried, /carried over from analysis 1: JLCPCB assembly needs an LCSC part/);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "02-decided.png"), fullPage: true });
  console.log("✓ second analysis: decided proposals carried over, not offered again");

  // 4. Clients see nothing; the trail is audited.
  assert.ifError((await c.auth.signInWithPassword(client)).error);
  assert.equal((await c.from("proposals").select("id").eq("project_id", project.id)).data.length, 0);
  const { data: ev } = await admin.from("audit_events").select("event_type").eq("project_id", project.id).like("event_type", "%o%").order("id");
  const types = ev.map((e) => e.event_type).filter((t) => /^(optimization|proposal)\./.test(t));
  assert.deepEqual(types, ["optimization.requested", "optimization.completed", "proposal.accepted", "proposal.rejected", "optimization.requested", "optimization.completed"]);
  console.log("✓ clients see no proposals; every step audited");
  console.log("\nOptimization end-to-end flow passed.");
} catch (e) {
  console.error("\n✗ Optimization end-to-end flow failed:", e.message);
  for (const ctx of browser.contexts()) for (const p of ctx.pages()) {
    const alert = await p.getByRole("alert").allInnerTexts().catch(() => []);
    if (alert.length) console.error(`  ${p.url()}: ${alert.join(" | ")}`);
  }
  process.exitCode = 1;
} finally {
  worker.kill("SIGKILL");
  await browser.close();
}
