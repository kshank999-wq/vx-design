/**
 * Component evidence from datasheets: fetch the manufacturer PDF, extract its text, and check
 * that the part number and each claimed rating appear in it.
 *
 * This is a text match, not engineering verification: a value can appear in a different
 * context (another variant, a test condition). The UI labels it "found in datasheet text".
 */
import { createHash } from "node:crypto";

export interface ClaimCheck {
  parameter: string;
  value: string;
  found: boolean;
  excerpt: string | null;
}

export interface DatasheetEvidence {
  url: string;
  status: "checked" | "not_retrieved" | "not_pdf";
  error?: string;
  sha256?: string;
  pages?: number;
  mpn: { value: string | null; found: "exact" | "base" | "no" | "not_checked"; matched?: string };
  claims: ClaimCheck[];
}

const MAX_BYTES = 30 * 1024 * 1024;

/** Lower-case, drop whitespace and unify dashes/micro so "600 mA" matches "600mA". */
export function normalize(s: string): string {
  return s.toLowerCase().replace(/[‐-―−]/g, "-").replace(/µ|μ/g, "u").replace(/\s+/g, "");
}

function excerptAround(text: string, needle: string): string | null {
  // Search the normalized text, then map back roughly by searching the original with flexible spaces.
  const pattern = needle.split("").map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s*");
  const m = new RegExp(pattern, "i").exec(text);
  if (!m) return null;
  const start = Math.max(0, m.index - 80);
  return text.slice(start, m.index + m[0].length + 80)
    .replace(/[\u0000-\u001f\u007f-\u009f\ue000-\uf8ff\ufffd]/g, " ")   // control and private-use glyphs (PDF bullets)
    .replace(/\s+/g, " ").trim();
}

export function matchText(text: string, mpn: string | null, claims: { parameter: string; value: string }[]): Pick<DatasheetEvidence, "mpn" | "claims"> {
  const flat = normalize(text);
  let mpnResult: DatasheetEvidence["mpn"] = { value: mpn, found: "not_checked" };
  if (mpn) {
    const n = normalize(mpn);
    if (flat.includes(n)) mpnResult = { value: mpn, found: "exact", matched: mpn };
    else {
      // Ordering suffixes (packaging, reel) are often listed as a pattern; accept the longest prefix of
      // at least 6 characters that ends on a separator or the base part number.
      let base: string | undefined;
      for (let i = n.length - 1; i >= 6; i--) {
        if (flat.includes(n.slice(0, i)) && /[-/.]|[a-z]\d|\d[a-z]/.test(n.slice(i - 1, i + 1))) { base = n.slice(0, i); break; }
      }
      mpnResult = base ? { value: mpn, found: "base", matched: base.toUpperCase() } : { value: mpn, found: "no" };
    }
  }
  return {
    mpn: mpnResult,
    claims: claims.map((c) => {
      const found = flat.includes(normalize(c.value));
      return { parameter: c.parameter, value: c.value, found, excerpt: found ? excerptAround(text, normalize(c.value)) : null };
    }),
  };
}

export async function checkDatasheet(url: string, mpn: string | null, claims: { parameter: string; value: string }[],
                                     timeoutMs = 30_000): Promise<DatasheetEvidence> {
  const unchecked = (status: DatasheetEvidence["status"], error: string): DatasheetEvidence => ({
    url, status, error, mpn: { value: mpn, found: "not_checked" },
    claims: claims.map((c) => ({ ...c, found: false, excerpt: null })),
  });
  let bytes: Uint8Array;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "follow",
                                   headers: { "user-agent": "VX-Design-datasheet-check/1.0" } });
    if (!res.ok) return unchecked("not_retrieved", `HTTP ${res.status}`);
    const len = Number(res.headers.get("content-length") ?? 0);
    if (len > MAX_BYTES) return unchecked("not_retrieved", `larger than ${MAX_BYTES / 1024 / 1024} MB`);
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch (e) {
    return unchecked("not_retrieved", (e as Error).message);
  }
  if (new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-") return unchecked("not_pdf", "the URL did not return a PDF");
  try {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(bytes);
    const { text, totalPages } = await extractText(pdf, { mergePages: true });
    return {
      url, status: "checked", sha256: createHash("sha256").update(bytes).digest("hex"), pages: totalPages,
      ...matchText(Array.isArray(text) ? text.join("\n") : text, mpn, claims),
    };
  } catch (e) {
    return unchecked("not_pdf", `could not read the PDF: ${(e as Error).message}`);
  }
}
