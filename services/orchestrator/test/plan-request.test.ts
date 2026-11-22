/**
 * Plans made by a worker (too large for the web server's request limit), against a real Supabase stack.
 * Skipped when SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY are not set.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";
import { OfflineModel, planContext } from "@vx/planning";
import { WorkerDb } from "../src/db.ts";
import { processPlanRequest } from "../src/plans.ts";

const URL = process.env.SUPABASE_URL;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON = process.env.SUPABASE_ANON_KEY;
const skip = !URL || !SERVICE || !ANON ? "SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and SUPABASE_ANON_KEY are required" : false;

test("a queued plan is made by a worker, with its inputs and task basis; a plan that cannot be stored fails with the reason", { skip }, async () => {
  const admin = createClient(URL!, SERVICE!, { auth: { persistSession: false } });
  const email = `plans-${Date.now()}@example.test`, password = "correct-horse-battery";
  assert.ifError((await admin.auth.admin.createUser({ email, password, email_confirm: true })).error);
  const user = createClient(URL!, ANON!, { auth: { persistSession: false } });
  assert.ifError((await user.auth.signInWithPassword({ email, password })).error);
  const { data: project } = await user.from("projects").insert({ name: "Large plan" }).select("id").single();
  const reqs = ["FUN", "PWR", "MEC", "IFC"].flatMap((k) => [1, 2, 3].map((n) => ({ refCode: `REQ-${k}-00${n}`, kind: "functional", priority: "must", status: "confirmed", text: `${k} requirement ${n}` })));
  assert.ifError((await admin.from("requirements").insert(reqs.map((r) => ({ project_id: project!.id, ref_code: r.refCode, kind: r.kind, status: r.status, priority: r.priority, text: r.text, origin: "manual" })))).error);
  const ctx = planContext({ project: { name: "Large plan" }, references: [{ id: "REF-1", kind: "mockup", title: "Front", filename: "f.png" }] });
  const payload = { requirements: reqs, context: ctx.text, input_ids: ["REF-1"], inputs: [{ id: "REF-1", kind: "reference", label: "Front (mockup)" }], capabilities: [], supervision_mode: "guided" };

  const { data: reqId, error } = await user.rpc("request_plan", { p_project: project!.id, p_payload: payload });
  assert.ifError(error);
  const again = await user.rpc("request_plan", { p_project: project!.id, p_payload: payload });
  assert.match(again.error?.message ?? "", /already being generated/);

  const db = new WorkerDb(URL!, SERVICE!);
  const model = { model: new OfflineModel(), label: "offline-heuristic", offline: true };
  // Other tests' requests may be queued: run the job until ours is done.
  let row;
  for (let i = 0; i < 10; i++) {
    await processPlanRequest(db, model, "test-plans");
    ({ data: row } = await admin.from("plan_requests").select("status, plan_id, error, requirements").eq("id", reqId).single());
    if (row!.status === "done" || row!.status === "failed") break;
  }
  assert.equal(row!.status, "done", row!.error ?? "");
  assert.equal(row!.requirements, 12);
  const { data: plan } = await user.from("plans").select("status, inputs, generator").eq("id", row!.plan_id).single();
  assert.equal(plan!.status, "draft");
  assert.deepEqual((plan!.inputs as { id: string }[]).map((x) => x.id), ["REF-1"]);
  assert.equal((plan!.generator as { request_id: string }).request_id, reqId);
  const { data: env } = await user.from("tasks").select("basis").eq("plan_id", row!.plan_id).eq("key", "enclosure-envelope").single();
  assert.deepEqual((env!.basis as { sources: string[] }).sources, ["REF-1"]);
  const { data: covered } = await user.from("task_requirements").select("requirement_id, tasks!inner(plan_id)").eq("tasks.plan_id", row!.plan_id);
  assert.equal(new Set(covered!.map((c) => c.requirement_id)).size, 12, "every requirement is covered");

  // An update of that plan: the worker revises it with the change (a new requirement and a part) instead of planning again.
  const { data: tasks1 } = await user.from("tasks").select("key").eq("plan_id", row!.plan_id);
  assert.ifError((await admin.from("requirements").insert({ project_id: project!.id, ref_code: "REQ-FUN-004", kind: "functional", status: "confirmed", priority: "must", text: "Read SD cards", origin: "manual" })).error);
  const prevPlan = { version: 1, summary: "first", deferred: [], assumptions: [], tasks: [{ key: "architecture", title: "Architecture", discipline: "architecture" as const, description: "",
    upstream_keys: [], requirement_refs: reqs.map((r) => r.refCode), acceptance_tests: [{ description: "reviewed", method: "human_review" as const, validation_kind: null }],
    risk_level: "medium" as const, required_tools: [], approval_required: false, approval_reason: null, estimated_hours: 4, basis: null }] };
  const revise = { ...payload, requirements: [...reqs, { refCode: "REQ-FUN-004", kind: "functional", priority: "must", status: "confirmed", text: "Read SD cards" }],
    input_ids: ["REF-1", "PT-1"], must_address: [{ id: "PT-1", label: "DM1AA SD card socket" }], revise_from: prevPlan, changes: ["1 part added: PT-1 DM1AA"], changed_refs: [] };
  const { data: revId, error: revErr } = await user.rpc("request_plan", { p_project: project!.id, p_payload: revise });
  assert.ifError(revErr);
  for (let i = 0; i < 10; i++) {
    await processPlanRequest(db, model, "test-plans");
    ({ data: row } = await admin.from("plan_requests").select("status, plan_id, error").eq("id", revId).single());
    if (row!.status === "done" || row!.status === "failed") break;
  }
  assert.equal(row!.status, "done", row!.error ?? "");
  const { data: plan2 } = await user.from("plans").select("generator").eq("id", row!.plan_id).single();
  assert.deepEqual((plan2!.generator as { revision: unknown }).revision, { from_version: 1, changed: ["architecture"], added: [], removed: [], new_requirements: 1 });
  assert.equal((plan2!.generator as { prompt_version: string }).prompt_version, "plan-revise-v1");
  const { data: arch } = await user.from("tasks").select("basis").eq("plan_id", row!.plan_id).eq("key", "architecture").single();
  assert.deepEqual((arch!.basis as { sources: string[] }).sources, ["PT-1"]);
  assert.ok(tasks1!.length > 0);
  await admin.from("requirements").delete().eq("project_id", project!.id).eq("ref_code", "REQ-FUN-004");

  // A request whose plan cannot be stored (a requirement deleted since) fails with the database's reason.
  const bad = { ...payload, requirements: [...reqs, { refCode: "REQ-FUN-099", kind: "functional", priority: "must", status: "confirmed", text: "gone" }] };
  const { data: badId } = await user.rpc("request_plan", { p_project: project!.id, p_payload: bad });
  for (let i = 0; i < 10; i++) {
    await processPlanRequest(db, model, "test-plans");
    ({ data: row } = await admin.from("plan_requests").select("status, plan_id, error").eq("id", badId).single());
    if (row!.status === "done" || row!.status === "failed") break;
  }
  assert.equal(row!.status, "failed");
  assert.match(row!.error!, /unknown requirement REQ-FUN-099/);
  // Members read their project's requests; workers alone claim and complete them.
  assert.equal((await user.from("plan_requests").select("id").eq("project_id", project!.id)).data!.length, 3);
  assert.match((await user.rpc("claim_plan_request", { p_worker_id: "me" })).error?.message ?? "", /permission denied/);
});
