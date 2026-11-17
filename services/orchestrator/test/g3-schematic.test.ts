/**
 * G3 against a real Supabase stack and the engineering worker image:
 *   - a worker without KiCad leaves schematic tasks alone;
 *   - the engineering worker designs the circuit, builds the KiCad project, runs ERC, checks the
 *     netlist and datasheets, and stores everything as scratch outputs awaiting sign-off;
 *   - the stored project, unzipped in a fresh container, opens and passes ERC in KiCad.
 *
 *   ./scripts/test-g3.sh
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";

const URL = process.env.SUPABASE_URL;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON = process.env.SUPABASE_ANON_KEY;
const IMAGE = process.env.ENGINEERING_WORKER_IMAGE ?? "vx-engineering-worker";
const skip = !URL || !SERVICE || !ANON ? "SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and SUPABASE_ANON_KEY are required" : false;
const admin = () => createClient(URL!, SERVICE!, { auth: { persistSession: false } });

async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 120_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

function plainWorker(id: string): ChildProcess {
  return spawn(process.execPath, [join(import.meta.dirname, "../src/main.ts")], {
    env: { ...process.env, WORKER_ID: id, VX_LLM: "offline", WORKER_POLL_MS: "300", VX_ENGINEERING: "off" },
    stdio: ["ignore", "ignore", "inherit"],
  });
}

/** Forwards this machine's outbound proxy and extra CA (if any) so the container can fetch datasheets. */
function proxyArgs(): string[] {
  const args: string[] = [];
  for (const k of ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"]) if (process.env[k]) args.push("-e", `${k}=${process.env[k]}`);
  if (process.env.HTTPS_PROXY) args.push("-e", "NODE_USE_ENV_PROXY=1");
  if (process.env.NODE_EXTRA_CA_CERTS) {
    args.push("-v", `${process.env.NODE_EXTRA_CA_CERTS}:/etc/vx-extra-ca.crt:ro`, "-e", "NODE_EXTRA_CA_CERTS=/etc/vx-extra-ca.crt");
  }
  return args;
}

function engineeringWorker(id: string): string {
  return execFileSync("docker", ["run", "-d", "--rm", "--network", "host", "--name", id, ...proxyArgs(),
    "-e", `SUPABASE_URL=${URL}`, "-e", `SUPABASE_SERVICE_ROLE_KEY=${SERVICE}`, "-e", "VX_LLM=offline",
    "-e", `WORKER_ID=${id}`, "-e", "WORKER_POLL_MS=500", IMAGE], { encoding: "utf8" }).trim();
}

test("schematic task: KiCad project with ERC, netlist check and component evidence", { skip, timeout: 600_000 }, async () => {
  const email = `g3-${Date.now()}@example.test`;
  const password = "correct-horse-battery";
  assert.ifError((await admin().auth.admin.createUser({ email, password, email_confirm: true })).error);
  const user = createClient(URL!, ANON!, { auth: { persistSession: false } });
  assert.ifError((await user.auth.signInWithPassword({ email, password })).error);

  const { data: project } = await user.from("projects").insert({ name: "G3 timecode sub-board" }).select("id").single();
  await user.from("requirements").insert([
    { project_id: project!.id, ref_code: "REQ-PWR-001", kind: "power", text: "Regulate 5 V USB input to 3.3 V", priority: "must" },
  ]);
  const { data: planId, error: pe } = await user.rpc("create_plan_version", { p_project_id: project!.id, p_payload: {
    summary: "G3 test plan",
    tasks: [{ key: "schematic", title: "Power sub-board schematic", discipline: "schematic", requirement_refs: ["REQ-PWR-001"],
              acceptance_tests: [{ id: "AT1", description: "ERC passes with zero errors", method: "validation", validationKind: "erc" }] }],
  } });
  assert.ifError(pe);
  await user.rpc("submit_plan", { p_plan_id: planId });
  await user.rpc("decide_plan", { p_plan_id: planId, p_approve: true, p_note: null });
  const { data: runId, error: ae } = await user.rpc("authorize_run", {
    p_plan_id: planId, p_mode: "autonomous", p_max_ai_spend_usd: 5, p_max_compute_spend_usd: 5, p_name: "G3",
  });
  assert.ifError(ae);
  const task = async () => (await admin().from("tasks").select("id, status, blocker_reason").eq("plan_id", planId).single()).data!;

  // 1. A worker without KiCad checks in but leaves the schematic task alone.
  const plain = plainWorker("plain-worker");
  let eng: string | undefined;
  try {
    const registered = await waitFor("the plain worker to check in", async () =>
      (await admin().from("workers").select("disciplines").eq("id", "plain-worker").maybeSingle()).data);
    assert.ok(!registered.disciplines.includes("schematic"));
    await new Promise((r) => setTimeout(r, 3000));
    assert.equal((await task()).status, "ready", "plain worker did not claim or block the schematic task");

    // 2. The engineering worker takes it.
    eng = engineeringWorker(`eng-worker-${Date.now()}`);
    const done = await waitFor("the schematic task to finish", async () => {
      const t = await task();
      return ["awaiting_approval", "complete", "failed", "blocked"].includes(t.status) ? t : null;
    }, 400_000);
    assert.equal(done.status, "awaiting_approval", `task ended ${done.status}: ${done.blocker_reason}`);   // offline output needs sign-off

    const { data: versions } = await admin().from("artifact_versions")
      .select("id, status, validated_at, storage_path, content_type, artifacts(name)").eq("produced_by_task_id", done.id);
    const byName = new Map((versions ?? []).map((v) => [(v.artifacts as unknown as { name: string }).name, v]));
    for (const n of ["kicad-project", "schematic-svg", "schematic-pdf", "erc-report", "netlist", "bom", "component-evidence", "design"]) {
      assert.ok(byName.get(`schematic/${n}`)?.validated_at, `schematic/${n} stored and validated`);
    }
    const { data: checks } = await admin().from("validations").select("kind, result, evidence_category, summary").eq("task_id", done.id);
    const erc = checks!.find((c) => c.kind === "erc")!;
    assert.equal(erc.result, "pass");
    assert.match(erc.summary, /0 errors/);
    assert.ok(checks!.some((c) => c.kind === "other" && /netlist matches/.test(c.summary)));
    assert.equal(checks!.find((c) => c.kind === "footprint_check")!.result, "pass");

    const ev = JSON.parse(await (await admin().storage.from("project-files").download(byName.get("schematic/component-evidence")!.storage_path)).data!.text());
    const u1 = ev.components.find((c: { ref: string }) => c.ref === "U1");
    assert.equal(u1.library.pads_match, true);
    if (u1.datasheet?.status === "checked") {
      assert.equal(u1.status, "verified", "AP2112 part number and ratings found in the datasheet text");
    } else {
      console.log(`  (datasheet not reachable from here: ${u1.datasheet?.error}; evidence marked ${u1.status})`);
      assert.equal(u1.status, "unverified");
    }

    // 3. The stored project opens and passes ERC in a fresh KiCad container.
    const zip = await (await admin().storage.from("project-files").download(byName.get("schematic/kicad-project")!.storage_path)).data!.arrayBuffer();
    const dir = mkdtempSync(join(tmpdir(), "vx-g3-"));
    chmodSync(dir, 0o777);
    writeFileSync(join(dir, "project.zip"), Buffer.from(zip));
    const out = execFileSync("docker", ["run", "--rm", "-v", `${dir}:/w`, "--entrypoint", "bash", IMAGE, "-c",
      "mkdir /tmp/p && cd /tmp/p && python3 -m zipfile -e /w/project.zip . && cd */ && ls && kicad-cli sch erc --format json --severity-all -o /tmp/erc.json *.kicad_sch >/dev/null; " +
      "python3 -c \"import json; r=json.load(open('/tmp/erc.json')); print('VIOLATIONS', sum(len(s['violations']) for s in r['sheets']))\""],
      { encoding: "utf8" });
    assert.match(out, /\.kicad_pro/);
    assert.match(out, /VIOLATIONS 0/, out);

    // 4. Sign-off commits every output.
    assert.ifError((await user.rpc("decide_task", { p_task_id: done.id, p_approve: true, p_note: "Fixture reviewed" })).error);
    const { data: after } = await admin().from("artifact_versions").select("status").eq("produced_by_task_id", done.id);
    assert.ok(after!.every((v) => v.status === "committed"));
    await waitFor("the run report", async () => (await admin().from("runs").select("report").eq("id", runId).single()).data?.report);
  } finally {
    plain.kill("SIGKILL");
    if (eng) try { execFileSync("docker", ["rm", "-f", eng], { stdio: "ignore" }); } catch { /* already gone */ }
  }
});
