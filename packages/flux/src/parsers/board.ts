import { unzipSync } from "fflate";
import type { BoardFacts, ParsedFile } from "../model.ts";

const dec = (b: Uint8Array) => new TextDecoder("utf-8", { fatal: false }).decode(b);
const r2 = (x: number) => Math.round(x * 100) / 100;
const bbox = (pts: [number, number][]) => {
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return { width_mm: r2(Math.max(...xs) - Math.min(...xs)), height_mm: r2(Math.max(...ys) - Math.min(...ys)) };
};

/**
 * ODB++ job (a ZIP): copper layers from matrix/matrix (CONTEXT=BOARD, TYPE=SIGNAL, POWER_GROUND or MIXED), and the
 * board outline from the step's profile (OB/OS points; units from the profile's UNITS line, else misc/info).
 */
export function parseOdb(path: string, data: Uint8Array): ParsedFile {
  const notes: string[] = [];
  let files: Record<string, Uint8Array> = {};
  try {
    files = unzipSync(data, { filter: (f) => /(^|\/)(matrix\/matrix|misc\/info|steps\/[^/]+\/profile|steps\/[^/]+\/layers\/[^/]+\/features)$/i.test(f.name) });
  } catch (e) {
    return { source: "odbpp", path, notes: [`could not unpack: ${(e as Error).message}`] };
  }
  const get = (re: RegExp) => Object.entries(files).find(([n]) => re.test(n))?.[1];
  const board: BoardFacts = {};
  const meta: Record<string, unknown> = {};
  const matrix = get(/(^|\/)matrix\/matrix$/i);
  if (matrix) {
    const layers = [...dec(matrix).matchAll(/LAYER\s*\{([^}]*)\}/g)].map((m) => {
      const kv = Object.fromEntries([...m[1]!.matchAll(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/gm)].map((x) => [x[1]!, x[2]!]));
      return { row: Number(kv.ROW ?? 0), context: kv.CONTEXT ?? "", type: kv.TYPE ?? "", name: kv.NAME ?? "" };
    }).sort((a, b) => a.row - b.row);
    const copper = layers.filter((l) => /^BOARD$/i.test(l.context) && /^(SIGNAL|POWER_GROUND|MIXED)$/i.test(l.type));
    if (copper.length) {
      board.copper_layers = copper.length; board.layer_names = copper.map((l) => l.name.toLowerCase());
      // Routing: line (L), arc (A) and surface (S) records on the copper layers; pads (P) alone mean nothing is routed.
      const counts = { pads: 0, tracks: 0, surfaces: 0 };
      for (const l of copper) {
        const f = get(new RegExp(`steps/[^/]+/layers/${l.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/features$`, "i"));
        for (const line of f ? dec(f).split(/\r?\n/) : []) {
          if (/^P\s/.test(line)) counts.pads++; else if (/^[LA]\s/.test(line)) counts.tracks++; else if (/^S\s/.test(line)) counts.surfaces++;
        }
      }
      meta.copper = counts;
    } else notes.push("no copper layers in matrix/matrix");
  } else notes.push("no matrix/matrix");
  const profile = get(/steps\/[^/]+\/profile$/i);
  if (profile) {
    const src = dec(profile);
    const info = get(/(^|\/)misc\/info$/i);
    const units = /^\s*UNITS\s*=\s*(\w+)/im.exec(src)?.[1] ?? (info ? /^\s*UNITS\s*=\s*(\w+)/im.exec(dec(info))?.[1] : undefined) ?? "INCH";
    const k = /^MM$/i.test(units) ? 1 : 25.4;
    const pts = [...src.matchAll(/^\s*(?:OB|OS)\s+(-?[\d.]+)\s+(-?[\d.]+)/gm)].map((m) => [Number(m[1]) * k, Number(m[2]) * k] as [number, number]);
    if (pts.length >= 3) Object.assign(board, bbox(pts));
    else notes.push("no outline points in the profile");
  } else notes.push("no step profile (board outline)");
  return { source: "odbpp", path, board, meta, notes };
}

/**
 * IDF 3.0 board file (.emn): units from the header (MM or THOU), thickness and outline from .BOARD_OUTLINE, and
 * drilled holes. Library files (.emp) carry no board and are skipped.
 */
export function parseIdf(path: string, src: string): ParsedFile | null {
  const lines = src.split(/\r?\n/);
  const hdr = lines.findIndex((l) => /^\s*\.HEADER\b/i.test(l));
  if (hdr < 0 || !/BOARD_FILE|PANEL_FILE/i.test(lines[hdr + 1] ?? "")) return null;
  const k = /\bTHOU\b/i.test(lines[hdr + 2] ?? "") ? 0.0254 : 1;
  const board: BoardFacts = {};
  const notes: string[] = [];
  const start = lines.findIndex((l) => /^\s*\.BOARD_OUTLINE\b/i.test(l));
  if (start >= 0) {
    const t = Number(lines[start + 1]?.trim());
    if (Number.isFinite(t) && t > 0) board.thickness_mm = r2(t * k);
    const pts: [number, number][] = [];
    for (let i = start + 2; i < lines.length && !/^\s*\.END_BOARD_OUTLINE/i.test(lines[i]!); i++) {
      const f = lines[i]!.trim().split(/\s+/).map(Number);
      if (f.length >= 3 && f.every(Number.isFinite)) pts.push([f[1]! * k, f[2]! * k]);
    }
    if (pts.length >= 3) Object.assign(board, bbox(pts));
    else notes.push("board outline has no points");
  } else notes.push("no .BOARD_OUTLINE section");
  const holes: BoardFacts["holes"] = [];
  const dh = lines.findIndex((l) => /^\s*\.DRILLED_HOLES\b/i.test(l));
  for (let i = dh + 1; dh >= 0 && i < lines.length && !/^\s*\.END_DRILLED_HOLES/i.test(lines[i]!); i++) {
    const f = lines[i]!.trim().split(/\s+/);
    const [d, x, y] = f.slice(0, 3).map(Number);
    if ([d, x, y].every((v) => Number.isFinite(v))) holes.push({ d_mm: r2(d! * k), x_mm: r2(x! * k), y_mm: r2(y! * k) });
  }
  if (holes.length) board.holes = holes;
  return { source: "idf", path, board, notes };
}
