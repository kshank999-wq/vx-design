/**
 * M-SRC against a real Supabase stack: schematic (KiCad worker) -> sourcing (a plain worker with the
 * fixture distributors; the KiCad worker has no distributor keys, so it leaves sourcing alone) and
 * layout -> fab package. Checks the sourced BOM, that fixture data never reaches the shared catalog,
 * and that the fab package refuses fixture LCSC numbers.
 *
 *   ./scripts/test-msrc.sh
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";

const URL = process.env.SUPABASE_URL;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON = process.env.SUPABASE_ANON_KEY;
const IMAGE = process.env.ENGINEERING_WORKER_IMAGE ?? "vx-engineering-worker";
const skip = !URL || !SERVICE || !ANON ? "SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and SUPABASE_ANON_KEY are required" : false;
const admin = () => createClient(URL!, SERVICE!, { auth: { persistSession: false } });

async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 600_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

function proxyArgs(): string[] {
  const args: string[] = [];
  for (const k of ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"]) if (process.env[k]) args.push("-e", `${k}=${process.env[k]}`);
  if (process.env.HTTPS_PROXY) args.push("-e", "NODE_USE_ENV_PROXY=1");
  if (process.env.NODE_EXTRA_CA_CERTS) {
    args.push("-v", `${process.env.NODE_EXTRA_CA_CERTS}:/etc/vx-extra-ca.crt:ro`, "-e", "NODE_EXTRA_CA_CERTS=/etc/vx-extra-ca.crt");
  }
  return args;
}

test("sourcing task: fixture-sourced BOM, routed by capability, kept out of the catalog and the fab package",
     { skip, timeout: 1_800_000 }, async () => {
  const email = `msrc-${Date.now()}@example.test`;
  const password = "correct-horse-battery";
  assert.ifError((await admin().auth.admin.createUser({ email, password, email_confirm: true })).error);
  const user = createClient(URL!, ANON!, { auth: { persistSession: false } });
  assert.ifError((await user.auth.signInWithPassword({ email, password })).error);
  const { data: project } = await user.from("projects").insert({ name: "M-SRC timecode sub-board" }).select("id").single();
  const { data: planId, error: pe } = await user.rpc("create_plan_version", { p_project_id: project!.id, p_payload: {
    summary: "M-SRC test plan",
    tasks: [
      { key: "schematic", title: "Schematic", discipline: "schematic" },
      { key: "sourcing", title: "Source the BOM", discipline: "sourcing", upstream_keys: ["schematic"],
        acceptance_tests: [{ id: "AT1", description: "Every line sourced with prices at 1-1000 boards", method: "validation", validationKind: "bom_check" }] },
      { key: "pcb-layout", title: "Layout", discipline: "pcb_layout", upstream_keys: ["schematic"] },
      { key: "fab-package", title: "Fab package", discipline: "manufacturing", upstream_keys: ["pcb-layout", "sourcing"] },
    ],
  } });
  assert.ifError(pe);
  await user.rpc("submit_plan", { p_plan_id: planId });
  await user.rpc("decide_plan", { p_plan_id: planId, p_approve: true, p_note: null });
  const task = async (key: string) =>
    (await admin().from("tasks").select("id, status, blocker_reason").eq("plan_id", planId).eq("key", key).single()).data!;
  const settled = (s: string) => ["awaiting_approval", "complete", "failed", "blocked"].includes(s);
  const authorize = async (name: string) => (await user.rpc("authorize_run", {
    p_plan_id: planId, p_mode: "autonomous", p_max_ai_spend_usd: 5, p_max_compute_spend_usd: 5, p_name: name })).data as string;
  const approve = async (key: string) =>
    assert.ifError((await user.rpc("decide_task", { p_task_id: (await task(key)).id, p_approve: true, p_note: "ok" })).error);
  const report = (runId: string) => waitFor("run report", async () => (await admin().from("runs").select("report").eq("id", runId).single()).data?.report);

  const eng = execFileSync("docker", ["run", "-d", "--rm", "--network", "host", "--name", `msrc-eng-${Date.now()}`, ...proxyArgs(),
    "-e", `SUPABASE_URL=${URL}`, "-e", `SUPABASE_SERVICE_ROLE_KEY=${SERVICE}`, "-e", "VX_LLM=offline",
    "-e", "WORKER_ID=msrc-kicad", "-e", "WORKER_POLL_MS=500", IMAGE], { encoding: "utf8" }).trim();
  let plain: ReturnType<typeof spawn> | undefined;
  try {
    const run1 = await authorize("schematic");
    await waitFor("schematic", async () => settled((await task("schematic")).status));
    await approve("schematic");
    await report(run1);

    // Sourcing waits: the KiCad worker has no distributor keys. Then a plain worker with the fixture takes it.
    const run2 = await authorize("sourcing + layout");
    await waitFor("layout", async () => settled((await task("pcb-layout")).status));
    assert.equal((await task("sourcing")).status, "ready", "no worker with sourcing providers yet");
    plain = spawn(process.execPath, [join(import.meta.dirname, "../src/main.ts")], {
      env: { ...process.env, WORKER_ID: "msrc-sourcing", VX_LLM: "offline", VX_ENGINEERING: "off", VX_SOURCING: "fixture", WORKER_POLL_MS: "500" },
      stdio: ["ignore", "ignore", "inherit"],
    });
    const src = await waitFor("sourcing", async () => { const t = await task("sourcing"); return settled(t.status) ? t : null; });
    assert.equal(src.status, "awaiting_approval", `sourcing ended ${src.status}: ${src.blocker_reason}`);
    const { data: execs } = await admin().from("executions").select("worker_id").eq("task_id", src.id);
    assert.deepEqual(execs!.map((e) => e.worker_id), ["msrc-sourcing"]);

    const { data: approval } = await admin().from("approvals").select("reason").eq("task_id", src.id).eq("status", "pending").single();
    assert.match(approval!.reason, /Fixture sourcing data/);
    const { data: versions } = await admin().from("artifact_versions").select("storage_path, artifacts(name)").eq("produced_by_task_id", src.id);
    const byName = new Map((versions ?? []).map((v) => [(v.artifacts as unknown as { name: string }).name, v.storage_path]));
    assert.deepEqual([...byName.keys()].sort(), ["sourcing/lcsc-map", "sourcing/sourced-bom", "sourcing/sourced-bom-csv"]);
    const bom = JSON.parse(await (await admin().storage.from("project-files").download(byName.get("sourcing/sourced-bom")!)).data!.text());
    assert.equal(bom.dataStatus, "fixture");
    assert.deepEqual(bom.counts, { lines: 5, sourced: 5, unsourced: 0, errors: 0, warnings: bom.counts.warnings, withLcsc: 4 });
    assert.equal(bom.lines.find((l: { refs: string[] }) => l.refs.join() === "C1,C2").selected.mpn, "FX-C0603-105-16V");
    assert.ok(bom.totals.every((t: { perBoard: number | null }) => t.perBoard !== null), "priced at every quantity");
    const { data: check } = await admin().from("validations").select("kind, result, summary").eq("task_id", src.id).single();
    assert.equal(check!.kind, "bom_check");
    assert.match(check!.summary, /5\/5 lines sourced from fixture distributor data/);
    const { count } = await admin().from("parts").select("id", { count: "exact", head: true }).like("mpn", "FX-%");
    assert.equal(count, 0, "fixture parts never enter the shared catalog");
    const { data: calls } = await admin().from("cost_events").select("provider, quantity").eq("kind", "api_call")
      .in("execution_id", (await admin().from("executions").select("id").eq("task_id", src.id)).data!.map((e) => e.id));
    assert.ok(calls!.length && calls!.every((c) => c.provider === "fixture"), "provider calls are metered");

    await approve("sourcing");
    await approve("pcb-layout");
    await report(run2);

    // Fab package: fixture LCSC numbers are not applied.
    await authorize("fab");
    const fab = await waitFor("fab package", async () => { const t = await task("fab-package"); return settled(t.status) ? t : null; });
    assert.equal(fab.status, "awaiting_approval", `fab ended ${fab.status}: ${fab.blocker_reason}`);
    const { data: fabChecks } = await admin().from("validations").select("kind, summary").eq("task_id", fab.id);
    assert.match(fabChecks!.find((c) => c.kind === "bom_check")!.summary, /sourcing's LCSC numbers are fixture data and were not applied/);
  } finally {
    plain?.kill("SIGKILL");
    try { execFileSync("docker", ["rm", "-f", eng], { stdio: "ignore" }); } catch { /* gone */ }
  }
});
