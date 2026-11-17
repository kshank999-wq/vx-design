/**
 * 3D model library job (engineering workers): claims a registered model, fetches it (uploaded file or
 * https URL), runs vx_eng's model check against the KiCad footprint, and stores the aligned STEP and the
 * overlay drawing for a person to verify. Nothing is used in a layout until a person verifies it.
 */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { WorkerDb } from "./db.ts";
import { modelCheck, type EngineeringTools } from "./engineering.ts";

const MAX_BYTES = 60 * 1024 * 1024;

export interface PartModelRow {
  id: string; part_id: string; project_id: string; footprint: string; source_kind: "upload" | "url" | "nexar";
  source_url: string | null; original_path: string | null; mechanical: Record<string, unknown>;
}

async function fetchModel(url: string): Promise<{ bytes: Uint8Array; name: string }> {
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(60_000),
                                 headers: { "user-agent": "VX-Design-model-library/1.0" } });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > MAX_BYTES) throw new Error(`file is larger than ${MAX_BYTES / 1024 / 1024} MB`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > MAX_BYTES) throw new Error(`file is larger than ${MAX_BYTES / 1024 / 1024} MB`);
  const name = basename(new URL(res.url || url).pathname) || "model";
  return { bytes, name };
}

export async function processModelCheck(db: WorkerDb, tools: EngineeringTools, workerId: string): Promise<number> {
  const m = await db.claimModelCheck(workerId) as PartModelRow | null;
  if (!m) return 0;
  const work = await mkdtemp(join(tmpdir(), `vx-model-${m.id.slice(0, 8)}-`));
  const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
  try {
    let original: Uint8Array;
    let originalPath = m.original_path;
    let name = "model.step";
    if (m.original_path) {
      original = await db.downloadBytes(m.original_path);
      name = basename(m.original_path);
    } else if (m.source_url) {
      const got = await fetchModel(m.source_url);
      original = got.bytes;
      name = got.name;
      originalPath = `${m.project_id}/models/originals/${sha(original).slice(0, 16)}-${name.replace(/[^\w.-]/g, "_")}`;
      await db.upload(originalPath, original, "application/octet-stream");
    } else {
      throw new Error("the model has neither a file nor a URL");
    }
    const input = join(work, name.replace(/[^\w.-]/g, "_"));
    await writeFile(input, original);
    const out = join(work, "out");
    const r = await modelCheck(tools, input, m.footprint, out, m.mechanical);
    let storagePath: string | null = null, alignedSha: string | null = null, overlayPath: string | null = null;
    if (r.files) {
      const aligned = await readFile(join(out, r.files.aligned_step));
      alignedSha = sha(aligned);
      storagePath = `${m.project_id}/models/aligned/${m.part_id}-${alignedSha.slice(0, 16)}.step`;
      await db.upload(storagePath, aligned, "model/step");
      const svg = await readFile(join(out, r.files.overlay_svg));
      overlayPath = `${m.project_id}/models/overlays/${m.id}-${sha(svg).slice(0, 16)}.svg`;
      await db.upload(overlayPath, svg, "image/svg+xml");
    }
    await db.completeModelCheck(m.id, workerId, r.status, r, r.problems.join("; ") || null,
                                { originalPath, originalSha: sha(original), storagePath, sha256: alignedSha, overlayPath,
                                  mechanical: r.mechanical ?? null });
    console.log(`[${workerId}] model ${m.id.slice(0, 8)} ${m.footprint}: ${r.status}`);
  } catch (e) {
    await db.completeModelCheck(m.id, workerId, "check_failed", { problems: [(e as Error).message] }, (e as Error).message, {});
    console.error(`[${workerId}] model ${m.id.slice(0, 8)} failed: ${(e as Error).message}`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  return 1;
}
