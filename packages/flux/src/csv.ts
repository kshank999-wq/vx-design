/** Minimal RFC 4180 CSV reader (quoted fields, doubled quotes, CRLF), with delimiter sniffing (comma, semicolon, tab). */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const first = src.split(/\r?\n/, 1)[0] ?? "";
  const delim = [",", ";", "\t"].map((d) => [d, first.split(d).length] as const).sort((a, b) => b[1] - a[1])[0]![0];
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === delim) { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows.map((r) => r.map((f) => f.trim()));
}

const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Finds the column whose normalised header matches one of the candidates (exact first, then prefix). */
export function column(headers: string[], candidates: string[]): number {
  const hs = headers.map(norm);
  for (const c of candidates) { const i = hs.indexOf(norm(c)); if (i >= 0) return i; }
  for (const c of candidates) { const i = hs.findIndex((h) => h.startsWith(norm(c))); if (i >= 0) return i; }
  return -1;
}

export const DESIGNATOR_HEADERS = ["designator", "designators", "refdes", "reference", "references", "ref", "refs", "partreference"];

/** "R1, R2 R5-R7" -> ["R1", "R2", "R5", "R6", "R7"]. */
export function splitDesignators(s: string): string[] {
  const out: string[] = [];
  for (const tok of s.split(/[,;\s]+/).map((t) => t.trim()).filter(Boolean)) {
    const m = /^([A-Za-z_]+)(\d+)-(?:\1)?(\d+)$/.exec(tok);
    if (m && Number(m[3]) >= Number(m[2]) && Number(m[3]) - Number(m[2]) < 500) {
      for (let n = Number(m[2]); n <= Number(m[3]); n++) out.push(`${m[1]}${n}`);
    } else out.push(tok);
  }
  return out.map((d) => d.toUpperCase());
}
