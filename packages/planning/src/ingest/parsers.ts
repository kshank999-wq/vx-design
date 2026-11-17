import mammoth from "mammoth";
import { parse as parseHtml, type HTMLElement } from "node-html-parser";
import { buildDocument, looksLikeNumberedHeading, normalizeText, type ParsedDocument, type RawItem } from "./document.ts";

export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const PDF_MIME = "application/pdf";
export const SUPPORTED_MIME = [DOCX_MIME, PDF_MIME, "text/plain", "text/markdown"] as const;

export class UnsupportedDocumentError extends Error {}

export async function parseDocument(data: Uint8Array, mimeType: string, filename = ""): Promise<ParsedDocument> {
  const type = mimeType || guessMime(filename);
  if (type === DOCX_MIME) return parseDocx(data);
  if (type === PDF_MIME) return parsePdf(data);
  if (type.startsWith("text/")) return parseText(new TextDecoder().decode(data), type, data);
  throw new UnsupportedDocumentError(`Unsupported document type "${type}". Upload DOCX, PDF, Markdown or plain text.`);
}

export function guessMime(filename: string): string {
  const ext = filename.toLowerCase().split(".").pop();
  return ext === "docx" ? DOCX_MIME : ext === "pdf" ? PDF_MIME : ext === "md" ? "text/markdown" : ext === "txt" ? "text/plain" : "";
}

// --- DOCX ------------------------------------------------------------------------

export async function parseDocx(data: Uint8Array): Promise<ParsedDocument> {
  const result = await mammoth.convertToHtml(
    { buffer: Buffer.from(data) },
    { styleMap: ["p[style-name='Title'] => p.vx-title:fresh", "p[style-name='Subtitle'] => p.vx-subtitle:fresh"] },
  );
  const root = parseHtml(result.value);
  const items: RawItem[] = [];
  const walk = (el: HTMLElement): void => {
    for (const child of el.childNodes as HTMLElement[]) {
      const tag = child.tagName?.toLowerCase();
      if (!tag) continue;
      const text = child.textContent ?? "";
      if (/^h[1-6]$/.test(tag)) {
        items.push({ type: "heading", text, level: Number(tag[1]) });
      } else if (tag === "p") {
        const cls = child.getAttribute("class") ?? "";
        if (cls.includes("vx-title")) items.push({ type: "title", text });
        else items.push({ type: "block", kind: "paragraph", text });
      } else if (tag === "ul" || tag === "ol") {
        for (const li of child.querySelectorAll("li")) {
          // Only direct text of the item; nested lists are visited as their own items.
          const own = li.childNodes.filter((n) => (n as HTMLElement).tagName?.toLowerCase() !== "ul" && (n as HTMLElement).tagName?.toLowerCase() !== "ol");
          items.push({ type: "block", kind: "list_item", text: own.map((n) => n.textContent).join(" ") });
        }
      } else if (tag === "table") {
        for (const tr of child.querySelectorAll("tr")) {
          const cells = tr.querySelectorAll("td, th").map((c) => normalizeText(c.textContent ?? ""));
          if (cells.some(Boolean)) items.push({ type: "block", kind: "table_row", text: cells.join(" | ") });
        }
      } else {
        walk(child);
      }
    }
  };
  walk(root);
  const warnings = result.messages.filter((m) => !/Unrecognised paragraph style/.test(m.message)).map((m) => m.message);
  return buildDocument(items, data, DOCX_MIME, warnings);
}

// --- Plain text / Markdown --------------------------------------------------------

export function parseText(text: string, mimeType = "text/plain", raw?: Uint8Array): ParsedDocument {
  const items: RawItem[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) items.push({ type: "block", kind: "paragraph", text: paragraph.join(" ") });
    paragraph = [];
  };
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim().replace(/^>\s?/, "");
    const md = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (!trimmed) {
      flush();
    } else if (md) {
      flush();
      if (md[1]!.length === 1 && !items.some((i) => i.type !== "title")) items.push({ type: "title", text: md[2]! });
      else items.push({ type: "heading", text: md[2]!, level: md[1]!.length });
    } else if (/^([-*•]|\d+[.)])\s+/.test(trimmed) && !looksLikeNumberedHeading(trimmed)) {
      flush();
      items.push({ type: "block", kind: "list_item", text: trimmed.replace(/^([-*•]|\d+[.)])\s+/, "") });
    } else if (/^\|.*\|$/.test(trimmed)) {
      flush();
      if (!/^\|[\s:|-]+\|$/.test(trimmed)) {
        items.push({ type: "block", kind: "table_row", text: trimmed.slice(1, -1).split("|").map((c) => c.trim()).join(" | ") });
      }
    } else if (looksLikeNumberedHeading(trimmed)) {
      flush();
      items.push({ type: "heading", text: trimmed, level: 1 });
    } else {
      paragraph.push(trimmed);
    }
  }
  flush();
  return buildDocument(items, raw ?? text, mimeType);
}

// --- PDF ----------------------------------------------------------------------------

export async function parsePdf(data: Uint8Array): Promise<ParsedDocument> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(data));
  const { text } = await extractText(pdf, { mergePages: false });
  const pages = Array.isArray(text) ? text : [text];
  const items: RawItem[] = [];
  pages.forEach((pageText, i) => {
    let paragraph: string[] = [];
    const flush = () => {
      if (paragraph.length) items.push({ type: "block", kind: "paragraph", text: paragraph.join(" "), page: i + 1 });
      paragraph = [];
    };
    for (const line of pageText.split(/\n/)) {
      const t = line.trim();
      if (!t) flush();
      else if (looksLikeNumberedHeading(t)) {
        flush();
        items.push({ type: "heading", text: t, level: 1 });
      } else if (/^[-•▪●]\s+/.test(t)) {
        flush();
        items.push({ type: "block", kind: "list_item", text: t.replace(/^[-•▪●]\s+/, ""), page: i + 1 });
      } else paragraph.push(t);
    }
    flush();
  });
  const warnings = items.length ? [] : ["No extractable text found; the PDF may be scanned images and needs OCR."];
  return buildDocument(items, data, PDF_MIME, warnings);
}
