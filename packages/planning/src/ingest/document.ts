/**
 * Source-document model used for requirement extraction and citations.
 *
 * Every block of text gets a stable id (`S3.2.p4`) derived from the document
 * structure, so a requirement can cite exactly where it came from and the
 * citation can be checked mechanically against the original text.
 */
import { createHash } from "node:crypto";

export type BlockKind = "paragraph" | "list_item" | "table_row";

export interface Block {
  id: string;
  kind: BlockKind;
  text: string;
  page?: number;
}

export interface Section {
  /** Stable id: `S` + heading number when the heading is numbered ("S3.2"), else an ordinal ("S-07"). */
  id: string;
  number: string | null;
  title: string;
  level: number;
  /** Titles of enclosing sections, outermost first. */
  path: string[];
  blocks: Block[];
}

export interface ParsedDocument {
  title: string | null;
  sha256: string;
  mimeType: string;
  sections: Section[];
  warnings: string[];
}

/** Intermediate stream produced by each format parser. */
export type RawItem =
  | { type: "title"; text: string }
  | { type: "heading"; text: string; level: number }
  | { type: "block"; kind: BlockKind; text: string; page?: number };

const NUMBERED_HEADING = /^(\d+(?:\.\d+)*)\.?\s+(\S.*)$/;

/** 1 -> "a", 26 -> "z", 27 -> "aa" */
function letters(n: number): string {
  let s = "";
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(97 + ((n - 1) % 26)) + s;
  return s;
}

export function sha256(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function normalizeText(s: string): string {
  return s
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/ /g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Heuristic for documents without heading styles (plain text, PDF): a short line
 * starting with a section number and no sentence-ending period.
 */
export function looksLikeNumberedHeading(text: string): { number: string; title: string } | null {
  const m = NUMBERED_HEADING.exec(text.trim());
  if (!m || text.length > 90 || /[.;:]$/.test(text.trim())) return null;
  return { number: m[1]!, title: m[2]!.trim() };
}

export function buildDocument(items: RawItem[], data: Uint8Array | string, mimeType: string, warnings: string[] = []): ParsedDocument {
  let title: string | null = null;
  const sections: Section[] = [];
  const stack: Section[] = [];
  const usedIds = new Set<string>();
  const unnumberedCount = new Map<string, number>();

  const preamble = (): Section => {
    const s: Section = { id: "S0", number: null, title: "Preamble", level: 0, path: [], blocks: [] };
    usedIds.add(s.id);
    sections.push(s);
    stack.push(s);
    return s;
  };

  for (const item of items) {
    const text = normalizeText(item.text);
    if (!text) continue;
    if (item.type === "title") {
      title ??= text;
      continue;
    }
    if (item.type === "heading") {
      const numbered = looksLikeNumberedHeading(text);
      const number = numbered?.number ?? null;
      const level = number ? number.split(".").length : item.level;
      while (stack.length && stack[stack.length - 1]!.level >= level) stack.pop();
      // Unnumbered headings are named relative to their parent ("S2-a") so that
      // adding a heading elsewhere in the document does not renumber them.
      const parent = stack.filter((s) => s.level > 0).at(-1);
      const scope = parent?.id ?? "S";
      const k = (unnumberedCount.get(scope) ?? 0) + 1;
      unnumberedCount.set(scope, k);
      let id = number ? `S${number}` : `${scope}-${letters(k)}`;
      while (usedIds.has(id)) id += "'";
      usedIds.add(id);
      const section: Section = {
        id,
        number,
        title: numbered?.title ?? text,
        level,
        path: stack.filter((s) => s.level > 0).map((s) => s.title),
        blocks: [],
      };
      sections.push(section);
      stack.push(section);
      continue;
    }
    const current = stack[stack.length - 1] ?? preamble();
    current.blocks.push({ id: `${current.id}.p${current.blocks.length + 1}`, kind: item.kind, text, page: item.page });
  }
  return { title, sha256: sha256(data), mimeType, sections: sections.filter((s) => s.blocks.length || s.level > 0), warnings };
}

/** Renders the document with block ids, as given to the model for citation. */
export function renderForPrompt(doc: ParsedDocument): string {
  const out: string[] = [];
  for (const s of doc.sections) {
    const heading = s.number ? `${s.number} ${s.title}` : s.title;
    out.push(`\n[${s.id}] ${"#".repeat(Math.max(1, Math.min(s.level, 6)))} ${heading}`);
    for (const b of s.blocks) out.push(`[${b.id}] ${b.kind === "list_item" ? "- " : ""}${b.text}`);
  }
  return out.join("\n").trim();
}

export function findBlock(doc: ParsedDocument, blockId: string): { section: Section; block: Block } | null {
  for (const section of doc.sections) {
    const block = section.blocks.find((b) => b.id === blockId);
    if (block) return { section, block };
  }
  return null;
}

export interface CitationCheck {
  ok: boolean;
  /** Block that actually contains the excerpt (may differ from the cited one). */
  blockId?: string;
  sectionId?: string;
  reason?: string;
}

/**
 * Verifies that `excerpt` appears verbatim (after whitespace/quote normalization)
 * in the cited block. If the model cited the wrong block but the excerpt exists
 * elsewhere, the citation is corrected rather than rejected.
 */
export function verifyCitation(doc: ParsedDocument, blockId: string, excerpt: string): CitationCheck {
  const needle = normalizeText(excerpt).toLowerCase();
  if (needle.length < 8) return { ok: false, reason: "excerpt too short to be a meaningful citation" };
  const cited = findBlock(doc, blockId);
  if (cited && cited.block.text.toLowerCase().includes(needle)) {
    return { ok: true, blockId, sectionId: cited.section.id };
  }
  for (const section of doc.sections) {
    for (const block of section.blocks) {
      if (block.text.toLowerCase().includes(needle)) return { ok: true, blockId: block.id, sectionId: section.id };
    }
  }
  return { ok: false, reason: cited ? "excerpt not found in the document" : `unknown block id ${blockId}; excerpt not found` };
}
