// End-to-end test of the knowledge base (M-KB): the standards registry is searchable by identifier with edition,
// licence and review flags; a knowledge editor adds an open-licence note (excerpts indexed, file kept) and is
// refused a file for a reference-only source; search returns cited excerpts; the editor verifies the source and
// reviews a standard; a project records which standards apply (proposed, then confirmed); a licensed copy stays
// inside its project; the workspace chat cites the knowledge base; a licence downgrade deletes the stored copy.
//
// Needs the app running (VX_LLM=offline) and the local Supabase stack (./scripts/test-e2e-knowledge.sh).
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
const FIXTURES = join(here, "../../../tests/fixtures/kb");
const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });
const stamp = Date.now();
const editor = { email: `kb-editor-${stamp}@example.test`, password: "correct-horse-battery" };
const outsider = { email: `kb-outsider-${stamp}@example.test`, password: "correct-horse-battery" };

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
  const { data, error } = await api.auth.signInWithPassword(who);
  assert.ifError(error);
  return { api, id: data.user.id };
}
async function search(page, q, project = "") {
  await page.goto(`${BASE}/knowledge?q=${encodeURIComponent(q)}${project ? `&project=${project}` : ""}`);
  return page.getByTestId("results");
}

// Earlier runs leave their copy of the fixture note in the shared library; remove it so results are this run's.
{
  const { data: old } = await admin.from("sources").select("id, storage_path").eq("identifier", "VXN-001").is("project_id", null);
  const paths = (old ?? []).map((o) => o.storage_path).filter(Boolean);
  if (paths.length) await admin.storage.from("knowledge-files").remove(paths);
  if (old?.length) await admin.from("sources").delete().in("id", old.map((o) => o.id));
  await admin.from("standards").update({ edition: null, review_status: "unreviewed", reviewed_at: null, reviewed_by: null,
    edition_note: "Edition not yet confirmed with the issuing body." }).eq("identifier", "IPC-2152");
}

const browser = await chromium.launch();
const ctxOpts = { viewport: { width: 1280, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1 };
try {
  const page = await (await browser.newContext(ctxOpts)).newPage();
  const ed = await signUp(page, editor);

  // 1. Standards registry: found by identifier however it is typed; flags say what is (not) known.
  let results = await search(page, "ipc 2152 trace width");
  const first = results.locator(".hit").first();
  assert.match(await first.innerText(), /IPC-2152 — Standard for Determining Current Carrying Capacity/);
  assert.match(await first.innerText(), /edition unconfirmed/);
  assert.match(await first.innerText(), /Reference only/);
  assert.match(await first.innerText(), /not yet reviewed/);
  assert.equal(await first.getByRole("link", { name: "official source" }).getAttribute("href"), "https://www.ipc.org");
  assert.match(await first.innerText(), /No text is held for this source/);
  await shot(page, "standard-search");
  console.log("✓ standards registry: identifier search with edition, licence and review flags");

  // Only editors may add to the shared library.
  assert.equal(await page.getByTestId("source-form").count(), 0, "non-editors get no shared-library form");
  assert.ifError((await admin.from("knowledge_editors").insert({ user_id: ed.id, note: "e2e" })).error);
  await page.goto(`${BASE}/knowledge`);

  // 2. A reference-only source may not carry a file.
  let form = page.getByTestId("source-form");
  await form.getByLabel("Publisher").fill("IPC");
  await form.getByLabel("Identifier").fill("IPC-2221");
  await form.getByLabel("Official URL").fill("https://www.ipc.org");
  await form.getByLabel(/Reference only/).check();
  await form.locator("input[type=file]").setInputFiles(join(FIXTURES, "oscillator-layout-note.md"));
  await form.getByRole("button", { name: "Add source" }).click();
  await page.getByText(/Reference only: VX Design keeps only the details and the official link/).waitFor();
  console.log("✓ a file is refused for a reference-only source");

  // 3. An open-licence note: excerpts indexed and the file kept.
  form = page.getByTestId("source-form");
  await form.getByLabel("Publisher").fill("VX Design");
  await form.getByLabel("Identifier").fill("VXN-001");
  await form.getByLabel("Edition / revision").fill("A");
  await form.getByLabel("Official URL").fill("https://example.test/notes/vxn-001");
  await form.getByLabel("Kind").selectOption("application_note");
  await form.getByLabel(/Open licence/).check();
  await form.getByLabel("What the terms say").fill("CC BY 4.0, our own note");
  await form.locator("input[type=file]").setInputFiles(join(FIXTURES, "oscillator-layout-note.md"));
  await form.getByRole("button", { name: "Add source" }).click();
  await page.getByText(/Source added: 3 excerpt\(s\) indexed, file kept/).waitFor();
  assert.match(await page.getByTestId("held").innerText(), /3 excerpt\(s\) · stored copy/);
  assert.match(await page.getByTestId("excerpts").innerText(), /§2 Guard ring\n.*at least 2 mm/s);
  const noteUrl = page.url();
  console.log("✓ open-licence note added: 3 cited excerpts, file kept");

  // 4. Search returns the excerpt with its citation.
  results = await search(page, "how far should switching traces be from the crystal guard ring");
  const hit = results.locator(".hit[data-kind=excerpt]").first();
  const hitText = await hit.innerText();
  assert.match(hitText, /VXN-001 — VX Design Note VXN-001: Oscillator Layout/);
  assert.match(hitText, /§2 Guard ring/);
  assert.match(hitText, /edition A/);
  assert.match(hitText, /Open licence/);
  assert.match(hitText, /unverified/);
  assert.ok(await hit.locator("mark").count() > 0, "matched words highlighted");
  await shot(page, "excerpt-search");
  console.log("✓ question finds the cited excerpt (locator, edition, licence, unverified)");

  // 5. The editor verifies the note and reviews a standard's edition.
  await page.goto(noteUrl);
  await page.getByLabel("How it was checked").fill("Compared with the published note (e2e)");
  await page.getByRole("button", { name: "Mark verified" }).click();
  await page.getByText("Verified.").waitFor();
  assert.equal(await page.getByTestId("source-status").innerText(), "verified");
  await page.goto(`${BASE}/knowledge#standards`);
  await page.locator("summary", { hasText: "PCB design & current" }).click();
  const row = page.locator("tr[data-standard='IPC-2152']");
  await row.getByText("Review", { exact: true }).click();
  await row.getByLabel("Edition of IPC-2152", { exact: true }).fill("E2E test edition");
  await row.getByLabel("How the edition of IPC-2152 was confirmed").fill("e2e");
  await row.getByRole("button", { name: "Save review" }).click();
  await page.getByText("Standard reviewed.").waitFor();
  await page.locator("summary", { hasText: "PCB design & current" }).click();
  assert.match(await page.locator("tr[data-standard='IPC-2152']").innerText(), /E2E test edition/);
  console.log("✓ source verified; standard edition reviewed");

  // 6. A project: standards applicability and a licensed copy that stays inside it.
  const { data: project } = await ed.api.from("projects").insert({ name: `Slate KB e2e ${stamp}` }).select("id").single();
  await page.goto(`${BASE}/projects/${project.id}?tab=standards`);
  const { data: ipc2152 } = await admin.from("standards").select("id").eq("identifier", "IPC-2152").single();
  await page.getByLabel("Standard", { exact: true }).selectOption(ipc2152.id);
  await page.getByLabel("Applicability").selectOption("applies");
  await page.getByLabel("Why it applies").fill("The battery path carries up to 2 A.");
  await page.getByRole("button", { name: "Propose" }).click();
  await page.getByText("Proposed: an owner or reviewer confirms it.").waitFor();
  const ps = page.getByTestId("project-standards");
  assert.match(await ps.innerText(), /IPC-2152.*edition E2E test edition.*Applies.*2 A.*proposed/s);
  await ps.getByRole("button", { name: "Confirm" }).click();
  await page.getByText("Confirmed.").waitFor();
  assert.match(await page.getByTestId("project-standards").innerText(), /confirmed/);
  console.log("✓ project standard proposed with a reason, then confirmed");

  await page.getByText("Add a project source").click();
  form = page.getByTestId("source-form");
  await form.getByLabel("Publisher").fill("OtherCo");
  await form.getByLabel("Identifier").fill("SM-7");
  await form.getByLabel(/Licensed copy \(this project\)/).check();
  await form.getByLabel("What the terms say").fill("Received under NDA");
  await form.locator("input[type=file]").setInputFiles(join(FIXTURES, "customer-sensor-module.md"));
  await form.getByRole("button", { name: "Add source" }).click();
  await page.getByText(/Source added: 2 excerpt\(s\) indexed, file kept/).waitFor();
  await page.getByText("Private to this project.").waitFor();
  const ndaUrl = page.url();
  const ndaId = ndaUrl.split("/").pop().split("?")[0];
  const { data: ndaRow } = await admin.from("sources").select("storage_path").eq("id", ndaId).single();
  assert.match(ndaRow.storage_path, new RegExp(`^${project.id}/sources/`));
  results = await search(page, "module shield single point", project.id);
  assert.match(await results.innerText(), /SM-7.*this project only.*Table|SM-7.*this project only/s);
  results = await search(page, "module shield single point");
  assert.doesNotMatch(await page.locator("main").innerText(), /SM-7/, "not in the shared library search");
  console.log("✓ licensed copy stored in the project and found only in that project's searches");

  // 7. Someone outside the project never sees it.
  const opage = await (await browser.newContext(ctxOpts)).newPage();
  const out = await signUp(opage, outsider);
  const { data: theirs } = await out.api.from("projects").insert({ name: `Other ${stamp}` }).select("id").single();
  for (const p of [theirs.id, project.id, null]) {
    const { data, error } = await out.api.rpc("search_knowledge", { p_query: "module shield single point", p_project_id: p, p_limit: 20 });
    assert.ifError(error);
    assert.equal(data.filter((r) => r.source_id === ndaId).length, 0);
  }
  assert.equal((await out.api.from("sources").select("id").eq("id", ndaId)).data.length, 0);
  const { data: leaked } = await out.api.storage.from("project-files").download(ndaRow.storage_path);
  assert.equal(leaked, null, "outsiders cannot download the licensed copy");
  console.log("✓ outsiders cannot find, read or download the licensed copy");

  // 8. The workspace chat cites the knowledge base.
  await page.goto(`${BASE}/projects/${project.id}/workspace`);
  await page.getByLabel("Message").fill("How far should switching traces be from the crystal guard ring?");
  await page.getByRole("button", { name: "Send" }).click();
  const reply = page.locator(".msg-assistant").last();
  await reply.getByTestId("citations").waitFor();
  const cites = await reply.getByTestId("citations").innerText();
  assert.match(cites, /\[K1\] VXN-001 VX Design Note VXN-001: Oscillator Layout \(VX Design\), §2 Guard ring; edition A; open licence; verified/);
  assert.match(await reply.innerText(), /Related references from the knowledge base/);
  await shot(page, "chat-citations");
  console.log("✓ chat answer cites the knowledge base");

  // 9. A licence downgrade deletes the stored copy and the excerpts.
  await page.goto(ndaUrl);
  await page.getByLabel("New licence").selectOption("reference_only");
  await page.getByLabel("Why", { exact: true }).fill("NDA ended; copy returned to OtherCo");
  await page.getByRole("button", { name: "Change licence" }).click();
  await page.getByText(/Licence set to Reference only\. The stored copy was deleted\./).waitFor();
  assert.match(await page.getByTestId("held").innerText(), /0 excerpt\(s\) · no file kept/);
  const { data: gone } = await admin.storage.from("project-files").download(ndaRow.storage_path);
  assert.equal(gone, null, "file removed from storage");
  assert.equal((await admin.from("source_chunks").select("id").eq("source_id", ndaId)).data.length, 0);
  await shot(page, "licence-downgraded");
  console.log("✓ licence downgrade removed the stored copy and excerpts");
  console.log("\nKnowledge base end-to-end flow passed.");
} catch (e) {
  console.error("\n✗ Knowledge base end-to-end flow failed:", e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
