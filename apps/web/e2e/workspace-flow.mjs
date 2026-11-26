// End-to-end test of the client workspace: an owner invites a client by email; the client signs up, lands in
// the workspace, sees the checklist stop at an approval, asks the chat what needs approval, opens the power
// report in the centre viewer, and approves. The client cannot read runs, executions, costs, audit or logs.
//
// Needs the app running (VX_LLM=offline) and the local Supabase stack (./scripts/test-e2e-workspace.sh).
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
const owner = { email: `ws-owner-${Date.now()}@example.test`, password: "correct-horse-battery" };

let step = 0;
async function shot(page, name) {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${String(++step).padStart(2, "0")}-${name}.png`), fullPage: true });
}
async function waitFor(what, fn, timeoutMs = 120_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

const client = { email: `ws-client-${Date.now()}@example.test`, password: "correct-horse-battery" };

async function signUp(page, who) {
  await page.goto(`${BASE}/login`);
  await page.getByLabel("Email").fill(who.email);
  await page.getByLabel("Password").fill(who.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL(/\/projects$/);
}

const browser = await chromium.launch();
const worker = spawn(process.execPath, [join(here, "../../../services/orchestrator/src/main.ts")], {
  env: { ...process.env, WORKER_ID: "ws-worker", VX_LLM: "offline", VX_ENGINEERING: "off", VX_SOURCING: "off", WORKER_POLL_MS: "500" },
  stdio: ["ignore", "ignore", "inherit"],
});
const ctxOpts = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1 };
try {
  // Owner: a project with one power task that stops for approval.
  const page = await (await browser.newContext(ctxOpts)).newPage();
  await signUp(page, owner);
  const user = createClient(URL, ANON, { auth: { persistSession: false } });
  assert.ifError((await user.auth.signInWithPassword(owner)).error);
  const { data: project } = await user.from("projects").insert({ name: "Timecode slate (workspace e2e)", description: "Wireless timecode slate" }).select("id").single();
  await user.from("requirements").insert([{ project_id: project.id, ref_code: "REQ-PWR-001", kind: "power", priority: "must",
    text: "The slate shall run a full 12 hour shooting day from one 1S Li-ion pack." }]);
  const { data: planId } = await user.rpc("create_plan_version", { p_project_id: project.id, p_payload: { summary: "Power design for the slate.", tasks: [
    { key: "power-budget", title: "Power tree and budget", discipline: "power", requirement_refs: ["REQ-PWR-001"],
      acceptance_tests: [{ id: "AT1", description: "Power budget passes the calculator", method: "validation", validationKind: "power_budget" }] },
  ] } });
  await user.rpc("submit_plan", { p_plan_id: planId });
  await user.rpc("decide_plan", { p_plan_id: planId, p_approve: true, p_note: null });
  await user.rpc("authorize_run", { p_plan_id: planId, p_mode: "autonomous", p_max_ai_spend_usd: 5, p_max_compute_spend_usd: 5, p_name: "ws" });
  const task = async () => (await admin.from("tasks").select("id, status").eq("plan_id", planId).single()).data;
  await waitFor("power task to stop for approval", async () => (await task()).status === "awaiting_approval");
  console.log("✓ power task ran and stopped for approval");
  // The worker wrote a plain-language summary (offline stand-in here) on the task.
  assert.match((await admin.from("tasks").select("plain_summary").eq("plan_id", planId).single()).data.plain_summary ?? "", /^Offline stand-in, not AI: "Power tree and budget" is finished/);
  // A question only the owner can answer, as the worker would raise it.
  assert.ifError((await admin.from("project_questions").insert({ project_id: project.id, task_id: (await task()).id, question: "Which markets will you sell in first?",
    why: "It decides which radio certifications to plan for.", recommendation: "US only", options: ["US only", "US and EU"] })).error);

  // Owner invites the client by email before the client has an account.
  await page.goto(`${BASE}/projects/${project.id}?tab=team`);
  await page.getByLabel("Email to invite").fill(client.email);
  await page.getByLabel("Role").selectOption("client");
  await page.getByRole("button", { name: "Invite" }).click();
  await page.getByText(/Invitation recorded/).waitFor();
  assert.match(await page.getByTestId("invitations").innerText(), /waiting for sign-up/);
  await shot(page, "owner-invites-client");
  console.log("✓ owner invited the client");

  // Client signs up, sees the project, and lands in the workspace.
  const cpage = await (await browser.newContext(ctxOpts)).newPage();
  await signUp(cpage, client);
  await cpage.getByRole("link", { name: "Timecode slate (workspace e2e)" }).click();
  await cpage.waitForURL(/\/workspace$/);
  const checklist = cpage.getByTestId("checklist");
  await checklist.getByRole("link", { name: "Power tree and budget" }).waitFor();
  // The approval is at the top of the activity panel, with VX Design's checks in plain language.
  const stop = checklist.getByTestId("approval-stop");
  assert.match(await stop.getByTestId("verdict").innerText(), /^(✓ Passed: all \d+ checks passed|No automatic checks)/);
  assert.match(await stop.getByTestId("plain-summary").innerText(), /"Power tree and budget" is finished/);
  assert.match(await stop.innerText(), /See the full technical explanation/);
  // Questions for you: listed in the workspace, answered on their own page with one of the choices.
  assert.match(await checklist.getByTestId("ws-questions").innerText(), /1 question for you[\s\S]*Which markets will you sell in first\?/);
  await checklist.getByTestId("answer-questions").click();
  await cpage.waitForURL(/\/questions$/);
  const q = cpage.getByTestId("question");
  assert.match(await q.innerText(), /Which markets will you sell in first\?[\s\S]*Why it matters: It decides/);
  assert.match(await q.getByTestId("recommendation").innerText(), /★ Recommended\s+US only/);
  await q.getByTestId("read-aloud").waitFor();   // read-aloud is offered wherever the browser can speak
  const hasDictation = await cpage.evaluate(() => "webkitSpeechRecognition" in window || "SpeechRecognition" in window);
  assert.equal(await q.getByTestId("dictate").count(), hasDictation ? 2 : 0, "dictation (for asking and for answering) offered only where the browser supports it");
  await shot(cpage, "client-questions");
  // "I have a question about this": asked before answering, explained under the question, nothing answered yet.
  const ask = q.getByTestId("ask-about");
  await ask.locator("summary").click();
  await ask.getByLabel(/Your question about/).fill("What does selling in the EU change for the design?");
  await ask.getByRole("button", { name: "Ask" }).click();
  await cpage.getByText("Answered below the question.").waitFor();
  const asked = cpage.getByTestId("question").getByTestId("ask-about");
  assert.match(await asked.innerText(), /You asked: What does selling in the EU change for the design\?/);
  assert.ok((await asked.locator(".q-ask-reply").innerText()).trim().length > 10, "the assistant's explanation is shown");
  const { data: stillOpen } = await admin.from("project_questions").select("status").eq("project_id", project.id).single();
  assert.equal(stillOpen.status, "open", "asking does not answer the question");
  await cpage.getByTestId("question").getByRole("button", { name: "US and EU" }).click();
  await cpage.getByText("Saved: the next steps will follow your answer.").waitFor();
  const { data: answered } = await admin.from("project_questions").select("status, answer").eq("project_id", project.id).single();
  assert.deepEqual([answered.status, answered.answer], ["answered", "US and EU"]);
  assert.match(await cpage.getByTestId("answered-questions").innerText(), /Your answers \(1\)[\s\S]*✓ Answered[\s\S]*Which markets will you sell in first\?/);
  await cpage.getByTestId("answer").locator("summary").click();
  assert.match(await cpage.getByTestId("answer").innerText(), /Answer\s+US and EU[\s\S]*Answered [A-Z][a-z]+day[\s\S]*Chose an option[\s\S]*VX Design had recommended: US only/);
  await shot(cpage, "client-answers");
  await cpage.goto(`${BASE}/projects/${project.id}/workspace`);
  console.log("✓ plain summary on the approval, and the client answered a question");
  assert.match(await cpage.getByTestId("next-steps").innerText(), /waiting for your approval/);
  // The design viewer: tabs like a CAD tool, with the files the steps made.
  await cpage.getByTestId("design-viewer").getByRole("link", { name: "Files", exact: true }).click();
  await cpage.getByTestId("viewer-files").waitFor();
  await shot(cpage, "client-workspace");
  console.log("✓ client joined through the invitation and sees the checklist with the approval stop");

  // Chat.
  await cpage.getByLabel("Message").fill("What needs my approval?");
  await cpage.getByRole("button", { name: "Send" }).click();
  // The reply streams into a live bubble, then the page refreshes to show the stored exchange.
  await cpage.waitForFunction(() => document.querySelector("[data-testid=chat-streaming]")?.textContent?.includes("Waiting for your approval"));
  await cpage.getByTestId("chat-live").waitFor({ state: "detached" });
  const reply = cpage.getByTestId("chat").locator(".msg-assistant").last();
  await reply.waitFor();
  const text = await reply.innerText();
  assert.match(text, /Waiting for your approval \(1\):\n• Power tree and budget: /);
  assert.match(text, /Offline status summary, not AI/);
  assert.equal(await cpage.locator(".msg-user").last().innerText(), "What needs my approval?");
  console.log("✓ chat answered from the project's state");

  // Centre viewer: the power report, embedded without the app chrome.
  await reply.getByRole("link", { name: "power-budget" }).click();
  await cpage.waitForURL(/\?view=/);
  const frame = cpage.frameLocator("[data-testid=viewer]");
  assert.match(await frame.getByTestId("power-status").innerText(), /0 error\(s\)/);
  assert.equal(await frame.locator(".topbar").isVisible(), false);
  await shot(cpage, "client-views-power-report");
  console.log("✓ centre viewer shows the power report");

  // What the client cannot read.
  const capi = createClient(URL, ANON, { auth: { persistSession: false } });
  assert.ifError((await capi.auth.signInWithPassword(client)).error);
  for (const table of ["runs", "executions", "cost_events", "audit_events", "execution_logs"]) {
    const { data, error } = await capi.from(table).select("id").eq("project_id", project.id);
    assert.ifError(error);
    assert.equal(data.length, 0, `client must not read ${table}`);
  }
  assert.equal((await capi.from("tasks").select("id").eq("project_id", project.id)).data.length, 1);
  const { error: forged } = await capi.from("project_messages").insert({ project_id: project.id, author_kind: "assistant", body: "forged" });
  assert.ok(forged, "client cannot write assistant messages directly");
  const { error: ownerOnly } = await capi.rpc("invite_member", { p_project_id: project.id, p_email: "x@example.test", p_role: "client" });
  assert.ok(ownerOnly, "client cannot invite");
  console.log("✓ client cannot read runs, executions, costs, audit or logs, forge messages, or invite");

  // Client approves at the stop.
  await cpage.goto(`${BASE}/projects/${project.id}/workspace`);
  await cpage.getByRole("button", { name: "Approve", exact: true }).click();
  await cpage.getByText("Approved. The team's next steps are unblocked.").waitFor();
  assert.equal((await task()).status, "complete");
  const { data: versions } = await admin.from("artifact_versions").select("status").eq("produced_by_task_id", (await task()).id);
  assert.deepEqual(versions.map((v) => v.status), ["committed"]);
  assert.equal(await cpage.getByTestId("next-steps").count(), 0, "nothing left to do");
  assert.match(await cpage.getByTestId("checklist").getByTestId("plain-summary").textContent(), /is finished[\s\S]*See the full technical explanation/);
  await shot(cpage, "client-approved");
  const { data: audit } = await admin.from("audit_events").select("event_type, actor_id").eq("project_id", project.id).eq("event_type", "task.approved");
  assert.equal(audit.length, 1);
  console.log("✓ client approved: output committed and audited");

  // The owner sees the same chat.
  await page.goto(`${BASE}/projects/${project.id}/workspace`);
  await page.locator(".msg-user").getByText("What needs my approval?").waitFor();
  console.log("✓ owner sees the client's conversation");

  // A plan change from the chat: proposed by the assistant, drafted by the owner as a new plan version.
  const { data: powerTask } = await admin.from("tasks").select("key, plan_id").eq("project_id", project.id).single();
  await page.getByLabel("Message").fill(`Add a task: Drop test of the enclosure after ${powerTask.key}`);
  await page.getByRole("button", { name: "Send" }).click();
  const card = page.getByTestId("plan-change").last();
  await card.waitFor();
  assert.match(await card.innerText(), /Proposed plan update[\s\S]*Add "Drop test of the enclosure"/);
  await card.getByRole("button", { name: "✓ Yes, update the plan" }).click();
  await page.getByText(/Plan v\d+ drafted with the change/).waitFor();
  // The plan page says in plain words what changes: one new step, done next; everything else already done is kept.
  assert.match(await page.getByTestId("impact-counts").innerText(), /0\s*taken out[\s\S]*0\s*changed[\s\S]*1\s*new[\s\S]*1\s*to do \(again\)[\s\S]*1\s*already done and kept/);
  assert.match(await page.getByTestId("redo-order").innerText(), /Drop test of the enclosure · new step/);
  // The Plan page: the new version with a big green approve button, the new step highlighted, the change listed on the right.
  await page.goto(`${BASE}/projects/${project.id}/plan`);
  await page.getByTestId("approve-plan-top").getByRole("button", { name: "✓ Approve this plan" }).waitFor();
  assert.match(await page.getByTestId("plan-changes").innerText(), /v2 · .* · new\s*Drop test of the enclosure/);
  assert.match(await page.locator("#step-drop-test-of-the-enclosure").innerText(), /changed in v2/);
  assert.match(await page.getByTestId("plan-archive").innerText(), /v1/);
  await shot(page, "plan-page");
  const { data: plans } = await admin.from("plans").select("id, version, status, generator").eq("project_id", project.id).order("version");
  const draft = plans.at(-1);
  assert.equal(draft.status, "draft");
  const { data: newTasks } = await admin.from("tasks").select("id, key, title").eq("plan_id", draft.id).order("position");
  assert.deepEqual(newTasks.map((t) => t.key), [powerTask.key, "drop-test-of-the-enclosure"]);
  const { data: dep } = await admin.from("task_dependencies").select("depends_on_task_id").eq("task_id", newTasks[1].id).single();
  assert.equal(dep.depends_on_task_id, newTasks[0].id);
  assert.equal((await admin.from("plans").select("status").eq("id", powerTask.plan_id).single()).data.status, "approved", "the running plan is unchanged");
  await page.goto(`${BASE}/projects/${project.id}/workspace`);
  await page.getByTestId("plan-change").last().getByRole("link", { name: /Drafted as plan v\d+ \(draft\)/ }).waitFor();
  // It is also listed in its own section, the same decision as in the chat.
  assert.match(await page.getByTestId("plan-proposals").innerText(), /Proposed plan updates \(1\)[\s\S]*Drafted as plan v\d+/);
  await cpage.goto(`${BASE}/projects/${project.id}/workspace`);
  assert.match(await cpage.getByTestId("plan-change").last().innerText(), /Drafted as plan v\d+\. The project owner or an engineer decides/);
  assert.equal(await cpage.getByTestId("plan-change").last().getByRole("button").count(), 0, "clients cannot draft plan changes");
  await shot(page, "plan-change-drafted");
  console.log("✓ a plan change from the chat became a draft plan version; the approved plan is unchanged");
  console.log("\nWorkspace end-to-end flow passed.");
} catch (e) {
  console.error("\n✗ Workspace end-to-end flow failed:", e.message);
  process.exitCode = 1;
} finally {
  worker.kill("SIGKILL");
  await browser.close();
}
