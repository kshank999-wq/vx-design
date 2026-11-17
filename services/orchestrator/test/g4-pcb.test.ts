/**
 * G4 against a real Supabase stack and the engineering worker image:
 *   - the schematic task's approved design feeds the PCB layout task;
 *   - the engineering worker places, routes and checks the board (DRC with schematic parity),
 *     fetches the KiCad library 3D models and stores the project, drawings, renders, STEP and GLB;
 *   - the worker is killed after the layout step: the resumed execution registers the exact
 *     files that passed DRC (no second layout, no second model call);
 *   - the stored project, unzipped in a fresh KiCad container, opens and passes DRC with
 *     schematic parity and ERC with zero errors.
 *
 *   ./scripts/test-g4.sh
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";

const URL = process.env.SUPABASE_URL;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON = process.env.SUPABASE_ANON_KEY;
const IMAGE = process.env.ENGINEERING_WORKER_IMAGE ?? "vx-engineering-worker";
const skip = !URL || !SERVICE || !ANON ? "SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and SUPABASE_ANON_KEY are required" : false;
const admin = () => createClient(URL!, SERVICE!, { auth: { persistSession: false } });

async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 300_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** Forwards this machine's outbound proxy and extra CA (if any) so the container can fetch datasheets and 3D models. */
function proxyArgs(): string[] {
  const args: string[] = [];
  for (const k of ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"]) if (process.env[k]) args.push("-e", `${k}=${process.env[k]}`);
  if (process.env.HTTPS_PROXY) args.push("-e", "NODE_USE_ENV_PROXY=1");
  if (process.env.NODE_EXTRA_CA_CERTS) {
    args.push("-v", `${process.env.NODE_EXTRA_CA_CERTS}:/etc/vx-extra-ca.crt:ro`, "-e", "NODE_EXTRA_CA_CERTS=/etc/vx-extra-ca.crt");
  }
  return args;
}

function engineeringWorker(id: string, env: Record<string, string> = {}): string {
  return execFileSync("docker", ["run", "-d", "--rm", "--network", "host", "--name", id, ...proxyArgs(),
    "-e", `SUPABASE_URL=${URL}`, "-e", `SUPABASE_SERVICE_ROLE_KEY=${SERVICE}`, "-e", "VX_LLM=offline",
    "-e", `WORKER_ID=${id}`, "-e", "WORKER_POLL_MS=500", "-e", "WORKER_LEASE_SECONDS=15",
    ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]), IMAGE], { encoding: "utf8" }).trim();
}

function stop(id: string | undefined): void {
  if (id) try { execFileSync("docker", ["rm", "-f", id], { stdio: "ignore" }); } catch { /* already gone */ }
}

test("pcb layout task: routed KiCad board with DRC, schematic parity and 3D, surviving a worker kill",
     { skip, timeout: 1_200_000 }, async () => {
  const email = `g4-${Date.now()}@example.test`;
  const password = "correct-horse-battery";
  assert.ifError((await admin().auth.admin.createUser({ email, password, email_confirm: true })).error);
  const user = createClient(URL!, ANON!, { auth: { persistSession: false } });
  assert.ifError((await user.auth.signInWithPassword({ email, password })).error);

  const { data: project } = await user.from("projects").insert({ name: "G4 timecode sub-board" }).select("id").single();
  await user.from("requirements").insert([
    { project_id: project!.id, ref_code: "REQ-PWR-001", kind: "power", text: "Regulate 5 V USB input to 3.3 V", priority: "must" },
    { project_id: project!.id, ref_code: "REQ-MEC-001", kind: "mechanical", text: "Fit a 40 x 30 mm outline with M3 holes", priority: "must" },
  ]);
  const { data: planId, error: pe } = await user.rpc("create_plan_version", { p_project_id: project!.id, p_payload: {
    summary: "G4 test plan",
    tasks: [
      { key: "schematic", title: "Power sub-board schematic", discipline: "schematic", requirement_refs: ["REQ-PWR-001"],
        acceptance_tests: [{ id: "AT1", description: "ERC passes with zero errors", method: "validation", validationKind: "erc" }] },
      { key: "pcb-layout", title: "Power sub-board layout", discipline: "pcb_layout", upstream_keys: ["schematic"],
        requirement_refs: ["REQ-MEC-001"],
        acceptance_tests: [{ id: "AT1", description: "DRC passes with zero errors", method: "validation", validationKind: "drc" }] },
    ],
  } });
  assert.ifError(pe);
  await user.rpc("submit_plan", { p_plan_id: planId });
  await user.rpc("decide_plan", { p_plan_id: planId, p_approve: true, p_note: null });
  const authorize = async (name: string) => {
    const { data, error } = await user.rpc("authorize_run", {
      p_plan_id: planId, p_mode: "autonomous", p_max_ai_spend_usd: 5, p_max_compute_spend_usd: 5, p_name: name,
    });
    assert.ifError(error);
    return data as string;
  };
  const tasks = async () => {
    const { data } = await admin().from("tasks").select("id, key, status, blocker_reason").eq("plan_id", planId);
    return new Map((data ?? []).map((t) => [t.key, t]));
  };
  const settled = (s: string) => ["awaiting_approval", "complete", "failed", "blocked"].includes(s);

  let a: string | undefined;
  let b: string | undefined;
  try {
    // 1. Schematic first (G3), approved so its design is committed for the layout.
    const run1 = await authorize("G4 schematic");
    a = engineeringWorker(`g4-a-${Date.now()}`, { VX_STEP_DELAY_MS: "6000" });
    const sch = await waitFor("the schematic task", async () => {
      const t = (await tasks()).get("schematic")!;
      return settled(t.status) ? t : null;
    });
    assert.equal(sch.status, "awaiting_approval", `schematic ended ${sch.status}: ${sch.blocker_reason}`);
    assert.equal((await tasks()).get("pcb-layout")!.status, "ready", "layout waits for the schematic's committed design");
    assert.ifError((await user.rpc("decide_task", { p_task_id: sch.id, p_approve: true, p_note: "Fixture reviewed" })).error);
    await waitFor("the first run's report", async () => (await admin().from("runs").select("report").eq("id", run1).single()).data?.report);

    // 2. Layout. Worker A pauses after each step; kill it once the layout step is checkpointed.
    const run2 = await authorize("G4 layout");
    const layoutTask = (await tasks()).get("pcb-layout")!;
    const victim = await waitFor("worker A to checkpoint the layout step", async () => {
      const { data } = await admin().from("executions").select("id, attempt, status, checkpoint").eq("task_id", layoutTask.id)
        .eq("status", "running").maybeSingle();
      const steps = (data?.checkpoint as { steps?: Record<string, unknown> } | null)?.steps ?? {};
      return data && "layout" in steps ? data : null;
    }, 600_000);
    stop(a);
    a = undefined;
    b = engineeringWorker(`g4-b-${Date.now()}`);
    const done = await waitFor("the layout task to finish", async () => {
      const t = (await tasks()).get("pcb-layout")!;
      return settled(t.status) ? t : null;
    }, 600_000);
    assert.equal(done.status, "awaiting_approval", `layout ended ${done.status}: ${done.blocker_reason}`);

    const { data: execs } = await admin().from("executions").select("id, status, resumed_from_id, attempt").eq("task_id", done.id).order("created_at");
    const resumed = execs!.find((e) => e.resumed_from_id === victim.id);
    assert.ok(resumed, "a new execution resumed the killed one");
    assert.equal(resumed.attempt, victim.attempt);
    const { data: logRows } = await admin().from("execution_logs").select("execution_id, message").in("execution_id", execs!.map((e) => e.id)).order("id");
    const logs = (id: string) => (logRows ?? []).filter((l) => l.execution_id === id).map((l) => l.message);
    assert.ok(logs(resumed.id).includes("step layout: reused from checkpoint"), "layout (model + routing) not redone");
    assert.equal(logRows!.filter((l) => l.message.startsWith("model call")).length, 1, "one model call across both executions");

    // 3. Outputs and checks.
    const { data: versions } = await admin().from("artifact_versions")
      .select("id, status, validated_at, storage_path, sha256, size_bytes, artifacts(name)").eq("produced_by_task_id", done.id);
    const byName = new Map((versions ?? []).map((v) => [(v.artifacts as unknown as { name: string }).name, v]));
    const names = ["kicad-project", "render-3d", "render-top", "render-bottom", "pcb-top-svg", "pcb-bottom-svg", "pcb-pdf",
                   "board-step", "board-glb", "drc-report", "model-report", "layout"];
    for (const n of names) assert.ok(byName.get(`pcb-layout/${n}`)?.validated_at, `pcb-layout/${n} stored and validated`);
    assert.equal(versions!.length, names.length, "one version per output: the resume registered the stashed files, not a rebuild");

    const { data: checks } = await admin().from("validations").select("kind, result, summary").eq("task_id", done.id);
    const drc = checks!.find((c) => c.kind === "drc")!;
    assert.equal(drc.result, "pass", drc.summary);
    assert.match(drc.summary, /0 errors, 0 warnings, 0 unrouted, 0 waived/);
    assert.ok(checks!.some((c) => c.kind === "other" && c.result === "pass" && /matches the schematic/.test(c.summary)));
    const models = checks!.find((c) => c.kind === "footprint_check")!;
    console.log(`  ${models.summary}`);

    const download = async (n: string) =>
      Buffer.from(await (await admin().storage.from("project-files").download(byName.get(`pcb-layout/${n}`)!.storage_path)).data!.arrayBuffer());
    const step = await download("board-step");
    assert.ok(step.subarray(0, 12).toString() === "ISO-10303-21");
    if (models.result === "pass") {
      assert.match(step.toString("latin1"), /SOT-23-5|SOT_23_5|SOT23/i, "board STEP carries the regulator's 3D model");
    }
    assert.equal((await download("render-3d")).subarray(1, 4).toString(), "PNG");
    assert.equal((await download("board-glb")).subarray(0, 4).toString(), "glTF");

    // 4. The stored project opens in a fresh KiCad container: DRC with schematic parity and ERC are clean.
    const dir = mkdtempSync(join(tmpdir(), "vx-g4-"));
    chmodSync(dir, 0o777);
    writeFileSync(join(dir, "project.zip"), await download("kicad-project"));
    const out = execFileSync("docker", ["run", "--rm", "-v", `${dir}:/w`, "--entrypoint", "bash", IMAGE, "-c",
      "mkdir /tmp/p && cd /tmp/p && python3 -m zipfile -e /w/project.zip . && cd */ && ls && " +
      "kicad-cli pcb drc --schematic-parity --severity-all --format json -o /tmp/drc.json *.kicad_pcb >/dev/null; " +
      "kicad-cli sch erc --format json --severity-all -o /tmp/erc.json *.kicad_sch >/dev/null; " +
      "python3 -c \"import json; d=json.load(open('/tmp/drc.json')); e=json.load(open('/tmp/erc.json')); " +
      "print('DRC', len(d['violations']), len(d['unconnected_items']), len(d['schematic_parity'])); " +
      "print('ERC', sum(len(s['violations']) for s in e['sheets']))\""], { encoding: "utf8" });
    assert.match(out, /\.kicad_pcb/);
    assert.match(out, /DRC 0 0 0/, out);
    assert.match(out, /ERC 0/, out);

    // 5. Sign-off commits every output.
    assert.ifError((await user.rpc("decide_task", { p_task_id: done.id, p_approve: true, p_note: "Fixture board reviewed" })).error);
    const { data: after } = await admin().from("artifact_versions").select("status").eq("produced_by_task_id", done.id);
    assert.ok(after!.every((v) => v.status === "committed"));
    await waitFor("the layout run's report", async () => (await admin().from("runs").select("report").eq("id", run2).single()).data?.report);
  } finally {
    stop(a);
    stop(b);
  }
});
