// End-to-end test of the reading model setting and the model comparison.
//  - A specification is extracted; the comparison reads it again with two models and matches the results against it.
//  - The comparison is recorded as AI usage of its own; the project's reading model can be changed.
//
// Needs the app running (VX_LLM=offline: every model is the offline stand-in, so the results match the baseline) and
// the local Supabase stack.
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const { createClient } = createRequire(join(here, "../../../services/orchestrator/package.json"))("@supabase/supabase-js");
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const { SUPABASE_URL: URL, SUPABASE_ANON_KEY: ANON } = process.env;
if (!URL || !ANON) throw new Error("SUPABASE_URL and SUPABASE_ANON_KEY are required");
const stamp = Date.now();
const owner = { email: `compare-${stamp}@example.test`, password: "correct-horse-battery" };
const SPEC = `# Slate spec\n\n## Power\n\nThe slate shall run for 8 hours from a replaceable battery.\n\n## Controls\n\n- Controls | Power, lock/wake, mark/flag as tactile controls; glove-usable.\n- Sensor: Hall effect or optical sensor with hardware interrupt and calibrated closure point.\n`;

const browser = await chromium.launch();
try {
  const page = await (await browser.newContext({ viewport: { width: 1360, height: 900 } })).newPage();
  await page.goto(`${BASE}/login`);
  await page.getByLabel("Email").fill(owner.email);
  await page.getByLabel("Password").fill(owner.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL(/\/projects$/);
  const api = createClient(URL, ANON, { auth: { persistSession: false } });
  assert.ifError((await api.auth.signInWithPassword(owner)).error);
  const { data: project } = await api.from("projects").insert({ name: `Compare ${stamp}` }).select("id").single();
  const P = `${BASE}/projects/${project.id}`;

  await page.goto(`${P}/inputs?step=1`);
  await page.getByLabel("Specification files").setInputFiles([{ name: "slate.md", mimeType: "text/markdown", buffer: Buffer.from(SPEC) }]);
  await page.getByRole("button", { name: "Upload specifications" }).click();
  await page.getByTestId("upload-specification-status").getByText(/^slate\.md: \d+ sections$/).waitFor();
  await page.getByRole("button", { name: "Extract requirements from 1 document(s)" }).click();
  await page.getByText(/^Extracted \d+ requirement\(s\) from 1 document\(s\)\.$/).waitFor();
  assert.match(await page.getByTestId("reading-with").innerText(), /otherwise by Claude Opus 5\.5/);
  const { count: baseline } = await api.from("requirements").select("id", { count: "exact", head: true }).eq("project_id", project.id);
  assert.ok(baseline >= 2, `baseline has requirements (${baseline})`);

  // Compare Sonnet and Haiku (the default choice) against what was read.
  await page.getByTestId("reading-with").getByRole("link", { name: "Change or compare models" }).click();
  await page.waitForURL(/\/compare$/);
  assert.match(await page.getByTestId("compare-costs").innerText(), /Opus 5\.5: [^·]+ · Claude Sonnet 5\.5: [^·]+ · Claude Haiku 5\.5: /);
  await page.getByTestId("compare-form").getByRole("button", { name: "Compare" }).click();
  await page.waitForURL(/\/compare\/[0-9a-f-]{36}$/);
  const summary = page.getByTestId("compare-summary");
  for (const m of ["claude-sonnet-5-5", "claude-haiku-5-5"]) {
    const row = await summary.locator(`tr[data-model='${m}']`).innerText();
    assert.match(row, new RegExp(`\\t${baseline}\\t${baseline} \\(100%\\)\\t0\\t0\\t0\\t0\\t\\$0\\.00`), `${m}: ${row}`);
  }
  assert.match(await summary.innerText(), /Sonnet 5\.5[\s\S]*Haiku 5\.5/);

  // The comparison's calls are recorded as their own activity.
  await page.goto(`${P}/usage`);
  const acts = await page.getByTestId("usage-by-activity").locator("tbody tr").evaluateAll((rows) => rows.map((r) => r.getAttribute("data-activity")));
  assert.ok(acts.includes("Model comparison"), `comparison recorded: ${acts}`);

  // Switch the project to Haiku; the Specifications step says so.
  await page.goto(`${P}/compare`);
  await page.getByLabel("Reading model").selectOption("claude-haiku-5-5");
  await page.getByTestId("reading-model").getByRole("button", { name: "Save" }).click();
  await page.getByText("Specifications and datasheets are now read with Claude Haiku 5.5.").waitFor();
  assert.equal((await api.from("projects").select("reading_model").eq("id", project.id).single()).data.reading_model, "claude-haiku-5-5");
  await page.goto(`${P}/inputs?step=1`);
  assert.match(await page.getByTestId("reading-with").innerText(), /otherwise by Claude Haiku 5\.5/);
  assert.equal(await page.getByTestId("comparisons").count(), 0, "list lives on the compare page");
  console.log("Compare flow passed: reading model shown and changed, two models compared against the saved reading, comparison recorded as AI usage.");
} finally {
  await browser.close();
}
