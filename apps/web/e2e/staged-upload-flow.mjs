// End-to-end test of browser-staged uploads (deployment). A specification larger than a hosted server function will
// accept (Vercel: 4.5 MB request bodies) goes from the browser to storage; the form posts only its path; the server
// reads, checks and stores it, then removes the staged copy. Only the uploader can remove a staged file, and the
// worker sweep finds copies nobody collected.
//
// Needs the app running and the local Supabase stack (./scripts/test-e2e-staged-upload.sh).
import { createRequire } from "node:module";
import assert from "node:assert/strict";
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
const owner = { email: `staged-owner-${stamp}@example.test`, password: "correct-horse-battery" };
const other = { email: `staged-other-${stamp}@example.test`, password: "correct-horse-battery" };

// A 6 MB specification: real requirements plus a long appendix.
const spec = join(mkdtempSync(join(tmpdir(), "vx-staged-")), "large-spec.md");
const para = "The appendix records measurement notes for the timecode board bring-up and is long on purpose. ";
writeFileSync(spec, `# Large specification\n\n## Requirements\n\nThe device shall run for 8 hours on battery.\n\n## Appendix\n\n${
  Array.from({ length: 6 * 1024 * 1024 / para.length }, () => para).join("\n\n")}\n`);

async function signUp(browser, who) {
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${BASE}/login`);
  await page.getByLabel("Email").fill(who.email);
  await page.getByLabel("Password").fill(who.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL(/\/projects$/);
  const api = createClient(URL, ANON, { auth: { persistSession: false } });
  assert.ifError((await api.auth.signInWithPassword(who)).error);
  return { page, api };
}
const staged = async (projectId) => ((await admin.storage.from("project-files").list(`${projectId}/uploads`)).data ?? []);

const browser = await chromium.launch();
try {
  const o = await signUp(browser, owner);
  const x = await signUp(browser, other);
  const { data: project } = await o.api.from("projects").insert({ name: `Staged uploads ${stamp}` }).select("id").single();
  assert.equal((await o.api.rpc("invite_member", { p_project_id: project.id, p_email: other.email, p_role: "engineer" })).data, "added");

  // 1. Upload: the browser sends the file to storage; requests to the web server stay small.
  const page = o.page;
  await page.goto(`${BASE}/projects/${project.id}`);
  const input = page.getByLabel("Specification file");
  await input.setInputFiles(spec);
  await page.locator("input[data-staged='yes']").waitFor({ timeout: 60000 });
  // What the form will post to the web server now: the staged path and the name, not the file.
  const largest = await input.evaluate((el) => [...new FormData(el.form).values()]
    .reduce((n, v) => n + (typeof v === "string" ? v.length : v.size), 0));
  await page.getByRole("button", { name: "Upload" }).click();
  await page.getByText(/Uploaded large-spec\.md: \d+ sections/).waitFor({ timeout: 60000 });
  assert.ok(largest > 0 && largest < 64 * 1024, `the form posted ${largest} bytes to the web server`);
  const { data: doc } = await admin.from("documents").select("storage_path, size_bytes").eq("project_id", project.id).single();
  assert.ok(doc.size_bytes > 6_000_000 && doc.storage_path.includes("/documents/"));
  assert.equal((await staged(project.id)).length, 0, "the staged copy was removed");
  console.log(`✓ a ${(doc.size_bytes / 1048576).toFixed(1)} MB specification uploaded with a ${largest}-byte form post; staged copy removed`);

  // 2. Only the uploader may remove a staged file; another engineer cannot, and cannot point the form at it either.
  const mine = `${project.id}/uploads/${crypto.randomUUID()}/left-behind.md`;
  assert.ifError((await o.api.storage.from("project-files").upload(mine, new Blob(["# left\n\nThe device shall beep.\n"]), { contentType: "text/markdown" })).error);
  await x.api.storage.from("project-files").remove([mine]);
  assert.equal((await staged(project.id)).length, 1, "another member cannot remove someone else's staged file");
  console.log("✓ staged files can be removed only by the person who uploaded them");

  // 3. The worker sweep lists uncollected staged copies (by age).
  const { data: none } = await admin.rpc("worker_stale_staged_uploads", { p_older_than: "1 hour" });
  assert.ok(!none.some((r) => r.path === mine), "a fresh staged file is left alone");
  const { data: stale } = await admin.rpc("worker_stale_staged_uploads", { p_older_than: "0 seconds" });
  assert.ok(stale.some((r) => r.bucket === "project-files" && r.path === mine));
  assert.match((await o.api.rpc("worker_stale_staged_uploads", {})).error?.message ?? "", /permission denied|not find/);
  await admin.storage.from("project-files").remove([mine]);
  console.log("✓ the worker sweep finds uncollected staged copies; users cannot call it");
  console.log("\nStaged upload flow passed.");
} catch (e) {
  console.error("\n✗ Staged upload flow failed:", e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
