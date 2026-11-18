import { text, type InventoryFile } from "./inventory.ts";

/** Text documents that may hold prior decisions and claimed validations (chat exports, notes, reports, Markdown). */
export function historyDocuments(files: InventoryFile[]): { file: string; text: string }[] {
  return files.filter((f) => f.kind === "text")
    .map((f) => ({ file: f.path, text: text(f) }))
    .filter((d) => d.text.trim().length > 0);
}

const ws = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/** Keeps only items whose quote appears word for word (ignoring whitespace and case) in the named file. */
export function keepQuoted<T extends { file: string; quote: string }>(items: T[], docs: { file: string; text: string }[]): { kept: T[]; dropped: number } {
  const byFile = new Map(docs.map((d) => [d.file, ws(d.text)]));
  const kept = items.filter((i) => i.quote.trim().length >= 8 && (byFile.get(i.file)?.includes(ws(i.quote)) ?? false));
  return { kept, dropped: items.length - kept.length };
}
