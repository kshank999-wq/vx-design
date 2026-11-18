import type { BoardFacts, ParsedFile } from "../model.ts";

export type GerberFunction = "copper" | "profile" | "soldermask" | "silkscreen" | "paste" | "other";
export interface GerberLayer { path: string; fn: GerberFunction; side: "top" | "bottom" | "inner" | null; index: number | null; attr: string | null }

const COPPER_EXT: Record<string, "top" | "bottom" | "inner"> = { gtl: "top", gbl: "bottom", cmp: "top", sol: "bottom" };

/** Layer function from the X2 file attribute when present, else from the file name. */
export function gerberLayer(path: string, src: string): GerberLayer {
  const name = path.split(/[/!]/).pop()!.toLowerCase();
  const ff = /%TF\.FileFunction,([^*]+)\*%/.exec(src)?.[1] ?? null;
  if (ff) {
    const [kind = "", a = "", b = ""] = ff.split(",");
    const k = kind.toLowerCase();
    if (k === "copper") {
      const idx = Number(/^L(\d+)$/i.exec(a)?.[1] ?? NaN);
      const side = /^top$/i.test(b) ? "top" : /^bot/i.test(b) ? "bottom" : "inner";
      return { path, fn: "copper", side, index: Number.isFinite(idx) ? idx : null, attr: ff };
    }
    const fn: GerberFunction = k === "profile" ? "profile" : k === "soldermask" ? "soldermask" : k === "legend" ? "silkscreen" : k === "paste" ? "paste" : "other";
    return { path, fn, side: /top/i.test(a) ? "top" : /bot/i.test(a) ? "bottom" : null, index: null, attr: ff };
  }
  const e = /\.([a-z0-9]+)$/.exec(name)?.[1] ?? "";
  if (COPPER_EXT[e]) return { path, fn: "copper", side: COPPER_EXT[e]!, index: null, attr: null };
  if (/^g(l)?\d$|^gp\d$/.test(e) || /(in\d+_cu|inner|_l\d+\b)/.test(name)) return { path, fn: "copper", side: "inner", index: null, attr: null };
  if (/(^|[_.-])(f|front|top)[_.-]?cu\b|copper[_.-]?top|top[_.-]?copper|top[_.-]?layer/.test(name)) return { path, fn: "copper", side: "top", index: null, attr: null };
  if (/(^|[_.-])(b|back|bottom)[_.-]?cu\b|copper[_.-]?bot|bottom[_.-]?copper|bottom[_.-]?layer/.test(name)) return { path, fn: "copper", side: "bottom", index: null, attr: null };
  if (/^(gko|gm1|gml|gm)$/.test(e) || /edge[_.-]?cuts|outline|profile|board[_.-]?edge/.test(name)) return { path, fn: "profile", side: null, index: null, attr: null };
  if (/^(gts|gbs)$/.test(e) || /mask/.test(name)) return { path, fn: "soldermask", side: e === "gbs" || /b(ot|ack)/.test(name) ? "bottom" : "top", index: null, attr: null };
  if (/^(gto|gbo|plc|pls)$/.test(e) || /silk|legend/.test(name)) return { path, fn: "silkscreen", side: null, index: null, attr: null };
  if (/^(gtp|gbp)$/.test(e) || /paste/.test(name)) return { path, fn: "paste", side: null, index: null, attr: null };
  return { path, fn: "other", side: null, index: null, attr: null };
}

/** Bounding box of every coordinate in a Gerber file (arcs approximated by their end points), in mm. */
export function gerberExtents(src: string): { width_mm: number; height_mm: number } | null {
  const fs = /%FS([LT])([AI])X(\d)(\d)Y(\d)(\d)\*%/.exec(src);
  if (!fs) return null;
  const inch = /%MOIN\*%/.test(src);
  const [intX, decX, intY, decY] = [Number(fs[3]), Number(fs[4]), Number(fs[5]), Number(fs[6])];
  const conv = (s: string, ints: number, decs: number) => {
    const neg = s.startsWith("-");
    let d = s.replace(/^[+-]/, "");
    if (fs[1] === "T") d = d.padEnd(ints + decs, "0");
    const v = Number(d) / 10 ** decs;
    return (neg ? -v : v) * (inch ? 25.4 : 1);
  };
  let x = 0, y = 0, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, n = 0;
  for (const m of src.matchAll(/(?:G0?[123])?(?:X([+-]?\d+))?(?:Y([+-]?\d+))?(?:I[+-]?\d+)?(?:J[+-]?\d+)?D0?[123]\*/g)) {
    if (m[1] === undefined && m[2] === undefined) continue;
    if (m[1] !== undefined) x = conv(m[1], intX, decX);
    if (m[2] !== undefined) y = conv(m[2], intY, decY);
    minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); n++;
  }
  if (!n) return null;
  return { width_mm: +(maxX - minX).toFixed(3), height_mm: +(maxY - minY).toFixed(3) };
}

/** All Gerber layers of one revision together: copper count and the outline size. */
export function summariseGerbers(layers: { path: string; src: string }[]): ParsedFile {
  const parsed = layers.map((l) => ({ ...gerberLayer(l.path, l.src), src: l.src }));
  const copper = parsed.filter((l) => l.fn === "copper");
  const profile = parsed.find((l) => l.fn === "profile");
  const ext = profile ? gerberExtents(profile.src) : null;
  const notes: string[] = [];
  if (!profile) notes.push("no board outline (profile) layer found");
  else if (!ext) notes.push(`the outline layer ${profile.path} has no readable coordinates`);
  const unknown = parsed.filter((l) => l.fn === "other").map((l) => l.path.split(/[/!]/).pop());
  if (unknown.length) notes.push(`layer function not recognised: ${unknown.join(", ")}`);
  const board: BoardFacts = {
    copper_layers: copper.length || null,
    layer_names: copper.sort((a, b) => (a.index ?? (a.side === "top" ? 0 : a.side === "bottom" ? 99 : 50)) - (b.index ?? (b.side === "top" ? 0 : b.side === "bottom" ? 99 : 50)))
      .map((l) => l.path.split(/[/!]/).pop()!),
    width_mm: ext?.width_mm ?? null, height_mm: ext?.height_mm ?? null,
  };
  return { source: "gerber", path: layers[0]?.path ?? "", board, meta: { layers: parsed.map(({ src: _s, ...l }) => l) }, notes };
}
