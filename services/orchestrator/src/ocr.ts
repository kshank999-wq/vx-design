/**
 * OCR of scanned PDFs for the knowledge base (M-KB). Each page is rendered at 300 dpi (pdftoppm) and read by
 * Tesseract; words below confidence 0 (non-text) are dropped, lines are rebuilt from the TSV output, and each page
 * becomes one or more excerpts whose locator says "(OCR)". The mean word confidence is recorded so a poor scan is
 * visible. Files are checked against the sha256 recorded at upload and, where scanning is required, wait for a clean
 * virus scan. A copy the licence does not allow keeping is deleted afterwards.
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { WorkerDb } from "./db.ts";

const run = promisify(execFile);
export const OCR_MAX_PAGES = 200;
const CHUNK_CHARS = 1500;

export interface OcrPage { page: number; text: string; confidence: number | null }

/** Lines from Tesseract's TSV output (level 5 rows are words). */
export function tsvToText(tsv: string): { text: string; confidence: number | null } {
  const lines = new Map<string, string[]>();
  const confs: number[] = [];
  for (const row of tsv.split("\n").slice(1)) {
    const c = row.split("\t");
    if (c.length < 12 || c[0] !== "5") continue;
    const conf = Number(c[10]), word = (c[11] ?? "").trim();
    if (!word || conf < 0) continue;
    confs.push(conf);
    const key = `${c[2]}.${c[3]}.${c[4]}`;   // block.paragraph.line
    lines.set(key, [...(lines.get(key) ?? []), word]);
  }
  const paras = new Map<string, string[]>();
  for (const [key, words] of lines) {
    const p = key.split(".").slice(0, 2).join(".");
    paras.set(p, [...(paras.get(p) ?? []), words.join(" ")]);
  }
  return { text: [...paras.values()].map((l) => l.join(" ")).join("\n\n"),
           confidence: confs.length ? Math.round((confs.reduce((a, b) => a + b, 0) / confs.length) * 10) / 10 : null };
}

/** Page texts into excerpts of at most ~1500 characters, split at paragraph breaks, located by page. */
export function ocrChunks(pages: OcrPage[]): { ordinal: number; locator: string; section_path: null; text: string }[] {
  const out: { ordinal: number; locator: string; section_path: null; text: string }[] = [];
  for (const p of pages) {
    let buf = "";
    const flush = () => { if (buf.trim()) out.push({ ordinal: out.length + 1, locator: `p. ${p.page} (OCR)`, section_path: null, text: buf.trim().slice(0, 4000) }); buf = ""; };
    for (const para of p.text.split(/\n{2,}/)) {
      if (buf && buf.length + para.length + 2 > CHUNK_CHARS) flush();
      buf += (buf ? "\n\n" : "") + para;
    }
    flush();
  }
  return out;
}

export async function ocrPdf(data: Uint8Array): Promise<OcrPage[]> {
  const dir = await mkdtemp(join(tmpdir(), "vx-ocr-"));
  try {
    await writeFile(join(dir, "in.pdf"), data);
    await run("pdftoppm", ["-r", "300", "-gray", "-png", "-l", String(OCR_MAX_PAGES), join(dir, "in.pdf"), join(dir, "page")], { timeout: 10 * 60_000 });
    const images = (await readdir(dir)).filter((f) => f.startsWith("page") && f.endsWith(".png")).sort();
    const pages: OcrPage[] = [];
    for (const [i, img] of images.entries()) {
      const { stdout } = await run("tesseract", [join(dir, img), "stdout", "-l", "eng", "--psm", "3", "tsv"], { timeout: 5 * 60_000, maxBuffer: 64 * 1048576 });
      pages.push({ page: i + 1, ...tsvToText(stdout) });
    }
    return pages;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function processOcrJob(db: WorkerDb, workerId: string): Promise<number> {
  const job = await db.claimOcrJob(workerId);
  if (!job) return 0;
  const tag = `[${workerId}] OCR ${job.id.slice(0, 8)}`;
  try {
    const scan = await db.scanStatusIn(job.bucket, job.storage_path);
    if (scan === "infected") throw new Error("the virus scan found this file infected");
    if (scan !== "clean" && await db.requireVirusScan()) throw new Error("waiting for the virus scan; request OCR again in a minute");
    const data = await db.downloadFrom(job.bucket, job.storage_path);
    if (createHash("sha256").update(data).digest("hex") !== job.sha256) throw new Error("the stored file does not match the sha256 recorded at upload");
    const pages = await ocrPdf(data);
    const chunks = ocrChunks(pages);
    if (!chunks.length) throw new Error("OCR found no text (blank pages, or not a scan of text)");
    const confs = pages.map((p) => p.confidence).filter((c): c is number => c != null);
    const mean = confs.length ? Math.round((confs.reduce((a, b) => a + b, 0) / confs.length) * 10) / 10 : null;
    await db.completeOcrJob(job.id, workerId, chunks, pages.length, mean, null);
    if (!job.keep_file) await db.removeFrom(job.bucket, [job.storage_path]);
    console.log(`${tag}: ${pages.length} page(s), ${chunks.length} excerpt(s), mean confidence ${mean ?? "n/a"}`);
  } catch (e) {
    const msg = (e as Error).message.slice(0, 500);
    console.error(`${tag} failed: ${msg}`);
    await db.completeOcrJob(job.id, workerId, [], 0, null, msg).catch((err) => console.error(`${tag}: could not record the failure: ${(err as Error).message}`));
    if (!job.keep_file) await db.removeFrom(job.bucket, [job.storage_path]).catch(() => undefined);
  }
  return 1;
}
