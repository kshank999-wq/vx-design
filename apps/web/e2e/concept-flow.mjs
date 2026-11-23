// End-to-end test of concepts (M-CON): a client asks for concepts in the browser; a worker writes the brief and
// renders each variant (offline brief and placeholder images: VX_LLM=offline, VX_IMAGES=fixture); the client
// compares them, asks for a refinement of one (its image goes along as the reference), freezes a design, and the
// owner later changes the freeze with a reason. The workspace checklist and chat follow along.
//
// Needs the app running (VX_LLM=offline) and the local Supabase stack (./scripts/test-e2e-concepts.sh).
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });
const stamp = Date.now();
const owner = { email: `con-owner-${stamp}@example.test`, password: "correct-horse-battery" };
const client = { email: `con-client-${stamp}@example.test`, password: "correct-horse-battery" };

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
  const api = createClient(URL, ANON, { auth: { persistSession: false } });
  assert.ifError((await api.auth.signInWithPassword(who)).error);
  return api;
}
async function waitRound(page, n, status = "Ready", timeoutMs = 90_000) {
  const round = page.getByTestId(`round-${n}`);
  await round.getByTestId("round-status").filter({ hasText: new RegExp(`^${status}$`) }).waitFor({ timeout: timeoutMs });
  return round;
}

const browser = await chromium.launch();
const worker = spawn(process.execPath, [join(here, "../../../services/orchestrator/src/main.ts")], {
  env: { ...process.env, WORKER_ID: "concept-worker", VX_LLM: "offline", VX_IMAGES: "fixture", VX_ENGINEERING: "off", VX_SOURCING: "off", WORKER_POLL_MS: "500" },
  stdio: ["ignore", "ignore", "inherit"],
});
const ctxOpts = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1 };
try {
  const opage = await (await browser.newContext(ctxOpts)).newPage();
  const o = await signUp(opage, owner);
  const cpage = await (await browser.newContext(ctxOpts)).newPage();
  await signUp(cpage, client);
  const { data: project } = await o.from("projects").insert({ name: `Slate concepts ${stamp}`, description: "Wireless timecode slate" }).select("id").single();
  await o.from("requirements").insert({ project_id: project.id, ref_code: "REQ-MECH-001", kind: "mechanical", priority: "must",
    text: "The slate shall fit in one hand and be at most 170 mm long." });
  assert.equal((await o.rpc("invite_member", { p_project_id: project.id, p_email: client.email, p_role: "client" })).data, "added");

  // 1. The client starts in the workspace: concepts are the first checklist step.
  await cpage.goto(`${BASE}/projects/${project.id}`);
  await cpage.waitForURL(/\/workspace$/);
  assert.match(await cpage.getByTestId("concept-step").innerText(), /Concept and design freeze\nNot started/);
  console.log("✓ workspace checklist starts with the concept step");

  // 2. The client asks for three concepts.
  await cpage.goto(`${BASE}/projects/${project.id}/concepts`);
  await cpage.getByLabel("Direction").fill("Rugged for film sets, matte black, one-hand use, big readable display");
  await cpage.getByLabel("Variants").selectOption("3");
  await cpage.getByRole("button", { name: "Generate concepts" }).click();
  await cpage.getByText(/Concepts requested/).waitFor();
  let round = await waitRound(cpage, 1);
  const cards = round.getByTestId("variant");
  assert.equal(await cards.count(), 3);
  assert.deepEqual(await cards.evaluateAll((els) => els.map((e) => e.dataset.name)), ["Field Brick", "Slim Clap", "Grip Wedge"]);
  assert.equal(await round.getByText("concept, not CAD").count(), 3, "every image is labelled concept, not CAD");
  assert.match(await round.innerText(), /Offline stand-in brief \(not AI\)/);
  const first = cards.first();
  assert.match(await first.innerText(), /CMF: matte black PC\/ABS with orange TPE bumpers/);
  await first.locator("summary", { hasText: "Provenance" }).click();
  assert.match(await first.innerText(), /Prompt: Product concept render of a rugged handheld timecode slate/);
  assert.match(await first.innerText(), /fixture · fixture-placeholder-1 · seed [0-9a-f]{8}/);
  const src = await first.locator("img").getAttribute("src");
  const svg = await (await fetch(src)).text();
  assert.match(svg, /OFFLINE PLACEHOLDER · not a generated concept · concept, not CAD/);
  const { data: v1 } = await admin.from("concept_variants").select("id, image_path, sha256").eq("project_id", project.id).eq("name", "Field Brick").single();
  assert.match(v1.image_path, new RegExp(`^${project.id}/concepts/`));
  await shot(cpage, "concepts-round-1");
  console.log("✓ round 1: brief written, 3 labelled images stored in the project with their provenance");

  // 3. Workspace follows: the concept step waits for a decision, and the chat knows.
  await cpage.goto(`${BASE}/projects/${project.id}/workspace`);
  assert.match(await cpage.getByTestId("concept-step").innerText(), /Approval needed: choose a concept and freeze the design/);
  await cpage.getByLabel("Message").fill("What concepts do we have?");
  await cpage.getByRole("button", { name: "Send" }).click();
  await cpage.locator(".msg-assistant").last().getByText(/Concepts are ready to compare \(round 1: Field Brick, Slim Clap, Grip Wedge\)/).waitFor();
  await cpage.getByTestId("concepts-tile").click();
  await cpage.frameLocator("[data-testid=concepts-viewer]").getByTestId("round-1").waitFor();
  assert.equal(await cpage.frameLocator("[data-testid=concepts-viewer]").locator(".topbar").isVisible(), false);
  await shot(cpage, "workspace-concepts");
  console.log("✓ workspace: concept step awaits a decision, chat summarises the round, concepts open in the centre");

  // 4. Refine Field Brick: its image goes to the image provider as the reference.
  await cpage.goto(`${BASE}/projects/${project.id}/concepts`);
  round = cpage.getByTestId("round-1");
  const brick = round.locator("[data-testid=variant][data-name='Field Brick']");
  await brick.locator("summary", { hasText: "Refine this" }).click();
  await brick.getByLabel("How to refine Field Brick").fill("Keep the bumpers; make it 20% thinner");
  await brick.getByRole("button", { name: "Refine" }).click();
  await cpage.getByText(/Refinement requested/).waitFor();
  const round2 = await waitRound(cpage, 2);
  assert.match(await round2.innerText(), /refining “Field Brick”/);
  assert.equal(await round2.getByTestId("variant").count(), 2);
  const r2first = round2.getByTestId("variant").first();
  await r2first.locator("summary", { hasText: "Provenance" }).click();
  assert.match(await r2first.innerText(), /Reference: "Field Brick" \(round 1\)/);
  const r2svg = await (await fetch(await r2first.locator("img").getAttribute("src"))).text();
  assert.match(r2svg, /Refines: &quot;Field Brick&quot; \(round 1\)/, "the provider received the chosen variant as its reference");
  console.log("✓ refinement: round 2 made with Field Brick as the reference image");

  // 5. The client freezes Field Brick.
  round = cpage.getByTestId("round-1");
  const brick2 = round.locator("[data-testid=variant][data-name='Field Brick']");
  await brick2.locator("summary", { hasText: "Freeze this design" }).click();
  assert.equal(await brick2.getByLabel("Length of Field Brick").inputValue(), "160", "envelope prefilled from the brief");
  await brick2.getByLabel("Height of Field Brick").fill("30");
  await brick2.getByLabel("Note").fill("Signed off at the concept review");
  await brick2.getByRole("button", { name: "Freeze this design" }).click();
  await cpage.getByText(/Design frozen: recorded as a decision/).waitFor();
  const freeze = await cpage.getByTestId("freeze").innerText();
  assert.match(freeze, /Field Brick · envelope 160 × 90 × 30 mm \(L × W × H\)/);
  assert.match(freeze, /CMF: matte black PC\/ABS with orange TPE bumpers/);
  const { data: d1 } = await admin.from("current_decisions").select("title, statement, evidence_refs, created_by").eq("project_id", project.id);
  assert.equal(d1.length, 1);
  assert.equal(d1[0].title, "Design freeze: Field Brick");
  assert.match(d1[0].statement, /160 x 90 x 30 mm/);
  assert.equal(d1[0].evidence_refs[0].note, "concept image, not CAD");
  assert.equal(d1[0].evidence_refs[0].sha256, v1.sha256);
  await shot(cpage, "design-frozen");
  console.log("✓ client froze the design: decision recorded with the envelope and the image's hash");

  // 6. The owner changes the freeze: a reason is required (change control).
  await opage.goto(`${BASE}/projects/${project.id}/concepts`);
  await opage.getByRole("tab", { name: /Generated concepts/ }).click();
  const r2 = opage.getByTestId("round-2").getByTestId("variant").first();
  const r2name = await r2.getAttribute("data-name");
  await r2.locator("summary", { hasText: "Freeze this design" }).click();
  await r2.getByLabel("Reason for the change").fill("Thinner variant fits the 1S cell better");
  await r2.getByRole("button", { name: "Change the freeze to this" }).click();
  await opage.getByText(/Design frozen/).waitFor();
  await opage.getByRole("tab", { name: /Design freeze/ }).click();
  assert.match(await opage.getByTestId("freeze").innerText(), new RegExp(`${r2name}.*changed because: Thinner variant`, "s"));
  const { data: d2 } = await admin.from("current_decisions").select("title").eq("project_id", project.id);
  assert.deepEqual(d2.map((d) => d.title), [`Design freeze: ${r2name}`], "the old freeze decision is superseded");
  const { data: audit } = await admin.from("audit_events").select("event_type").eq("project_id", project.id).like("event_type", "design.%").order("created_at");
  assert.deepEqual(audit.map((a) => a.event_type), ["design.frozen", "design.freeze_changed"]);
  console.log("✓ owner changed the freeze with a reason; old decision superseded; both audited");

  // 7. The workspace shows the step done.
  await cpage.goto(`${BASE}/projects/${project.id}/workspace`);
  assert.match(await cpage.getByTestId("concept-step").innerText(), new RegExp(`Frozen: ${r2name}`));
  assert.equal(await cpage.getByTestId("concept-step").getAttribute("data-status"), "complete");
  console.log("✓ workspace concept step complete");
  console.log("\nConcepts end-to-end flow passed.");
} catch (e) {
  console.error("\n✗ Concepts end-to-end flow failed:", e.message);
  process.exitCode = 1;
} finally {
  worker.kill("SIGKILL");
  await browser.close();
}
