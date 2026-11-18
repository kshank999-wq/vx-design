/**
 * Virus scan job (G6): scans files people uploaded (documents, 3D models, knowledge files, Flux exports) with ClamAV
 * and records the result. Infected files become unreadable through storage policies; the finding is audited.
 */
import { createHash } from "node:crypto";
import type { Scanner } from "@vx/security";
import type { WorkerDb } from "./db.ts";

export async function processVirusScans(db: WorkerDb, scanner: Scanner, workerId: string, batch = 10): Promise<number> {
  const files = await db.nextFilesToScan(batch);
  for (const f of files) {
    let sha: string | null = null, size: number | null = f.size_bytes;
    try {
      const data = await db.downloadFrom(f.bucket, f.path);
      sha = createHash("sha256").update(data).digest("hex");
      size = data.length;
      const r = await scanner.scan(data);
      await db.recordFileScan(f.bucket, f.path, sha, size, r.status, r.engine, r.signature, r.detail);
      if (r.status === "infected") console.error(`[${workerId}] virus scan: ${f.bucket}/${f.path} INFECTED (${r.signature})`);
      else if (r.status === "error") console.error(`[${workerId}] virus scan: ${f.bucket}/${f.path} could not be scanned: ${r.detail}`);
    } catch (e) {
      await db.recordFileScan(f.bucket, f.path, sha, size, "error", null, null, (e as Error).message)
        .catch((e2) => console.error(`[${workerId}] virus scan: could not record ${f.path}: ${(e2 as Error).message}`));
    }
  }
  return files.length;
}
