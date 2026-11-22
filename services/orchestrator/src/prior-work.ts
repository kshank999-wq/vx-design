/**
 * Prior-work register job: reads every prior-work document in full and builds the register (@vx/planning
 * prior-work.ts). Sources: the text and PDF documents inside Flux imports used for the plan, and the project's files
 * from other tools, drawings and part files (datasheets), with the owner's note on each. Parts the owner recorded as
 * chosen are added as stated. Images, 3D models and archives are listed, not read.
 */
import { extractPriorWork, mergeRegister, parseDocument, type LanguageModel, type PriorDoc, type Usage } from "@vx/planning";
import { buildInventory, historyDocuments, type Upload } from "@vx/flux";
import type { WorkerDb } from "./db.ts";
import { meteredFor } from "./metering.ts";
import { pdfText } from "./flux.ts";

const CONCURRENCY = Number(process.env.VX_PRIOR_WORK_CONCURRENCY ?? 3);

async function textOf(name: string, data: Uint8Array): Promise<string | null> {
  if (/\.pdf$/i.test(name)) return (await pdfText(data)).trim() || null;
  if (/\.(docx|md|markdown|txt)$/i.test(name)) {
    const p = await parseDocument(data, "", name);
    return p.sections.map((s) => [s.title, ...s.blocks.map((b) => b.text)].filter(Boolean).join("\n")).join("\n\n").trim() || null;
  }
  return null;
}

export async function processPriorWorkRegister(db: WorkerDb, model: { model: LanguageModel; label: string; offline: boolean }, workerId: string): Promise<number> {
  const reg = await db.claimPriorWorkRegister(workerId);
  if (!reg) return 0;
  const tag = `[${workerId}] prior-work register ${reg.id.slice(0, 8)}`;
  const usage: Usage[] = [];
  try {
    // 1. Documents.
    const docs: PriorDoc[] = [];
    const sources: { file: string; origin: string; chars: number; items: number; note?: string }[] = [];
    for (const a of await db.priorWorkAudits(reg.project_id)) {
      const uploads: Upload[] = [];
      for (const f of a.files) uploads.push({ name: f.name, revision: f.revision_label, data: await db.downloadBytes(f.storage_path) });
      const { files } = buildInventory(uploads);
      const origin = `Flux import #${a.audit_no}`;
      for (const d of historyDocuments(files)) docs.push({ file: d.file.split("!/").pop()!, origin, text: d.text });
      for (const f of files.filter((x) => x.kind === "pdf")) {
        try { const t = await pdfText(f.data); if (t.trim()) docs.push({ file: f.path.split("!/").pop()!, origin, text: t }); }
        catch { sources.push({ file: f.path.split("!/").pop()!, origin, chars: 0, items: 0, note: "PDF could not be read" }); }
      }
    }
    for (const r of await db.priorWorkReferences(reg.project_id)) {
      const origin = r.part ? `part ${r.part.mpn}` : `REF-${r.ref_no} (${r.kind.replace("_", " ")})`;
      let text: string | null = null;
      try { text = await textOf(r.filename, await db.downloadBytes(r.storage_path)); } catch { text = null; }
      const note = [r.part ? `${r.part.mpn}${r.part.manufacturer ? ` (${r.part.manufacturer})` : ""} — ${r.part.role}, status ${r.part.status}` : null, r.title, r.note].filter(Boolean).join(". ");
      if (text) docs.push({ file: r.filename, origin, text, note });
      else sources.push({ file: r.filename, origin, chars: 0, items: 0, note: "not read (image, 3D model or archive): listed only" });
    }

    // 2. Extraction, a few documents at a time.
    const extracted: Awaited<ReturnType<typeof extractPriorWork>>["items"] = [];
    let next = 0, done = 0;
    const work = async () => {
      for (;;) {
        const i = next++;
        if (i >= docs.length) return;
        const d = docs[i]!;
        try {
          const r = await extractPriorWork(d, meteredFor(db, model.model, reg.project_id));
          extracted.push(...r.items);
          usage.push(...r.usage);
          sources.push({ file: d.file, origin: d.origin, chars: d.text.length, items: r.items.length, ...(r.dropped ? { note: `${r.dropped} item(s) dropped: quote not found` } : {}) });
        } catch (e) {
          sources.push({ file: d.file, origin: d.origin, chars: d.text.length, items: 0, note: `not read: ${(e as Error).message.slice(0, 200)}` });
        }
        done++;
        await db.progressPriorWorkRegister(reg.id, workerId, `Read ${done} of ${docs.length} documents (${extracted.length} items so far)`);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, docs.length || 1) }, work));

    // 3. Merge, with the parts the owner recorded.
    const register = mergeRegister(extracted, await db.projectParts(reg.project_id));
    sources.sort((a, b) => a.origin.localeCompare(b.origin) || a.file.localeCompare(b.file));
    await db.completePriorWorkRegister(reg.id, workerId, register, sources, model.label, usage, null);
    console.log(`${tag}: ${register.length} items from ${docs.length} documents`);
  } catch (e) {
    console.error(`${tag}: failed: ${(e as Error).message}`);
    await db.completePriorWorkRegister(reg.id, workerId, [], [], model.label, usage, (e as Error).message);
  }
  return 1;
}
