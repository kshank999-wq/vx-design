/**
 * M-ENC against a real Supabase stack and the engineering worker image: schematic -> layout -> enclosure.
 * The enclosure is built around the board's real KiCad 3D models; checks the fit report (no collisions,
 * every part checked), the stored STEP/STL/GLB, and that the base STEP re-reads as a valid solid.
 *
 *   ./scripts/test-enclosure.sh
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

async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 900_000): Promise<T> {
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

test("enclosure task: housing around the routed board, fit-checked against every part's 3D model", { skip, timeout: 2_400_000 }, async () => {
  const email = `enc-${Date.now()}@example.test`;
  const password = "correct-horse-battery";
  assert.ifError((await admin().auth.admin.createUser({ email, password, email_confirm: true })).error);
  const user = createClient(URL!, ANON!, { auth: { persistSession: false } });
  assert.ifError((await user.auth.signInWithPassword({ email, password })).error);
  const { data: project } = await user.from("projects").insert({ name: "Enclosure test" }).select("id").single();
  await user.from("requirements").insert([{ project_id: project!.id, ref_code: "REQ-MEC-001", kind: "mechanical", priority: "must",
    text: "The board shall be housed in a 3D-printed enclosure with the input connector and power LED accessible." }]);
  const { data: planId } = await user.rpc("create_plan_version", { p_project_id: project!.id, p_payload: { summary: "enclosure", tasks: [
    { key: "schematic", title: "Schematic", discipline: "schematic" },
    { key: "pcb-layout", title: "Layout", discipline: "pcb_layout", upstream_keys: ["schematic"] },
    { key: "enclosure", title: "Enclosure", discipline: "enclosure", upstream_keys: ["pcb-layout"], requirement_refs: ["REQ-MEC-001"],
      acceptance_tests: [{ id: "AT1", description: "No part touches the housing", method: "validation", validationKind: "fit_check" }] },
  ] } });
  await user.rpc("submit_plan", { p_plan_id: planId });
  await user.rpc("decide_plan", { p_plan_id: planId, p_approve: true, p_note: null });
  const task = async (key: string) => (await admin().from("tasks").select("id, status, blocker_reason").eq("plan_id", planId).eq("key", key).single()).data!;
  const eng = execFileSync("docker", ["run", "-d", "--rm", "--network", "host", "--name", `enc-${Date.now()}`, ...proxyArgs(),
    "-e", `SUPABASE_URL=${URL}`, "-e", `SUPABASE_SERVICE_ROLE_KEY=${SERVICE}`, "-e", "VX_LLM=offline",
    "-e", "WORKER_ID=enc-worker", "-e", "WORKER_POLL_MS=500", IMAGE], { encoding: "utf8" }).trim();
  try {
    for (const key of ["schematic", "pcb-layout", "enclosure"]) {
      const { data: runId } = await user.rpc("authorize_run", { p_plan_id: planId, p_mode: "autonomous", p_max_ai_spend_usd: 5,
                                                                p_max_compute_spend_usd: 5, p_name: key });
      const t = await waitFor(key, async () => { const x = await task(key); return ["awaiting_approval", "failed", "blocked"].includes(x.status) ? x : null; });
      assert.equal(t.status, "awaiting_approval", `${key}: ${t.blocker_reason}`);
      if (key === "enclosure") break;
      await user.rpc("decide_task", { p_task_id: t.id, p_approve: true, p_note: "ok" });
      await waitFor("report", async () => (await admin().from("runs").select("report").eq("id", runId).single()).data?.report);
    }
    const enc = await task("enclosure");
    const { data: versions } = await admin().from("artifact_versions").select("storage_path, artifacts(name)").eq("produced_by_task_id", enc.id);
    const byName = new Map((versions ?? []).map((v) => [(v.artifacts as unknown as { name: string }).name, v.storage_path]));
    for (const n of ["enclosure-3d", "base-step", "lid-step", "base-stl", "lid-stl", "assembly-step", "base-top-svg", "fit-report", "enclosure-design"]) {
      assert.ok(byName.has(`enclosure/${n}`), `enclosure/${n} stored`);
    }
    const dl = async (n: string) => Buffer.from(await (await admin().storage.from("project-files").download(byName.get(`enclosure/${n}`)!)).data!.arrayBuffer());
    const report = JSON.parse((await dl("fit-report")).toString());
    assert.equal(report.ok, true, JSON.stringify(report.problems));
    assert.deepEqual(report.collisions, []);
    assert.equal(report.board.parts_checked.length, 6, "every part checked against its KiCad 3D model");
    const { data: checks } = await admin().from("validations").select("kind, result, summary").eq("task_id", enc.id);
    assert.match(checks!.find((c) => c.kind === "fit_check")!.summary, /no part or the board touches the housing \(6 of 6 parts checked/);
    assert.match(checks!.find((c) => c.kind === "dfm")!.summary, /FDM 3D print/);
    assert.equal((await dl("enclosure-3d")).subarray(0, 4).toString(), "glTF");
    assert.match((await dl("base-stl")).subarray(0, 80).toString(), /solid|\0/);

    // The stored base STEP re-reads as one valid solid in a fresh container.
    const dir = mkdtempSync(join(tmpdir(), "vx-enc-"));
    chmodSync(dir, 0o777);
    writeFileSync(join(dir, "base.step"), await dl("base-step"));
    const out = execFileSync("docker", ["run", "--rm", "-v", `${dir}:/w`, "--entrypoint", "python3", IMAGE, "-W", "ignore", "-c",
      "import cadquery as cq; s = cq.importers.importStep('/w/base.step'); v = s.val(); print('VALID', v.isValid(), 'SOLIDS', len(s.solids().vals()), 'VOL', round(v.Volume()))"],
      { encoding: "utf8" });
    assert.match(out, /VALID True SOLIDS 1/, out);
  } finally {
    try { execFileSync("docker", ["rm", "-f", eng], { stdio: "ignore" }); } catch { /* gone */ }
  }
});
