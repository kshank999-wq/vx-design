/**
 * 3D model library against a real Supabase stack and the engineering worker image:
 *   - an engineer uploads a vendor-style STEP for U1; the worker aligns it to the footprint and stores
 *     the aligned STEP and overlay; a person verifies it;
 *   - a URL that is not a STEP file fails its check with a plain reason;
 *   - the board layout then uses the verified model: it ships in the KiCad project and the model report says so.
 *
 *   ./scripts/test-models.sh
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";

const URL = process.env.SUPABASE_URL;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON = process.env.SUPABASE_ANON_KEY;
const IMAGE = process.env.ENGINEERING_WORKER_IMAGE ?? "vx-engineering-worker";
const skip = !URL || !SERVICE || !ANON ? "SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and SUPABASE_ANON_KEY are required" : false;
const admin = () => createClient(URL!, SERVICE!, { auth: { persistSession: false } });
const ENG_DIR = join(import.meta.dirname, "../../engineering");

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

test("model library: upload, automatic check, human verification, used by the layout", { skip, timeout: 1_500_000 }, async () => {
  // A vendor-style SOT-23-5 model (rotated and offset), built with CadQuery in the engineering image.
  const dir = mkdtempSync(join(tmpdir(), "vx-models-"));
  chmodSync(dir, 0o777);
  execFileSync("docker", ["run", "--rm", "-v", `${dir}:/w`, "-v", `${ENG_DIR}/tests:/t:ro`, "-e", "PYTHONPATH=/t",
    "--entrypoint", "python3", IMAGE, "-c", "from pathlib import Path; from model_fixtures import sot23_5; sot23_5(Path('/w/vendor.step'))"]);
  const step = readFileSync(join(dir, "vendor.step"));

  const email = `models-${Date.now()}@example.test`;
  const password = "correct-horse-battery";
  assert.ifError((await admin().auth.admin.createUser({ email, password, email_confirm: true })).error);
  const user = createClient(URL!, ANON!, { auth: { persistSession: false } });
  assert.ifError((await user.auth.signInWithPassword({ email, password })).error);
  const { data: project } = await user.from("projects").insert({ name: "Model library test" }).select("id").single();
  const path = `${project!.id}/models/uploads/vendor-sot23-5.step`;
  assert.ifError((await user.storage.from("project-files").upload(path, step, { contentType: "model/step" })).error);
  const { data: modelId, error: re } = await user.rpc("register_part_model", {
    p_project_id: project!.id, p_mpn: "AP2112K-3.3TRG1", p_manufacturer: "Diodes Incorporated", p_normalized_mpn: "AP2112K-3.3TRG1",
    p_normalized_mfr: "DIODES", p_footprint: "Package_TO_SOT_SMD:SOT-23-5", p_source_kind: "upload", p_source: "Vendor CAD pack (test)",
    p_license: "test fixture", p_original_path: path, p_shared: false, p_mechanical: { height_mm: 1.2 },
  });
  assert.ifError(re);
  const { data: badId } = await user.rpc("register_part_model", {
    p_project_id: project!.id, p_mpn: "AP2112K-3.3TRG1", p_manufacturer: "Diodes Incorporated", p_normalized_mpn: "AP2112K-3.3TRG1",
    p_normalized_mfr: "DIODES", p_footprint: "Package_TO_SOT_SMD:SOT-23-5", p_source_kind: "url", p_source: "Diodes datasheet (not a model)",
    p_source_url: "https://www.diodes.com/assets/Datasheets/AP2112.pdf",
  });

  const eng = execFileSync("docker", ["run", "-d", "--rm", "--network", "host", "--name", `models-${Date.now()}`, ...proxyArgs(),
    "-e", `SUPABASE_URL=${URL}`, "-e", `SUPABASE_SERVICE_ROLE_KEY=${SERVICE}`, "-e", "VX_LLM=offline",
    "-e", "WORKER_ID=models-worker", "-e", "WORKER_POLL_MS=500", IMAGE], { encoding: "utf8" }).trim();
  try {
    const row = async (id: string) => (await user.from("part_models").select("*").eq("id", id).single()).data!;
    const checked = await waitFor("the model check", async () => { const m = await row(modelId as string); return ["checked", "inconclusive", "check_failed"].includes(m.status) ? m : null; });
    assert.equal(checked.status, "checked", JSON.stringify(checked.check_result));
    assert.equal(checked.check_result.terminals, 5);
    assert.ok(checked.storage_path && checked.overlay_path && checked.sha256);
    assert.equal(checked.mechanical.height_mm, 1.2);
    const svg = await (await user.storage.from("project-files").download(checked.overlay_path)).data!.text();
    assert.match(svg, /<svg/);
    const bad = await waitFor("the bad URL check", async () => { const m = await row(badId as string); return m.status === "check_failed" ? m : null; });
    assert.match(bad.error, /not a STEP file|ZIP contains no/);
    assert.ok(bad.original_path, "what was downloaded is kept for the record");

    assert.ifError((await user.rpc("decide_part_model", { p_id: modelId, p_approve: true, p_note: "leads on pads; pin 1 dot at pad 1" })).error);

    // Layout with the verified model.
    const { data: planId } = await user.rpc("create_plan_version", { p_project_id: project!.id, p_payload: { summary: "models", tasks: [
      { key: "schematic", title: "Schematic", discipline: "schematic" },
      { key: "pcb-layout", title: "Layout", discipline: "pcb_layout", upstream_keys: ["schematic"] },
    ] } });
    await user.rpc("submit_plan", { p_plan_id: planId });
    await user.rpc("decide_plan", { p_plan_id: planId, p_approve: true, p_note: null });
    const task = async (key: string) => (await admin().from("tasks").select("id, status, blocker_reason").eq("plan_id", planId).eq("key", key).single()).data!;
    const run = async (name: string) => (await user.rpc("authorize_run", { p_plan_id: planId, p_mode: "autonomous", p_max_ai_spend_usd: 5,
                                                                           p_max_compute_spend_usd: 5, p_name: name })).data as string;
    const r1 = await run("schematic");
    await waitFor("schematic", async () => (await task("schematic")).status === "awaiting_approval");
    await user.rpc("decide_task", { p_task_id: (await task("schematic")).id, p_approve: true, p_note: "ok" });
    await waitFor("report", async () => (await admin().from("runs").select("report").eq("id", r1).single()).data?.report);
    await run("layout");
    const lay = await waitFor("layout", async () => { const t = await task("pcb-layout"); return ["awaiting_approval", "failed", "blocked"].includes(t.status) ? t : null; });
    assert.equal(lay.status, "awaiting_approval", lay.blocker_reason);
    const { data: checks } = await admin().from("validations").select("kind, summary, details").eq("task_id", lay.id);
    const mc = checks!.find((c) => c.kind === "footprint_check")!;
    assert.match(mc.summary, /verified manufacturer CAD for U1/);
    const { data: versions } = await admin().from("artifact_versions").select("storage_path, artifacts(name)").eq("produced_by_task_id", lay.id);
    const zipPath = versions!.find((v) => (v.artifacts as unknown as { name: string }).name.endsWith("/kicad-project"))!.storage_path;
    const zip = Buffer.from(await (await admin().storage.from("project-files").download(zipPath)).data!.arrayBuffer());
    assert.ok(zip.includes(Buffer.from("3dmodels/AP2112K-3.3TRG1-")), "the verified model ships inside the KiCad project");
  } finally {
    try { execFileSync("docker", ["rm", "-f", eng], { stdio: "ignore" }); } catch { /* gone */ }
  }
});
