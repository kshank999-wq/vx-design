/**
 * RFQ packet job (M-RFQ): claims an RFQ waiting for its packet, collects exactly what the RFQ selects (the chosen
 * requirements and committed design files), checks each file against its recorded sha256, builds the packet and
 * stores it in the project's folder. The owner then approves that packet (by its hash) before anything is released.
 */
import { buildRfqPacket } from "./rfq-packet.ts";
import type { WorkerDb } from "./db.ts";

export async function processRfqPacket(db: WorkerDb, workerId: string): Promise<number> {
  const rfq = await db.claimRfqPacket(workerId);
  if (!rfq) return 0;
  const tag = `[${workerId}] rfq ${rfq.id.slice(0, 8)} (RFQ-${String(rfq.rfq_no).padStart(3, "0")})`;
  try {
    const { requirements, attachments } = await db.rfqContents(rfq.id, rfq.project_id);
    const files = [];
    for (const a of attachments) files.push({ ...a, data: await db.downloadBytes(a.storage_path) });
    const packet = buildRfqPacket({ rfq, requirements, attachments: files });
    const path = `${rfq.project_id}/rfq/${rfq.id}/${packet.ref}-${packet.sha256.slice(0, 16)}.zip`;
    await db.upload(path, packet.zip, "application/zip");
    await db.completeRfqPacket(rfq.id, workerId, path, packet.sha256, packet.files, null);
    console.log(`${tag}: packet ${packet.sha256.slice(0, 12)} (${packet.files.length} files)`);
  } catch (e) {
    const msg = (e as Error).message;
    if (/lease_lost|not being packaged/.test(msg)) { console.error(`${tag}: lost the RFQ (${msg})`); return 1; }
    console.error(`${tag} failed: ${msg}`);
    await db.completeRfqPacket(rfq.id, workerId, "", "", [], msg.slice(0, 500))
      .catch((e2) => console.error(`${tag}: could not record the failure: ${(e2 as Error).message}`));
  }
  return 1;
}
