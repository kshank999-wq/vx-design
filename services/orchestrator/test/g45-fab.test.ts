/**
 * G4.5 against a real Supabase stack and the engineering worker image:
 * schematic -> approve -> layout -> approve -> fab package. The package is checked again here:
 * every file in it matches its manifest, the loose gerbers.zip is the one inside the package,
 * the CPL lists every SMD part, and the fab notes describe the board.
 *
 *   ./scripts/test-g45.sh
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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

test("fab package task: board-house files from the approved board, independently checked", { skip, timeout: 1_500_000 }, async () => {
  const email = `g45-${Date.now()}@example.test`;
  const password = "correct-horse-battery";
  assert.ifError((await admin().auth.admin.createUser({ email, password, email_confirm: true })).error);
  const user = createClient(URL!, ANON!, { auth: { persistSession: false } });
  assert.ifError((await user.auth.signInWithPassword({ email, password })).error);
  const { data: project } = await user.from("projects").insert({ name: "G4.5 timecode sub-board" }).select("id").single();
  await user.from("requirements").insert([
    { project_id: project!.id, ref_code: "REQ-PWR-001", kind: "power", text: "Regulate 5 V USB input to 3.3 V", priority: "must" },
  ]);
  const { data: planId, error: pe } = await user.rpc("create_plan_version", { p_project_id: project!.id, p_payload: {
    summary: "G4.5 test plan",
    tasks: [
      { key: "schematic", title: "Schematic", discipline: "schematic", requirement_refs: ["REQ-PWR-001"] },
      { key: "pcb-layout", title: "Layout", discipline: "pcb_layout", upstream_keys: ["schematic"] },
      { key: "fab-package", title: "Fab package", discipline: "manufacturing", upstream_keys: ["pcb-layout"],
        acceptance_tests: [{ id: "AT1", description: "Package passes independent Gerber and CPL checks", method: "validation", validationKind: "dfm" }] },
    ],
  } });
  assert.ifError(pe);
  await user.rpc("submit_plan", { p_plan_id: planId });
  await user.rpc("decide_plan", { p_plan_id: planId, p_approve: true, p_note: null });
  const task = async (key: string) =>
    (await admin().from("tasks").select("id, status, blocker_reason").eq("plan_id", planId).eq("key", key).single()).data!;

  const eng = execFileSync("docker", ["run", "-d", "--rm", "--network", "host", "--name", `g45-${Date.now()}`, ...proxyArgs(),
    "-e", `SUPABASE_URL=${URL}`, "-e", `SUPABASE_SERVICE_ROLE_KEY=${SERVICE}`, "-e", "VX_LLM=offline",
    "-e", "WORKER_ID=g45-worker", "-e", "WORKER_POLL_MS=500", IMAGE], { encoding: "utf8" }).trim();
  try {
    // Each stage runs in its own run and is approved before the next (offline output always needs sign-off).
    for (const key of ["schematic", "pcb-layout", "fab-package"]) {
      const { data: runId, error } = await user.rpc("authorize_run", {
        p_plan_id: planId, p_mode: "autonomous", p_max_ai_spend_usd: 5, p_max_compute_spend_usd: 5, p_name: key,
      });
      assert.ifError(error);
      const done = await waitFor(`${key} to finish`, async () => {
        const t = await task(key);
        return ["awaiting_approval", "complete", "failed", "blocked"].includes(t.status) ? t : null;
      });
      assert.equal(done.status, "awaiting_approval", `${key} ended ${done.status}: ${done.blocker_reason}`);
      if (key === "fab-package") break;
      assert.ifError((await user.rpc("decide_task", { p_task_id: done.id, p_approve: true, p_note: "ok" })).error);
      await waitFor(`${key} run report`, async () => (await admin().from("runs").select("report").eq("id", runId).single()).data?.report);
    }

    const fab = await task("fab-package");
    const { data: approval } = await admin().from("approvals").select("reason").eq("task_id", fab.id).eq("status", "pending").single();
    assert.match(approval!.reason, /A fab package is a release/);
    assert.match(approval!.reason, /offline fixture/);

    const { data: versions } = await admin().from("artifact_versions")
      .select("storage_path, sha256, validated_at, artifacts(name)").eq("produced_by_task_id", fab.id);
    const byName = new Map((versions ?? []).map((v) => [(v.artifacts as unknown as { name: string }).name, v]));
    for (const n of ["fab-package", "gerbers", "assembly-bom", "cpl", "fab-notes", "assembly-top", "drill-map",
                     "panel-gerbers", "panel-render", "fab-check", "ipc2581", "odb", "ipc356-netlist", "outline-dxf"]) {
      assert.ok(byName.get(`fab-package/${n}`)?.validated_at, `fab-package/${n} stored and validated`);
    }
    assert.ok(!byName.has("fab-package/assembly-bottom"), "no bottom-side parts, so no bottom assembly drawing");

    const { data: checks } = await admin().from("validations").select("kind, result, summary").eq("task_id", fab.id);
    const by = (k: string) => checks!.filter((c) => c.kind === k);
    assert.equal(by("drc")[0]!.result, "pass");
    assert.equal(by("dfm")[0]!.result, "pass", by("dfm")[0]!.summary);
    assert.match(by("dfm")[0]!.summary, /outline 34 x 22 mm, 3 plated \+ 4 non-plated holes match the board/);
    assert.ok(by("other").some((c) => /Pick-and-place: 6 parts at the board's positions and sides/.test(c.summary)));
    const formats = by("other").find((c) => c.summary.startsWith("Exchange formats"))!;
    assert.equal(formats.result, "pass", formats.summary);
    assert.match(formats.summary, /IPC-2581 rev C \(XML\), ODB\+\+ \(zip\), IPC-D-356 netlist \(bare-board test\), DXF board outline \(mm\)/);
    assert.equal(by("bom_check")[0]!.result, "warning", "no LCSC numbers yet");

    // Re-check the stored package here: manifest integrity and the loose Gerbers are the packaged ones.
    const dl = async (n: string) =>
      Buffer.from(await (await admin().storage.from("project-files").download(byName.get(`fab-package/${n}`)!.storage_path)).data!.arrayBuffer());
    const dir = mkdtempSync(join(tmpdir(), "vx-g45-"));
    chmodSync(dir, 0o777);
    writeFileSync(join(dir, "package.zip"), await dl("fab-package"));
    const out = execFileSync("docker", ["run", "--rm", "-v", `${dir}:/w`, "--entrypoint", "python3", IMAGE, "-c",
      "import zipfile, json, hashlib\n" +
      "z = zipfile.ZipFile('/w/package.zip'); m = json.loads(z.read('manifest.json'))\n" +
      "bad = [a for a, s in m.items() if hashlib.sha256(z.read(a)).hexdigest() != s]\n" +
      "print('FILES', len(m), 'BAD', len(bad)); print('GERBERS', m['gerbers.zip'])"], { encoding: "utf8" });
    assert.match(out, /BAD 0/);
    const loose = createHash("sha256").update(await dl("gerbers")).digest("hex");
    assert.match(out, new RegExp(`GERBERS ${loose}`), "the loose gerbers.zip is the packaged one");
    const notes = (await dl("fab-notes")).toString();
    assert.match(notes, /Dimensions \.+ 34(\.0)? x 22(\.0)? mm/);
    assert.match(notes, /Surface finish \.+ HASL \(lead-free\)/);
    const cpl = (await dl("cpl")).toString().trim().split("\n");
    assert.deepEqual(cpl.slice(1).map((l) => l.split(",")[0]).sort(), ["C1", "C2", "D1", "J1", "R1", "U1"]);

    assert.ifError((await user.rpc("decide_task", { p_task_id: fab.id, p_approve: true, p_note: "Fixture package reviewed" })).error);
    const { data: after } = await admin().from("artifact_versions").select("status").eq("produced_by_task_id", fab.id);
    assert.ok(after!.every((v) => v.status === "committed"));
  } finally {
    try { execFileSync("docker", ["rm", "-f", eng], { stdio: "ignore" }); } catch { /* gone */ }
  }
});
