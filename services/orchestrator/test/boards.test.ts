/**
 * A product of two boards, each designed over several tasks, from calculation to fab packages, against a real
 * Supabase stack and the engineering worker image (offline model, so every output is the fixture and needs sign-off):
 *   - a simulation task computes its numbers in code and passes its checks;
 *   - the second schematic task of board "tc" builds on the first (the design so far is its starting point);
 *   - the second layout task of "tc" takes over the first one's board instead of laying it out again;
 *   - the schematic review gathers every upstream check and is signed off;
 *   - one manufacturing task packages both boards;
 *   - the hardware test after manufacturing adds a draft test procedure and waits for built units.
 *
 *   ./scripts/test-boards.sh
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

const URL = process.env.SUPABASE_URL;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON = process.env.SUPABASE_ANON_KEY;
const IMAGE = process.env.ENGINEERING_WORKER_IMAGE ?? "vx-engineering-worker";
const skip = !URL || !SERVICE || !ANON ? "SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and SUPABASE_ANON_KEY are required" : false;
const admin = () => createClient(URL!, SERVICE!, { auth: { persistSession: false } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function proxyArgs(): string[] {
  const args: string[] = [];
  for (const k of ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"]) if (process.env[k]) args.push("-e", `${k}=${process.env[k]}`);
  if (process.env.HTTPS_PROXY) args.push("-e", "NODE_USE_ENV_PROXY=1");
  if (process.env.NODE_EXTRA_CA_CERTS) args.push("-v", `${process.env.NODE_EXTRA_CA_CERTS}:/etc/vx-extra-ca.crt:ro`, "-e", "NODE_EXTRA_CA_CERTS=/etc/vx-extra-ca.crt");
  return args;
}

test("two boards over several tasks: built up, reused, reviewed, packaged together", { skip, timeout: 2_400_000 }, async () => {
  const email = `boards-${Date.now()}@example.test`;
  const password = "correct-horse-battery";
  assert.ifError((await admin().auth.admin.createUser({ email, password, email_confirm: true })).error);
  const user = createClient(URL!, ANON!, { auth: { persistSession: false } });
  assert.ifError((await user.auth.signInWithPassword({ email, password })).error);
  const { data: project, error: projErr } = await user.from("projects").insert({ name: "Two-board slate" }).select("id").single();
  assert.ifError(projErr);
  await user.from("requirements").insert([
    { project_id: project!.id, ref_code: "REQ-PWR-001", kind: "power", text: "The slate shall draw between 50 mA and 400 mA from USB.", priority: "must" },
  ]);
  const t = (key: string, discipline: string, upstream: string[] = [], extra: object = {}) => ({ key, title: key, discipline, upstream_keys: upstream, ...extra });
  const { data: planId, error: pe } = await user.rpc("create_plan_version", { p_project_id: project!.id, p_payload: { summary: "two boards", tasks: [
    t("holdover", "simulation"),
    t("tc-core", "schematic", ["holdover"], { board: "tc" }),
    t("tc-io", "schematic", ["tc-core"], { board: "tc" }),
    t("main-sch", "schematic", [], { board: "main" }),
    t("sch-review", "verification", ["tc-io", "main-sch"]),
    t("tc-stackup", "pcb_layout", ["tc-io"], { board: "tc" }),
    t("tc-route", "pcb_layout", ["tc-stackup", "sch-review"], { board: "tc" }),
    t("main-layout", "pcb_layout", ["main-sch", "sch-review"], { board: "main" }),
    t("fab", "manufacturing", ["tc-route", "main-layout"]),
    t("hw-test", "verification", ["fab"], { requirement_refs: ["REQ-PWR-001"] }),
  ] } });
  assert.ifError(pe);
  assert.ifError((await user.rpc("submit_plan", { p_plan_id: planId })).error);
  assert.ifError((await user.rpc("decide_plan", { p_plan_id: planId, p_approve: true, p_note: null })).error);
  const { data: boards } = await admin().from("tasks").select("key, board").eq("plan_id", planId).not("board", "is", null);
  assert.equal(boards!.length, 6, "boards stored with the tasks");

  const tasks = async () => new Map(((await admin().from("tasks").select("id, key, status, blocker_reason").eq("plan_id", planId)).data ?? []).map((x) => [x.key, x]));
  const eng = execFileSync("docker", ["run", "-d", "--rm", "--network", "host", "--name", `boards-${Date.now()}`, ...proxyArgs(),
    "-e", `SUPABASE_URL=${URL}`, "-e", `SUPABASE_SERVICE_ROLE_KEY=${SERVICE}`, "-e", "VX_LLM=offline",
    "-e", "WORKER_ID=boards-worker", "-e", "WORKER_POLL_MS=500", IMAGE], { encoding: "utf8" }).trim();
  try {
    const end = Date.now() + 2_200_000;
    for (;;) {
      const s = await tasks();
      if (s.get("fab")!.status === "complete" && s.get("hw-test")!.status === "blocked") break;
      const bad = [...s.values()].filter((x) => x.status === "failed" || (x.status === "blocked" && x.key !== "hw-test"));
      assert.equal(bad.length, 0, bad.map((b) => `${b.key} ${b.status}: ${b.blocker_reason}`).join("; "));
      for (const x of s.values()) {
        if (x.status === "awaiting_approval") assert.ifError((await user.rpc("decide_task", { p_task_id: x.id, p_approve: true, p_note: "ok" })).error);
      }
      const { data: active } = await admin().from("runs").select("id").eq("plan_id", planId).in("status", ["pending", "running", "paused"]);
      if (!active?.length && [...s.values()].some((x) => ["ready", "draft"].includes(x.status))) {
        const { error } = await user.rpc("authorize_run", { p_plan_id: planId, p_mode: "autonomous", p_max_ai_spend_usd: 5, p_max_compute_spend_usd: 5, p_name: "boards" });
        assert.ifError(error);
      }
      if (Date.now() > end) throw new Error(`timed out: ${[...s.values()].map((x) => `${x.key}=${x.status}`).join(", ")}`);
      await sleep(2000);
    }

    const s = await tasks();
    const names = async (key: string) => new Map(((await admin().from("artifact_versions").select("storage_path, tool_config, artifacts(name)")
      .eq("produced_by_task_id", s.get(key)!.id)).data ?? []).map((v) => [(v.artifacts as unknown as { name: string }).name, v]));
    const checks = async (key: string) => (await admin().from("validations").select("kind, result, summary").eq("task_id", s.get(key)!.id)).data ?? [];
    const logs = async (key: string) => ((await admin().from("execution_logs").select("message, executions!inner(task_id)").eq("executions.task_id", s.get(key)!.id)).data ?? []).map((l) => l.message).join("\n");

    // Simulation: numbers computed in code.
    const sim = await checks("holdover");
    assert.ok(sim.some((c) => c.kind === "simulation" && c.result === "pass" && /C1 passes/.test(c.summary)), JSON.stringify(sim));
    assert.ok((await names("holdover")).has("holdover/analysis"));

    // The second "tc" layout took the first one's board over.
    const route = await checks("tc-route");
    assert.ok(route.some((c) => c.kind === "drc" && /^Board taken over from tc-stackup \(same circuit design version\): KiCad DRC: 0 errors/.test(c.summary)), JSON.stringify(route));
    assert.match(await logs("tc-route"), /design unchanged since tc-stackup/);
    assert.ok((await names("tc-route")).has("tc-route/kicad-project"));

    // The review gathered upstream checks.
    const review = await checks("sch-review");
    assert.ok(review.some((c) => /Upstream tool checks: \d+ recorded, 0 failing/.test(c.summary)), JSON.stringify(review));

    // One fab task, two packages.
    const fab = await names("fab");
    for (const b of ["main", "tc"]) assert.ok(fab.has(`fab.${b}/fab-package`), `fab package for ${b}: ${[...fab.keys()].join(", ")}`);
    const fabChecks = await checks("fab");
    assert.ok(fabChecks.some((c) => c.summary.startsWith("main: ")) && fabChecks.some((c) => c.summary.startsWith("tc: ")));

    // The hardware test waits for units, with its procedure on the Validation page.
    assert.match(s.get("hw-test")!.blocker_reason ?? "", /Hardware test: waiting for built units\. Draft test procedure\(s\) TP-\d{3}/);
    const { data: procs } = await admin().from("test_procedures").select("code, requirement_refs, measurements, status").eq("project_id", project!.id);
    assert.equal(procs!.length, 1);
    assert.deepEqual(procs![0]!.requirement_refs, ["REQ-PWR-001"]);
    assert.equal(procs![0]!.status, "draft");
    const m = (procs![0]!.measurements as { min?: number; max?: number; unit?: string }[])[0]!;
    assert.deepEqual([m.min, m.max, m.unit], [50, 400, "mA"], "limits read from the requirement text");
  } finally {
    try { execFileSync("docker", ["rm", "-f", eng], { stdio: "ignore" }); } catch { /* gone */ }
  }
});
