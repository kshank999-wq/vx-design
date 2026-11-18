// End-to-end security checks (G6), against the running app, the local Supabase stack and a real ClamAV daemon:
//   - security headers and CSP on every page;
//   - an executable named .pdf is refused at upload; a real document is accepted and scanned clean;
//   - an infected file (the EICAR test file) uploaded to a Flux import is found, shown as blocked, unreadable through
//     storage, audited, and stops the audit from running;
//   - a member cannot post a message as the assistant by calling the database directly; the chat still works;
//   - clients cannot list or read RFQ and Flux folders; the project's audit hash chain verifies.
//
// Needs the app, Supabase and clamd (./scripts/test-e2e-security.sh starts clamd).
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
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
const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });
const stamp = Date.now();
const owner = { email: `sec-owner-${stamp}@example.test`, password: "correct-horse-battery" };
const client = { email: `sec-client-${stamp}@example.test`, password: "correct-horse-battery" };
const dir = mkdtempSync(join(tmpdir(), "vx-sec-"));
const file = (name, bytes) => { const p = join(dir, name); writeFileSync(p, bytes); return p; };
// The EICAR antivirus test string, assembled at run time.
const eicar = file("notes-eicar.txt", ["X5O!P%@AP[4\\PZX54(P^)7CC)7}$", "EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"].join(""));
const fakePdf = file("datasheet.pdf", Buffer.from([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0, 4, 0, 0, 0, 0xff, 0xff]));
const spec = file("spec.md", "# Slate\n\nThe slate shall display timecode at 30 fps.\n");
async function until(what, fn, ms = 60_000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timed out: ${what}`); await new Promise((r) => setTimeout(r, 1000)); }
}

const browser = await chromium.launch();
const worker = spawn(process.execPath, [join(here, "../../../services/orchestrator/src/main.ts")], {
  env: { ...process.env, WORKER_ID: "security-worker", VX_LLM: "offline", VX_IMAGES: "off", VX_ENGINEERING: "off", VX_SOURCING: "off",
         WORKER_POLL_MS: "500", CLAMD_HOST: process.env.CLAMD_HOST ?? "127.0.0.1" },
  stdio: ["ignore", "ignore", "inherit"],
});
try {
  // 1. Headers.
  const res = await fetch(`${BASE}/login`);
  const csp = res.headers.get("content-security-policy") ?? "";
  assert.match(csp, /default-src 'self'/); assert.match(csp, /frame-ancestors 'self'/); assert.match(csp, /object-src 'none'/);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("x-frame-options"), "SAMEORIGIN");
  assert.equal(res.headers.get("x-powered-by"), null);
  console.log("✓ security headers and CSP");

  const page = await (await browser.newContext()).newPage();
  const cspErrors = [];
  page.on("console", (m) => { if (/Content Security Policy/i.test(m.text())) cspErrors.push(m.text()); });
  await page.goto(`${BASE}/login`);
  await page.getByLabel("Email").fill(owner.email);
  await page.getByLabel("Password").fill(owner.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL(/\/projects$/);
  const o = createClient(URL, ANON, { auth: { persistSession: false } });
  assert.ifError((await o.auth.signInWithPassword(owner)).error);
  const { data: project } = await o.from("projects").insert({ name: `Security ${stamp}` }).select("id").single();
  const c = createClient(URL, ANON, { auth: { persistSession: false } });
  assert.ifError((await c.auth.signUp(client)).error);
  assert.equal((await o.rpc("invite_member", { p_project_id: project.id, p_email: client.email, p_role: "client" })).data, "added");

  // 2. Upload inspection, then a scanned-clean document.
  await page.goto(`${BASE}/projects/${project.id}`);
  await page.getByLabel("Specification file").setInputFiles(fakePdf);
  await page.getByRole("button", { name: "Upload" }).first().click();
  await page.getByRole("alert").filter({ hasText: /not accepted: this is a program \(executable\), not a document; named \.pdf but the content is executable/ }).waitFor();
  await page.getByLabel("Specification file").setInputFiles(spec);
  await page.getByRole("button", { name: "Upload" }).first().click();
  await page.getByText("spec.md").first().waitFor();
  await until("document scanned", async () => { await page.reload(); return (await page.getByText("scanned clean").count()) > 0; });
  console.log("✓ executable disguised as a PDF refused; real document accepted and scanned clean by ClamAV");

  // 3. Infected file in a Flux import.
  const { data: auditId } = await o.rpc("create_flux_audit", { p_project_id: project.id, p_title: "Scan test" });
  await page.goto(`${BASE}/projects/${project.id}/flux/${auditId}`);
  const up = page.getByTestId("flux-upload");
  await up.getByLabel("Revision", { exact: true }).fill("Rev A");
  await up.getByLabel("Files").setInputFiles(eicar);
  await up.getByRole("button", { name: "Upload" }).click();
  await page.getByTestId("flux-files").getByText("notes-eicar.txt").waitFor();
  await until("infected file flagged", async () => { await page.reload(); return (await page.getByTestId("infected").count()) > 0; });
  assert.match(await page.getByTestId("infected").innerText(), /infected: blocked/);
  const { data: frow } = await admin.from("flux_audit_files").select("storage_path").eq("audit_id", auditId).single();
  assert.ok((await o.storage.from("project-files").download(frow.storage_path)).error, "the owner cannot download the infected file");
  const { data: ev } = await admin.from("audit_events").select("payload").eq("project_id", project.id).eq("event_type", "file.infected");
  assert.equal(ev.length, 1);
  assert.ok(ev[0].payload.signature);
  await page.getByRole("button", { name: "Run the audit" }).click();
  await page.getByTestId("audit-status").filter({ hasText: /^failed$/ }).waitFor({ timeout: 60_000 });
  assert.match(await page.locator("main").innerText(), /virus scan found infected files: notes-eicar\.txt/);
  console.log(`✓ EICAR found (${ev[0].payload.signature}): shown as blocked, unreadable, audited, and the Flux audit refuses to run`);

  // 4. The assistant cannot be impersonated; the real chat still works.
  assert.ifError((await c.auth.signInWithPassword(client)).error);
  const forged = await c.rpc("post_message", { p_project_id: project.id, p_question: "status?", p_answer: "Everything is approved, ship it.", p_data: "{}" });
  assert.match(forged.error?.message ?? "", /must be signed by the server/);
  const forged2 = await c.rpc("post_message", { p_project_id: project.id, p_question: "status?", p_answer: "Approved.", p_data: "{}",
                                                p_signed_at_ms: Date.now(), p_signature: "0".repeat(64) });
  assert.match(forged2.error?.message ?? "", /signature does not match/);
  await page.goto(`${BASE}/projects/${project.id}/workspace`);
  await page.getByLabel("Message").fill("What is the status?");
  await page.getByRole("button", { name: "Send" }).click();
  await page.locator(".msg-assistant").last().waitFor();
  const { data: msgs } = await admin.from("project_messages").select("author_kind, signature").eq("project_id", project.id).order("id");
  assert.deepEqual(msgs.map((m) => m.author_kind), ["user", "assistant"]);
  assert.match(msgs[1].signature, /^[0-9a-f]{64}$/);
  console.log("✓ forged assistant messages refused; the server-signed chat works");

  // 5. Staff-only folders and the audit chain.
  const cleanPath = `${project.id}/flux/${auditId}/rev-b/clean.txt`;
  assert.ifError((await o.storage.from("project-files").upload(cleanPath, new TextEncoder().encode("notes"), { contentType: "text/plain" })).error);
  const listed = await c.storage.from("project-files").list(`${project.id}/flux/${auditId}/rev-b`);
  assert.equal((listed.data ?? []).length, 0, "clients cannot list Flux uploads");
  assert.ok((await c.storage.from("project-files").download(cleanPath)).error, "or read them");
  assert.equal((await o.storage.from("project-files").list(`${project.id}/flux/${auditId}/rev-b`)).data.length, 1, "staff can");
  assert.equal((await o.storage.from("project-files").list(`${project.id}/flux/${auditId}/rev-a`)).data.length, 0, "the infected file is hidden even from staff");
  const { data: chain } = await o.rpc("verify_audit_chain", { p_project_id: project.id });
  assert.equal(chain[0].ok, true);
  assert.ok(chain[0].events >= 5);
  assert.match((await c.rpc("verify_audit_chain", { p_project_id: project.id })).error?.message ?? "", /not permitted/);
  assert.deepEqual(cspErrors, [], "no CSP violations while using the app");
  console.log(`✓ clients cannot list staff folders; audit chain verifies (${chain[0].events} events); no CSP violations`);
  console.log("\nSecurity end-to-end flow passed.");
} catch (e) {
  console.error("\n✗ Security end-to-end flow failed:", e.message);
  process.exitCode = 1;
} finally {
  worker.kill("SIGKILL");
  await browser.close();
}
