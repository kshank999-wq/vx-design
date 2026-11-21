/**
 * Upload inspection (G6): what a file really is (by its bytes, not its name), and whether it is safe to keep and
 * hand to other people and tools. Rejects executables, extension/content mismatches for the kinds a form accepts,
 * archive tricks (path traversal, symlinks, encryption, zip bombs) and active content in SVG/HTML. It does not look
 * for viruses; that is the scanner's job (clamd.ts).
 */
export type Detected = "pdf" | "zip" | "docx" | "xlsx" | "png" | "jpeg" | "gif" | "webp" | "step" | "stl" | "gzip" | "svg" | "html"
  | "executable" | "script" | "text" | "binary";

export interface ZipInfo { entries: number; uncompressed: number; compressed: number; zip64: boolean; names: string[] }
export interface Inspection { detected: Detected; ok: boolean; problems: string[]; notes: string[]; zip?: ZipInfo }

export interface UploadPolicy {
  maxBytes: number;
  /** Kinds this form accepts, e.g. ["pdf", "docx", "text"]. */
  accept: Detected[];
  zip?: { maxEntries: number; maxUncompressed: number; maxRatio: number };
}
export const DEFAULT_ZIP = { maxEntries: 10_000, maxUncompressed: 2 * 1024 ** 3, maxRatio: 200 };

const at = (b: Uint8Array, s: string, off = 0) => s.split("").every((c, i) => b[off + i] === c.charCodeAt(0));
const u16 = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8);
const u32 = (b: Uint8Array, o: number) => (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16)) + b[o + 3]! * 0x1000000;
const ext = (name: string) => (/\.([A-Za-z0-9]+)$/.exec(name)?.[1] ?? "").toLowerCase();

function looksText(b: Uint8Array): boolean {
  const n = Math.min(b.length, 8192);
  let ctrl = 0;
  for (let i = 0; i < n; i++) {
    const c = b[i]!;
    if (c === 0) return false;
    if (c < 9 || (c > 13 && c < 32)) ctrl++;
  }
  return ctrl <= n * 0.01;
}

export function detect(b: Uint8Array): Detected {
  if (at(b, "%PDF-")) return "pdf";
  if (at(b, "PK\x03\x04") || at(b, "PK\x05\x06")) return "zip";
  if (at(b, "\x89PNG\r\n\x1a\n")) return "png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (at(b, "GIF87a") || at(b, "GIF89a")) return "gif";
  if (at(b, "RIFF") && at(b, "WEBP", 8)) return "webp";
  if (b[0] === 0x1f && b[1] === 0x8b) return "gzip";
  if (at(b, "MZ") || at(b, "\x7fELF") || [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].includes(u32(b, 0) >>> 0)
      || (b[0] === 0xca && b[1] === 0xfe && b[2] === 0xba && b[3] === 0xbe)) return "executable";
  if (b.length >= 84 && 84 + 50 * (u32(b, 80) >>> 0) === b.length) return "stl";   // binary STL: header, count, 50 bytes a triangle
  if (!looksText(b)) return "binary";
  const head = new TextDecoder().decode(b.subarray(0, 4096)).replace(/^﻿/, "").trimStart();
  if (head.startsWith("#!")) return "script";
  if (/^ISO-10303-21;/.test(head)) return "step";
  if (/^solid\b[^\n]*\n\s*facet\s/i.test(head)) return "stl";
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return "svg";
  if (/^(<!DOCTYPE html|<html[\s>])/i.test(head)) return "html";
  return "text";
}

/** Reads the ZIP central directory (no decompression) and checks every entry. */
export function inspectZip(b: Uint8Array, limits = DEFAULT_ZIP): { info: ZipInfo | null; problems: string[]; notes: string[] } {
  const problems: string[] = [], notes: string[] = [];
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65_535); i--) {
    if (b[i] === 0x50 && b[i + 1] === 0x4b && b[i + 2] === 0x05 && b[i + 3] === 0x06) { eocd = i; break; }
  }
  if (eocd < 0) return { info: null, problems: ["not a readable ZIP (no end-of-archive record)"], notes };
  let count = u16(b, eocd + 10), cdOffset = u32(b, eocd + 16);
  let zip64 = false;
  if (count === 0xffff || cdOffset === 0xffffffff) {
    zip64 = true;
    const loc = eocd - 20;   // ZIP64 end-of-central-directory locator
    if (loc >= 0 && b[loc] === 0x50 && b[loc + 1] === 0x4b && b[loc + 2] === 0x06 && b[loc + 3] === 0x07) {
      const rec = Number(new DataView(b.buffer, b.byteOffset).getBigUint64(loc + 8, true));
      if (rec + 56 <= b.length) {
        const dv = new DataView(b.buffer, b.byteOffset);
        count = Number(dv.getBigUint64(rec + 32, true));
        cdOffset = Number(dv.getBigUint64(rec + 48, true));
      }
    }
  }
  if (count > limits.maxEntries) problems.push(`the archive has ${count} entries (limit ${limits.maxEntries})`);
  const names: string[] = [];
  let p = cdOffset, uncompressed = 0, compressed = 0, bad = { traversal: 0, symlink: 0, encrypted: 0, bomb: 0 };
  for (let i = 0; i < Math.min(count, limits.maxEntries); i++) {
    if (p + 46 > b.length || !(b[p] === 0x50 && b[p + 1] === 0x4b && b[p + 2] === 0x01 && b[p + 3] === 0x02)) {
      problems.push("the archive's directory is damaged");
      break;
    }
    const flags = u16(b, p + 8);
    let csize = u32(b, p + 20), usize = u32(b, p + 24);
    const nlen = u16(b, p + 28), xlen = u16(b, p + 30), clen = u16(b, p + 32);
    const extAttr = u32(b, p + 38);
    const name = new TextDecoder().decode(b.subarray(p + 46, p + 46 + nlen));
    // ZIP64 extra field carries the real sizes.
    if (usize === 0xffffffff || csize === 0xffffffff) {
      zip64 = true;
      let x = p + 46 + nlen;
      const end = x + xlen;
      while (x + 4 <= end) {
        const id = u16(b, x), size = u16(b, x + 2);
        if (id === 0x0001) {
          const dv = new DataView(b.buffer, b.byteOffset);
          let o = x + 4;
          if (usize === 0xffffffff) { usize = Number(dv.getBigUint64(o, true)); o += 8; }
          if (csize === 0xffffffff) { csize = Number(dv.getBigUint64(o, true)); }
        }
        x += 4 + size;
      }
    }
    names.push(name);
    uncompressed += usize; compressed += csize;
    if (/(^|[\\/])\.\.([\\/]|$)/.test(name) || /^([\\/]|[A-Za-z]:)/.test(name) || name.includes("\0")) bad.traversal++;
    if (((extAttr >>> 16) & 0o170000) === 0o120000) bad.symlink++;
    if (flags & 1) bad.encrypted++;
    if (usize > 1024 * 1024 && csize > 0 && usize / csize > limits.maxRatio) bad.bomb++;
    p += 46 + nlen + xlen + clen;
  }
  if (bad.traversal) problems.push(`${bad.traversal} entr${bad.traversal === 1 ? "y" : "ies"} with a path that leaves the archive folder`);
  if (bad.symlink) problems.push(`${bad.symlink} symbolic link(s) in the archive`);
  if (bad.encrypted) problems.push(`${bad.encrypted} encrypted entr${bad.encrypted === 1 ? "y" : "ies"} (cannot be checked)`);
  if (bad.bomb) problems.push(`${bad.bomb} entr${bad.bomb === 1 ? "y" : "ies"} compressed more than ${limits.maxRatio}:1 (possible zip bomb)`);
  if (uncompressed > limits.maxUncompressed) problems.push(`unpacks to ${(uncompressed / 1024 ** 3).toFixed(1)} GB (limit ${(limits.maxUncompressed / 1024 ** 3).toFixed(1)} GB)`);
  if (zip64) notes.push("ZIP64 archive");
  return { info: { entries: names.length, uncompressed, compressed, zip64, names }, problems, notes };
}

const EXT_KIND: Record<string, Detected[]> = {
  pdf: ["pdf"], zip: ["zip"], docx: ["zip"], xlsx: ["zip"], png: ["png"], jpg: ["jpeg"], jpeg: ["jpeg"], gif: ["gif"], webp: ["webp"],
  step: ["step"], stp: ["step"], stl: ["stl"], svg: ["svg"], html: ["html"], htm: ["html"], gz: ["gzip"], tgz: ["gzip"],
};

export function inspectUpload(name: string, b: Uint8Array, policy: UploadPolicy): Inspection {
  const problems: string[] = [], notes: string[] = [];
  let detected = detect(b);
  let zip: ZipInfo | undefined;
  if (b.length > policy.maxBytes) problems.push(`larger than ${(policy.maxBytes / 1048576).toFixed(0)} MB`);
  if (b.length === 0) problems.push("the file is empty");
  if (detected === "executable") problems.push("this is a program (executable), not a document");
  if (detected === "script") problems.push("this is a script (starts with #!), not a document");
  if (detected === "zip") {
    const z = inspectZip(b, policy.zip ?? DEFAULT_ZIP);
    problems.push(...z.problems); notes.push(...z.notes);
    if (z.info) {
      zip = z.info;
      if (z.info.names.includes("word/document.xml")) detected = "docx";
      else if (z.info.names.includes("xl/workbook.xml")) detected = "xlsx";
      if (z.info.names.some((n) => /\.(docm|xlsm|pptm)$/i.test(n) || /vbaProject\.bin$/i.test(n))) problems.push("contains Office macros");
      const exe = z.info.names.filter((n) => /\.(exe|dll|scr|bat|cmd|com|msi|ps1|vbs|js|jar|app|sh)$/i.test(n));
      if (exe.length) problems.push(`contains program files: ${exe.slice(0, 5).join(", ")}${exe.length > 5 ? "…" : ""}`);
    }
  }
  if (detected === "svg" || detected === "html") {
    const s = new TextDecoder().decode(b);
    if (/<script[\s>]|\son[a-z]+\s*=|javascript:|<foreignObject|<iframe|<embed|<object/i.test(s)) problems.push(`the ${detected.toUpperCase()} contains script or embedded content`);
  }
  const e = ext(name);
  const expected = EXT_KIND[e];
  if (expected && !expected.includes(detected) && !(e === "zip" && ["docx", "xlsx"].includes(detected)) && !(["docx", "xlsx"].includes(e) && detected === e)) {
    problems.push(`named .${e} but the content is ${detected}`);
  }
  if (!policy.accept.includes(detected) && !(detected === "docx" && policy.accept.includes("zip")) && !(detected === "xlsx" && policy.accept.includes("zip"))) {
    problems.push(`${detected} files are not accepted here (accepted: ${policy.accept.join(", ")})`);
  }
  return { detected, ok: problems.length === 0, problems: [...new Set(problems)], notes, zip };
}
