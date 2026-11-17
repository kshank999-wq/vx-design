/**
 * Splits a parsed document into excerpts for the knowledge base. Every excerpt stays inside one section and
 * carries a citation locator ("§3.2 Conductor spacing, p. 12–13") and the ids of the blocks it holds, so an
 * answer that quotes it can be traced to the exact place in the source.
 */
import type { ParsedDocument } from "./document.ts";

export interface Excerpt {
  ordinal: number;
  locator: string;
  section_path: string;
  text: string;
  block_ids: string[];
}

export interface ChunkOptions {
  /** Soft target; a single block longer than maxChars is split at sentence boundaries. */
  maxChars?: number;
}

/** Database limit on one excerpt (source_chunks.text). */
export const EXCERPT_HARD_LIMIT = 4000;

function splitLong(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let cur = "";
  for (const sentence of text.split(/(?<=[.;:!?])\s+/)) {
    for (let piece = sentence; piece.length; ) {
      const room = max - (cur ? cur.length + 1 : 0);
      if (piece.length <= room) { cur = cur ? `${cur} ${piece}` : piece; piece = ""; }
      else if (cur) { out.push(cur); cur = ""; }
      else { out.push(piece.slice(0, max)); piece = piece.slice(max); }   // one sentence longer than max
    }
  }
  if (cur) out.push(cur);
  return out;
}

function pages(nums: (number | undefined)[]): string {
  const p = nums.filter((n): n is number => typeof n === "number");
  if (!p.length) return "";
  const lo = Math.min(...p), hi = Math.max(...p);
  return lo === hi ? `, p. ${lo}` : `, p. ${lo}–${hi}`;
}

export function chunkDocument(doc: ParsedDocument, opts: ChunkOptions = {}): Excerpt[] {
  const max = Math.min(opts.maxChars ?? 1200, EXCERPT_HARD_LIMIT);
  const out: Excerpt[] = [];
  for (const s of doc.sections) {
    if (!s.blocks.length) continue;
    const heading = s.number ? `§${s.number} ${s.title}` : s.title;
    const sectionPath = [...s.path, s.title].join(" > ");
    let parts: { text: string; id: string; page?: number }[] = [];
    const flush = () => {
      if (!parts.length) return;
      out.push({
        ordinal: out.length + 1,
        locator: `${heading}${pages(parts.map((p) => p.page))}`,
        section_path: sectionPath,
        text: parts.map((p) => p.text).join("\n"),
        block_ids: [...new Set(parts.map((p) => p.id))],
      });
      parts = [];
    };
    for (const b of s.blocks) {
      for (const piece of splitLong(b.text, max)) {
        const size = parts.reduce((n, p) => n + p.text.length + 1, 0);
        if (parts.length && size + piece.length > max) flush();
        parts.push({ text: piece, id: b.id, page: b.page });
      }
    }
    flush();
  }
  return out;
}
