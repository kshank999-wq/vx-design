/**
 * Parts from their files. A manufacturer datasheet is read for the part being chosen: its orderable part number (kept
 * only if it appears in the datasheet), manufacturer, what it is, the product subsystem it belongs to, and its key
 * specifications copied from the datasheet. 3D model files (STEP) are matched to parts by the names inside them and
 * their file names.
 */
import { z } from "zod";
import type { LanguageModel, Usage } from "./llm/model.ts";
import { SUBSYSTEMS } from "./prior-work.ts";

export const PART_IDENTIFY_PROMPT_VERSION = "part-identify-v1";

export const PartIdentity = z.object({
  mpn: z.string().nullable().describe("The orderable manufacturer part number exactly as printed (the full ordering code when the datasheet lists one), or null if none is shown"),
  manufacturer: z.string().nullable(),
  title: z.string().describe("What the part is, in a few words: '10.1-inch IPS TFT display with capacitive touch'"),
  subsystem: z.enum(SUBSYSTEMS),
  specs: z.array(z.object({ name: z.string(), value: z.string().describe("With units, copied from the datasheet") })).describe("Up to 12 key specifications"),
  variants: z.array(z.string()).describe("Other ordering codes in the same datasheet (other options of the same part), if any"),
});
export type PartIdentity = z.infer<typeof PartIdentity>;

const SYSTEM = `You read manufacturer datasheets for a hardware team. The team has already chosen this part; identify it so it can be recorded without typing.

Give the orderable manufacturer part number exactly as printed. When the datasheet lists several ordering codes (options, packages, temperature grades), give the one the file name or the document title points to, or the first full ordering code, and list the others as variants. Give the manufacturer, a few words on what the part is, the product subsystem it belongs to, and up to 12 key specifications with their values and units copied from the datasheet (size, resolution, interface, supply voltage and current, temperature range, accuracy, package). Do not invent values that are not in the text.`;

const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** The datasheet text a model reads: the start (title, features, ordering information) and the end (ordering codes). */
export function datasheetExcerpt(text: string, max = 60_000): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.floor(max * 0.75))}\n\n[...]\n\n${text.slice(-Math.floor(max * 0.25))}`;
}

export async function identifyPart(text: string, filename: string, model: LanguageModel):
    Promise<{ promptVersion: string; identity: PartIdentity | null; problem: string | null; usage: Usage }> {
  const r = await model.generate({ purpose: "part_identify", system: SYSTEM, effort: "low",
    messages: [{ role: "user", content: `FILE: ${filename}\n\n${datasheetExcerpt(text)}` }], schema: PartIdentity });
  const id = r.output;
  const body = norm(text);
  if (!id.mpn || norm(id.mpn).length < 3) return { promptVersion: PART_IDENTIFY_PROMPT_VERSION, identity: null, problem: "no part number found in the datasheet", usage: r.usage };
  if (!body.includes(norm(id.mpn))) {
    // The model's code is not in the text: fall back to a variant that is, else refuse rather than invent one.
    const v = id.variants.find((x) => norm(x).length >= 3 && body.includes(norm(x)));
    if (!v) return { promptVersion: PART_IDENTIFY_PROMPT_VERSION, identity: null, problem: `part number ${id.mpn} does not appear in the datasheet`, usage: r.usage };
    id.mpn = v;
  }
  id.specs = id.specs.slice(0, 12);
  return { promptVersion: PART_IDENTIFY_PROMPT_VERSION, identity: id, problem: null, usage: r.usage };
}

const KEYWORDS: [RegExp, (typeof SUBSYSTEMS)[number]][] = [
  [/display|lcd|tft|oled|touch ?screen|touch panel/i, "display"], [/battery|li-?ion|lipo|cell/i, "battery"],
  [/oscillator|tcxo|crystal|rtc|real-time clock|timecode/i, "timecode"], [/bluetooth|wi-?fi|antenna|lora|radio|rf /i, "rf_wireless"],
  [/regulator|buck|boost|ldo|charger|pmic/i, "power"], [/connector|header|receptacle|socket/i, "connectors_cabling"],
  [/compute module|processor|soc|microcontroller|mcu/i, "compute"], [/emmc|flash|sd card|memory/i, "storage"],
];

/** The product subsystem a part's description points to (keyword rules). */
export function classifySubsystem(text: string): (typeof SUBSYSTEMS)[number] {
  return KEYWORDS.find(([re]) => re.test(text))?.[1] ?? "other";
}

const LABELLED = /(?:part\s*(?:number|no\.?|#)|ordering\s*(?:code|number|information)|order(?:ing)?\s*(?:code|no\.?|number)|p\/n|model\s*(?:number|no\.?))\s*[:#]?\s*([A-Z0-9][A-Z0-9._\/()+-]{2,40})/gi;
const NOT_A_PART = /^(rev|ver|v|version)[\s.]*[\d.]+[a-z]?$|^(page|pages|fig|table|step|pdf|zip|3d|2d|datasheet|data|sheet)\.?\d*[a-z]?$|^\d{1,4}(mm|v|a|ma|mhz|ghz|khz|w|pin|pins|pcs|x\d+)?$|^(19|20)\d{2}[-_]?\d{0,4}$/i;

/**
 * Part numbers a datasheet points to, best first, without AI: codes labelled "Part number" or "Ordering code" in its
 * text, then code-like words in its file name and in the name of the package it came in. A candidate is kept only if
 * it appears in the datasheet text, so a guess from a file name is never taken on trust.
 */
export function partNumberCandidates(text: string, filename: string, pkg?: string | null): string[] {
  const body = norm(text);
  const out: string[] = [];
  const add = (c: string) => {
    const t = c.trim().replace(/^[^A-Z0-9]+|[^A-Z0-9)]+$/gi, "");
    if (t.length < 4 || t.length > 40 || NOT_A_PART.test(t) || !/[A-Z]/i.test(t) || !/\d/.test(t)) return;
    if (!body.includes(norm(t)) || out.some((x) => norm(x) === norm(t))) return;
    out.push(t);
  };
  for (const m of text.matchAll(LABELLED)) add(m[1]!);
  const names = [filename.replace(/\.[^.]+$/, ""), pkg ?? ""].join(" ");
  const words = names.split(/[\s_,;]+/).filter(Boolean);
  for (const w of words.sort((a, b) => b.length - a.length)) {
    add(w);
    add(w.replace(/\([^)]*\)$/, ""));          // DM1AA-SF-PEJ(82) -> DM1AA-SF-PEJ
  }
  return out;
}

/** A distributor or catalog record as a part identity: its own part number, maker, description and specifications. */
export function identityFromRecord(r: { mpn: string; manufacturer: string | null; description: string | null; package?: string | null;
                                        lifecycle?: string | null; specs: Record<string, string> }): PartIdentity {
  const specs = Object.entries(r.specs ?? {}).filter(([k, v]) => k && v && String(v).trim() && String(v) !== "-").map(([name, value]) => ({ name, value: String(value) }));
  if (r.package && !specs.some((x) => /package|case/i.test(x.name))) specs.unshift({ name: "Package", value: r.package });
  if (r.lifecycle && r.lifecycle !== "unknown") specs.push({ name: "Lifecycle", value: r.lifecycle.replace(/_/g, " ") });
  const title = r.description?.trim() || r.mpn;
  return { mpn: r.mpn, manufacturer: r.manufacturer, title, subsystem: classifySubsystem(`${title}\n${specs.map((x) => x.value).join(" ")}`), specs: specs.slice(0, 12), variants: [] };
}

/** Offline stand-in (not AI): the part number after a "Part number" or "Ordering code" label, and labelled facts. */
export function offlinePartIdentity(prompt: string): PartIdentity {
  const body = prompt.slice(prompt.indexOf("\n\n") + 2);
  const label = (re: RegExp) => re.exec(body)?.[1]?.trim() ?? null;
  const mpn = label(/(?:part (?:number|no\.?)|ordering code|order(?:ing)? number|p\/n)\s*[:#]?\s*([A-Z0-9][A-Z0-9._/-]{2,40})/i);
  const manufacturer = label(/manufacturer\s*[:]\s*([^\n]{2,60})/i);
  const title = label(/(?:description|product)\s*[:]\s*([^\n]{3,120})/i) ?? body.split("\n").find((l) => l.trim().length > 8)?.trim().slice(0, 120) ?? "Part";
  const specs = [...body.matchAll(/^([A-Z][A-Za-z ()/-]{2,40}):\s*([^\n]*\d[^\n]{0,60})$/gm)]
    .filter((m) => !/part|order|manufacturer|description|product/i.test(m[1]!)).slice(0, 12).map((m) => ({ name: m[1]!.trim(), value: m[2]!.trim() }));
  const subsystem = classifySubsystem(`${title}\n${body.slice(0, 2000)}`);
  return { mpn, manufacturer, title, subsystem, specs, variants: [] };
}

/** Names inside a STEP file's header and product records (vendors put the part number there). */
export function stepNames(bytes: Uint8Array): string[] {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, Math.min(bytes.length, 2_000_000)));
  if (!/^\s*ISO-10303-21;/.test(head)) return [];
  const names = new Set<string>();
  for (const m of head.matchAll(/FILE_NAME\s*\(\s*'([^']*)'/g)) names.add(m[1]!);
  for (const m of head.matchAll(/PRODUCT\s*\(\s*'([^']*)'\s*,\s*'([^']*)'/g)) { names.add(m[1]!); names.add(m[2]!); }
  return [...names].map((x) => x.trim()).filter((x) => x.length >= 3);
}

/**
 * Which part a model file belongs to: a part number (or variant) found in the names inside the file or in its file
 * name. The longest match wins (so ABC-12 is not mistaken for ABC-123); null when none matches.
 */
export function matchModelToPart<T extends { mpn: string; variants?: string[] }>(filename: string, inside: string[], parts: T[]): T | null {
  const hay = norm([filename.replace(/\.[^.]+$/, ""), ...inside].join(" "));
  let best: T | null = null, bestLen = 0;
  for (const p of parts) {
    for (const code of [p.mpn, ...(p.variants ?? [])]) {
      const n = norm(code);
      if (n.length >= 4 && hay.includes(n) && n.length > bestLen) { best = p; bestLen = n.length; }
    }
  }
  return best;
}

/** Plain text of a datasheet (PDF, Word, Markdown or text), or null when it has none (a scanned image PDF). */
export async function datasheetText(bytes: Uint8Array, filename: string): Promise<string | null> {
  if (/\.pdf$/i.test(filename) || (bytes[0] === 0x25 && bytes[1] === 0x50)) {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const { text } = await extractText(await getDocumentProxy(new Uint8Array(bytes)), { mergePages: true });
    const t = (Array.isArray(text) ? text.join("\n") : text).trim();
    return t.length > 20 ? t : null;
  }
  if (/\.(docx|md|markdown|txt)$/i.test(filename)) {
    const { parseDocument } = await import("./ingest/parsers.ts");
    const d = await parseDocument(bytes, "", filename);
    return d.sections.map((s) => [s.title, ...s.blocks.map((b) => b.text)].filter(Boolean).join("\n")).join("\n\n").trim() || null;
  }
  return null;
}
