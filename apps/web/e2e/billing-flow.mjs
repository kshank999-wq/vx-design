// End-to-end test of billing: prepaid balance, card top-up through Stripe Checkout (a stand-in Stripe on port 4243),
// plan choice with its fee, per-call charges on the statement and CSV, AI paused at a used-up balance, and a payment
// whose browser never came back credited at the next visit.
//
// Needs the app running with STRIPE_SECRET_KEY=sk_test_fake VX_STRIPE_API=http://localhost:4243/v1 (and VX_LLM=offline),
// and the local Supabase stack.
import { createRequire } from "node:module";
import { createServer } from "node:http";
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
const owner = { email: `billing-${stamp}@example.test`, password: "correct-horse-battery" };

// Stand-in Stripe: creates Checkout sessions, shows a pay page, and reports sessions.
const sessions = new Map();
const fake = createServer(async (req, res) => {
  const u = new globalThis.URL(req.url, "http://localhost:4243");
  let body = ""; for await (const c of req) body += c;
  const json = (code, o) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
  if (req.method === "POST" && u.pathname === "/v1/checkout/sessions") {
    if (req.headers.authorization !== "Bearer sk_test_fake") return json(401, { error: { message: "bad key" } });
    const f = new URLSearchParams(body);
    const id = `cs_test_${stamp}${sessions.size}`;
    const s = { id, url: `http://localhost:4243/pay/${id}`, status: "open", payment_status: "unpaid", currency: f.get("line_items[0][price_data][currency]"),
      amount_total: Number(f.get("line_items[0][price_data][unit_amount]")), client_reference_id: f.get("client_reference_id"),
      metadata: { account: f.get("metadata[account]"), purpose: f.get("metadata[purpose]") }, success_url: f.get("success_url") };
    sessions.set(id, s);
    return json(200, s);
  }
  const got = u.pathname.match(/^\/v1\/checkout\/sessions\/(cs_\w+)$/);
  if (req.method === "GET" && got) return sessions.has(got[1]) ? json(200, sessions.get(got[1])) : json(404, { error: { message: "no such session" } });
  const pay = u.pathname.match(/^\/pay\/(cs_\w+)$/);
  if (pay && sessions.has(pay[1])) {
    const s = sessions.get(pay[1]);
    if (req.method === "POST") {
      Object.assign(s, { status: "complete", payment_status: "paid" });
      res.writeHead(303, { Location: s.success_url.replace("{CHECKOUT_SESSION_ID}", s.id) }); return res.end();
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    return res.end(`<h1>Pay $${(s.amount_total / 100).toFixed(2)}</h1><form method="post"><button>Pay</button></form>`);
  }
  json(404, { error: { message: "not found" } });
});
await new Promise((r) => fake.listen(4243, r));

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

  // A new account is on the internal plan: not billed.
  await page.goto(`${BASE}/account`);
  await page.getByTestId("billing-link").getByRole("link", { name: "Billing" }).click();
  await page.waitForURL(/\/account\/billing$/);
  assert.equal(await page.getByTestId("balance-amount").innerText(), "$0.00");
  assert.match(await page.getByTestId("balance").innerText(), /Standard[\s\S]*Not billed/);

  // Studio's fee needs credit first.
  await page.getByTestId("offer-studio").getByRole("button", { name: "Choose Studio" }).click();
  await page.getByRole("alert").getByText(/fee for this month is \$50\.00; add \$50\.00 of credit first/).waitFor();

  // Top up $120 by card.
  await page.getByTestId("add-credit").getByPlaceholder("Other").fill("120");
  await page.getByRole("button", { name: "Pay by card" }).click();
  await page.waitForURL(/localhost:4243\/pay\//);
  assert.match(await page.locator("h1").innerText(), /Pay \$120\.00/);
  await page.getByRole("button", { name: "Pay" }).click();
  await page.waitForURL(/\/account\/billing\?session_id=cs_test_/);
  await page.getByText("Payment received; your balance is updated.").waitFor();
  assert.equal(await page.getByTestId("balance-amount").innerText(), "$120.00");
  await page.reload();   // the same payment is not added twice
  assert.equal(await page.getByTestId("balance-amount").innerText(), "$120.00");

  await page.getByTestId("offer-studio").getByRole("button", { name: "Choose Studio" }).click();
  await page.getByText("Plan changed.").waitFor();
  assert.equal(await page.getByTestId("balance-amount").innerText(), "$70.00");
  assert.match(await page.getByTestId("current-plan").innerText(), /Studio/);

  // AI calls are charged as they are recorded, and listed on the statement with their detail.
  const { data: project } = await api.from("projects").insert({ name: `Billing ${stamp}` }).select("id").single();
  assert.ifError((await api.rpc("record_ai_call", { p_project: project.id, p_execution: null, p_purpose: "generate_plan", p_model: "claude-opus-5-5",
    p_input: 40000, p_output: 60000, p_cache_read: 0, p_cache_write: 0, p_cost_usd: 1.36, p_duration_ms: 240000, p_failed: false })).error);
  await page.goto(`${BASE}/account/billing`);
  assert.equal(await page.getByTestId("balance-amount").innerText(), "$68.64");
  // Customers see what they were charged, never our cost or the markup.
  assert.match(await page.getByTestId("month-summary").innerText(), /usage \$1\.36 plus \$50\.00 in plan fees/);
  assert.doesNotMatch(await page.locator("main").innerText(), /our cost|markup/i);
  const month = new Date().toISOString().slice(0, 7);
  await page.getByTestId("statements").getByRole("link").first().click();
  await page.waitForURL(new RegExp(`/statement/${month}$`));
  const lines = await page.getByTestId("statement-lines").innerText();
  assert.match(lines, /Credit: Card payment[\s\S]*Plan fee: Studio plan[\s\S]*Usage: AI · claude-opus-5-5\tBilling \d+\tPlanning: full plan\t40\.0K \/ 60\.0K\t−\$1\.3600/);
  assert.equal(await page.getByTestId("closing").innerText(), "$68.64");
  const csv = await (await page.request.get(`${BASE}/account/billing/statement/${month}/csv`)).text();
  assert.match(csv, /^time_utc,kind,description,project,activity,model,input_tokens,output_tokens/);
  assert.match(csv, /,Usage,AI · claude-opus-5-5,Billing \d+,Planning: full plan,claude-opus-5-5,40000,60000,0,0,-1\.36\n/);
  assert.doesNotMatch(csv, /our_cost/);

  // An administrator (VX Design staff) sees our cost beside the charge, and the earnings page.
  if (process.env.SUPABASE_SERVICE_ROLE_KEY) {
    const svc = createClient(URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    const { data: me } = await api.auth.getUser();
    assert.ifError((await svc.from("platform_admins").insert({ user_id: me.user.id, note: "e2e" })).error);
    await page.goto(`${BASE}/account/billing`);
    assert.match(await page.getByTestId("month-summary").innerText(), /admin: our cost \$1\.36/);
    await page.goto(`${BASE}/admin/earnings`);
    assert.match(await page.getByTestId("earnings-customers").innerText(), new RegExp(`${owner.email.replace(/[.+]/g, "\\$&")}\\tStudio\\t1\\t\\$1\\.36\\t\\$1\\.36\\t\\$0\\.00`));
    await page.getByTestId("earnings-in-house").waitFor();
    assert.ifError((await svc.from("platform_admins").delete().eq("user_id", me.user.id)).error);
    await page.goto(`${BASE}/admin/earnings`);
    await page.getByText(/This page could not be found|404/).first().waitFor();
    console.log("✓ administrators see our cost and the earnings page; customers do not");
  }
  assert.match(csv, /closing_balance,68\.64/);

  // Spending past the balance pauses AI work: the next AI action is refused before any call is made.
  assert.ifError((await api.rpc("record_ai_call", { p_project: project.id, p_execution: null, p_purpose: "generate_plan", p_model: "claude-opus-5-5",
    p_input: 1, p_output: 1, p_cache_read: 0, p_cache_write: 0, p_cost_usd: 70, p_duration_ms: 1, p_failed: false })).error);
  await page.goto(`${BASE}/projects/${project.id}/inputs?step=1`);
  await page.getByLabel("Specification files").setInputFiles([{ name: "spec.md", mimeType: "text/markdown", buffer: Buffer.from("# Spec\n\n## Power\n\nIt runs 8 hours, and charges over USB-C.\n") }]);
  await page.getByRole("button", { name: "Upload specifications" }).click();
  await page.getByTestId("upload-specification-status").getByText(/^spec\.md: \d+ sections$/).waitFor();
  await page.getByRole("button", { name: "Extract requirements from 1 document(s)" }).click();
  await page.getByRole("alert").getByText(/AI work is paused: the prepaid balance is used up/).waitFor();
  const { count: calls } = await api.from("cost_events").select("id", { count: "exact", head: true }).eq("project_id", project.id);
  assert.equal(calls, 2, "no call was made");

  // A payment whose browser never returned is credited at the next visit.
  await page.goto(`${BASE}/account/billing`);
  await page.getByText("The balance is used up: AI work is paused until credit is added. Nothing is lost.").waitFor();
  await page.getByTestId("add-credit").getByLabel("$20").check();
  await page.getByRole("button", { name: "Pay by card" }).click();
  await page.waitForURL(/localhost:4243\/pay\//);
  const open = [...sessions.values()].find((s) => s.status === "open");
  Object.assign(open, { status: "complete", payment_status: "paid" });   // paid, but the buyer closed the tab
  await page.goto(`${BASE}/account/billing`);
  await page.getByText("1 earlier payment(s) confirmed by Stripe and added to your balance.").waitFor();
  assert.equal(await page.getByTestId("balance-amount").innerText(), "$18.64");
  console.log("Billing flow passed: internal plan not billed, card top-up credited once, plan fee charged, calls charged and listed on the statement and CSV, AI paused at zero, a closed-tab payment credited at the next visit.");
} finally {
  await browser.close();
  fake.close();
}
