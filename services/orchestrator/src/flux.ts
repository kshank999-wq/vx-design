/**
 * Flux import audit job (G5): downloads the uploaded exports, runs the deterministic audit (@vx/flux), has the model
 * list prior decisions and claimed validations from the text and PDF exports (keeping only items whose quote is found
 * word for word), and stores the report as JSON and Markdown in the project's folder.
 */
import { createHash } from "node:crypto";
import { extractFluxHistory, type LanguageModel } from "@vx/planning";
import { buildInventory, historyDocuments, keepQuoted, normMpn, renderReport, runAudit, type CatalogEntry, type HistoryInput, type Upload } from "@vx/flux";
import { inspectUpload, type UploadPolicy } from "@vx/security";
import type { WorkerDb } from "./db.ts";

/** What a Flux export may contain: anything but programs and scripts. */
const FLUX_POLICY: UploadPolicy = { maxBytes: 300 * 1048576,
  accept: ["pdf", "zip", "docx", "xlsx", "png", "jpeg", "gif", "webp", "step", "gzip", "svg", "html", "text", "binary"] };

async function pdfText(data: Uint8Array): Promise<string> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(data));
  const { text } = await extractText(pdf, { mergePages: true });
  return Array.isArray(text) ? text.join("\n") : text;
}

export async function processFluxAudit(db: WorkerDb, model: { model: LanguageModel; label: string; offline: boolean }, workerId: string): Promise<number> {
  const audit = await db.claimFluxAudit(workerId);
  if (!audit) return 0;
  const tag = `[${workerId}] flux audit ${audit.id.slice(0, 8)} (#${audit.audit_no})`;
  try {
    const rows = await db.fluxFiles(audit.id);
    // Security (G6): no infected file is read; with scans required, every file must have been scanned clean.
    const scans = await db.scanStatus(rows.map((r) => r.storage_path));
    const infected = rows.filter((r) => scans.get(r.storage_path) === "infected");
    if (infected.length) throw new Error(`virus scan found infected files: ${infected.map((r) => r.name).join(", ")}; remove them and upload clean copies`);
    if (await db.requireVirusScan()) {
      const waiting = rows.filter((r) => scans.get(r.storage_path) !== "clean");
      if (waiting.length) throw new Error(`waiting for the virus scan of ${waiting.map((r) => r.name).join(", ")}; run the audit again in a minute`);
    }
    const uploads: Upload[] = [];
    const refused: string[] = [];
    for (const r of rows) {
      const data = await db.downloadBytes(r.storage_path);
      if (createHash("sha256").update(data).digest("hex") !== r.sha256) throw new Error(`${r.name} does not match the sha256 recorded at upload`);
      const check = inspectUpload(r.name, data, FLUX_POLICY);
      if (!check.ok) refused.push(`${r.name}: ${check.problems.join("; ")}`);
      uploads.push({ name: r.name, revision: r.revision_label, data });
    }
    if (refused.length) throw new Error(`files refused by the upload check: ${refused.join(" | ")}`);
    // Revisions oldest first: by the date given at upload (undated last), then upload order.
    const first = new Map<string, { date: string | null; at: string }>();
    for (const r of rows) {
      const f = first.get(r.revision_label);
      if (!f) first.set(r.revision_label, { date: r.revision_date, at: r.created_at });
      else if (r.revision_date && (!f.date || r.revision_date < f.date)) f.date = r.revision_date;
    }
    const revisions = [...first].sort(([, a], [, b]) => (a.date ?? "9999") < (b.date ?? "9999") ? -1 : (a.date ?? "9999") > (b.date ?? "9999") ? 1 : a.at < b.at ? -1 : 1)
      .map(([label, v]) => ({ label, date: v.date }));

    // History from text exports and PDFs (reports).
    const { files } = buildInventory(uploads);
    const docs = historyDocuments(files);
    for (const f of files.filter((x) => x.kind === "pdf")) {
      try { const t = await pdfText(f.data); if (t.trim()) docs.push({ file: f.path, text: t }); } catch { /* unreadable PDF: stays in the inventory only */ }
    }
    let history: HistoryInput | null = null;
    if (docs.length) {
      const { history: h, usage } = await extractFluxHistory(docs, model.model);
      for (const u of usage) if (u.inputTokens || u.outputTokens) await db.recordProjectCost(audit.project_id, "ai_tokens", "anthropic", u.model, u.inputTokens + u.outputTokens, "tokens");
      const d = keepQuoted(h.decisions, docs), c = keepQuoted(h.claims, docs);
      history = { model: model.label, offline: model.offline, dropped_quotes: d.dropped + c.dropped, decisions: d.kept, claims: c.kept };
    }

    // Lifecycle from the VX parts catalog, where the part is known.
    const catalog = new Map<string, CatalogEntry>();
    const mpns = runAudit({ uploads, revisions }).current?.components.map((x) => x.mpn).filter((m): m is string => !!m) ?? [];
    for (const p of await db.catalogParts(mpns)) catalog.set(normMpn(p.mpn), { mpn: p.mpn, manufacturer: p.manufacturer, lifecycle: p.lifecycle });

    const report = runAudit({ uploads, revisions, history, catalog });
    const json = new TextEncoder().encode(JSON.stringify(report, null, 2));
    const md = new TextEncoder().encode(renderReport(report, audit.title));
    const sha = createHash("sha256").update(json).digest("hex");
    const base = `${audit.project_id}/flux/${audit.id}/report-${sha.slice(0, 16)}`;
    await db.upload(`${base}.json`, json, "application/json");
    await db.upload(`${base}.md`, md, "text/markdown");
    await db.completeFluxAudit(audit.id, workerId, `${base}.json`, `${base}.md`, sha, report.summary, history?.model ?? null, null);
    console.log(`${tag}: ${report.summary.blockers} blocker(s), ${report.summary.warnings} warning(s), ${report.migration.length} migration task(s)`);
  } catch (e) {
    const msg = (e as Error).message;
    if (/lease_lost|not being run/.test(msg)) { console.error(`${tag}: lost the audit (${msg})`); return 1; }
    console.error(`${tag} failed: ${msg}`);
    await db.completeFluxAudit(audit.id, workerId, "", "", "", {}, null, msg.slice(0, 500))
      .catch((e2) => console.error(`${tag}: could not record the failure: ${(e2 as Error).message}`));
  }
  return 1;
}
