// End-to-end test of build vs buy: catalog modules matched against a need (fits / reasons / unknowns), AI suggestions
// kept only when a distributor confirms the part number, and a trade study of the fitting modules against a custom design.
// Needs the app running (VX_LLM=offline, no distributor keys) and the local Supabase stack.
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
const owner = { email: `bvb-${stamp}@example.test`, password: "correct-horse-battery" };

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
  const { data: project } = await api.from("projects").insert({ name: `BvB ${stamp}` }).select("id").single();
  const mod = (name, extra) => api.rpc("save_module", { p_id: null, p_module: { kind: "radio_module", name, manufacturer: "Test", mpn: `${name}-${stamp}`, normalized_mpn: `${name}-${stamp}`.toUpperCase().replace(/[^A-Z0-9]/g, ""),
    interfaces: ["UART", "SPI"], radios: ["802.11n", "Bluetooth LE"], supply: { v_min: 3.0, v_max: 3.6 }, dimensions_mm: { x: 18, y: 25 }, performance: {},
    certifications: [{ regime: "FCC", id: "2AXX-1", note: "test grant" }, { regime: "CE/RED", id: "RED-1", note: "test grant" }], cad: [], lifecycle: "active",
    source_note: "e2e test entry", ...extra } });
  assert.ifError((await mod(`Fit${stamp}`, {})).error);
  assert.ifError((await mod(`Five${stamp}`, { supply: { v_min: 4.5, v_max: 5.5 } })).error);

  const P = `${BASE}/projects/${project.id}`;
  await page.goto(`${P}/build-vs-buy?title=${encodeURIComponent("Wireless link to the host")}&radios=${encodeURIComponent("Wi-Fi, BLE")}&interfaces=UART&supply_v=3.3&regions=${encodeURIComponent("FCC, CE/RED")}&quantity=500`);
  const table = page.getByTestId("matches");
  await table.waitFor();
  assert.match(await table.locator("h2").innerText(), /Radio module/, "kind guessed from the name");
  assert.equal(await table.locator(`tr[data-fits=yes]`).filter({ hasText: `Fit${stamp}` }).count(), 1);
  assert.match(await table.locator(`tr[data-fits=no]`).filter({ hasText: `Five${stamp}` }).innerText(), /supply 4\.5–5\.5 V does not accept the 3\.3 V rail/);

  // AI suggestions: kept only when a distributor knows the part number (none configured here).
  await table.getByRole("button", { name: "Find more modules with AI" }).click();
  await page.getByText(/Not found at the distributors, so left out: Offline stand-in module \(OFFLINE-MODULE-1\)/).waitFor();
  assert.equal((await api.from("modules").select("id").eq("normalized_mpn", "OFFLINEMODULE1")).data.length, 0, "unconfirmed suggestion not saved");

  // The comparison: the fitting module against a custom design.
  await page.getByTestId("matches").getByRole("button", { name: /Compare 1 module\(s\) with a custom design/ }).click();
  await page.waitForURL(/\/trades\/[0-9a-f-]{36}/);
  await page.getByText(/Build vs buy: 1 module\(s\) against a custom design/).waitFor();
  const body = await page.locator("main").innerText();
  assert.match(body, /Wireless link to the host: buy a module or design it\?/);
  assert.match(body, /Custom design \(chip-down\)/);
  assert.match(body, new RegExp(`Fit${stamp}`));
  assert.doesNotMatch(body, new RegExp(`Five${stamp}.*\\n.*Pre-certified`), "the module that does not fit is not an option");
  const { data: study } = await api.from("trade_studies").select("options, scores, result").eq("project_id", project.id).single();
  assert.deepEqual(study.options.map((o) => o.key).slice(-1), ["custom"]);
  assert.equal(study.result.winner, study.options[0].key, "the certified module wins on these criteria");
  assert.equal(study.scores.custom.nre.value, 160 * 120 + 15000);
  console.log("Build vs buy flow passed: modules matched with reasons, unconfirmed AI suggestion left out, trade study of module vs custom ranked.");
} finally {
  await browser.close();
}
