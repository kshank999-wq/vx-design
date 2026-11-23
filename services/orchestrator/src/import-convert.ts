/**
 * Import existing designs: converts a native board file from another tool to KiCad (KiCad's own importers on the
 * engineering worker), with its design-rule check and facts, and measures 3D models. The converted board is stored
 * in the project's import folder for download and for the team to reuse.
 */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkerDb } from "./db.ts";
import { importBoard, modelFacts, type EngineeringTools } from "./engineering.ts";

export async function processImportConversion(db: WorkerDb, tools: EngineeringTools, workerId: string): Promise<number> {
  const job = await db.claimImportConversion(workerId);
  if (!job) return 0;
  const tag = `[${workerId}] import conversion ${job.id.slice(0, 8)} (${job.file_name})`;
  const work = await mkdtemp(join(tmpdir(), "vx-import-"));
  try {
    const scans = await db.scanStatus([job.storage_path]);
    if (scans.get(job.storage_path) === "infected") throw new Error("the virus scan found this file infected");
    if (await db.requireVirusScan() && scans.get(job.storage_path) !== "clean") throw new Error("waiting for the virus scan; run the import again in a minute");
    const bytes = await db.downloadBytes(job.storage_path);
    if (createHash("sha256").update(bytes).digest("hex") !== job.sha256) throw new Error("the file does not match the sha256 recorded at upload");
    const safeName = job.file_name.replace(/[^\w.\-]+/g, "_").slice(-120) || "input";
    const input = join(work, safeName);
    await writeFile(input, bytes);
    if (job.kind === "mcad") {
      const r = await modelFacts(tools, input);
      if (!r.ok) throw new Error(r.error ?? "the model could not be read");
      await db.completeImportConversion(job.id, workerId, r, null, null);
      console.log(`${tag}: ${r.format} ${r.size_mm?.join(" x ")} mm`);
      return 1;
    }
    const r = await importBoard(tools, input, job.source_tool, join(work, "out"));
    if (!r.ok) throw new Error(r.error ?? "the board could not be converted");
    const board = await readFile(join(work, "out", r.files!.board));
    const path = `${job.project_id}/flux/${job.audit_id}/converted/${createHash("sha256").update(board).digest("hex").slice(0, 16)}-${safeName.replace(/\.[^.]+$/, "")}.kicad_pcb`;
    await db.upload(path, board, "application/octet-stream");
    await db.completeImportConversion(job.id, workerId, r, path, null);
    console.log(`${tag}: ${r.converted_from} → KiCad, ${r.facts?.footprints} parts, DRC ${r.drc?.errors} error(s)`);
  } catch (e) {
    const msg = (e as Error).message;
    if (/lease_lost|not being run/.test(msg)) { console.error(`${tag}: lost (${msg})`); return 1; }
    console.error(`${tag} failed: ${msg}`);
    await db.completeImportConversion(job.id, workerId, {}, null, msg.slice(0, 500)).catch(() => {});
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  return 1;
}
