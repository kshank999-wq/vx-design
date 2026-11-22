/**
 * Requirements read by rules, without AI. A specification is mostly sentences of the form "The slate shall …": when a
 * sentence states one obligation with shall, must or should, it is taken as written, classified by its words, and cited
 * exactly. Everything else goes to the model, block by block: compound sentences, spec lines and direction written
 * without a modal verb, options (may) and anything the rules are unsure of. Only sections about the document itself
 * (revision history, glossary, references, overview) are skipped.
 */
import type { RequirementKind } from "@vx/contracts";
import type { Block, ParsedDocument, Section } from "./ingest/document.ts";

export interface RuleRequirement {
  statement: string;
  kind: RequirementKind;
  priority: "must" | "should" | "may";
  blockId: string;
  excerpt: string;
  acceptanceCriteria: string | null;
  ambiguity: string | null;
}

/** Sections that are about the document, not the product. */
const INFORMATIONAL = /^(revision|change|document) (history|log|control)|^(glossary|abbreviations|acronyms|definitions|references|table of contents|contents|approvals?|sign-?off|introduction|overview|background|purpose of this document|about this document|appendix)\b/i;
const MODAL = /\b(shall|must|should|may|is required to|are required to|will be required to)\b/gi;
const VAGUE = /\b(adequate|appropriate|sufficient(ly)?|robust|user[- ]friendly|easy|easily|fast|quick(ly)?|minimi[sz]e|maximi[sz]e|as needed|as required|if possible|where possible|optimal|reasonable|approximately|about|etc\.?|and\/or|good|high quality|intuitive|seamless(ly)?)\b/i;
const OPEN = /\b(tbd|tbc|to be (determined|confirmed|defined|decided))\b/i;

const KINDS: [RegExp, RequirementKind][] = [
  [/\b(fcc|ce mark|ul ?\d{2,}|rohs|reach|weee|certif\w*|compl(y|iance)|regulation|regulatory|en ?\d{3,}|iec ?\d{3,}|etsi|ised|ukca|un ?38\.3|prop(osition)? 65)\b/i, "regulatory"],
  [/\b(ip[0-9x]{2}|drop|shock|vibration|humidity|waterproof|water[- ]resistant|dust|rain|sunlight|uv\b|outdoor|operating temperature|storage temperature|altitude|salt)\b/i, "environmental"],
  [/\b(battery|batteries|charg(e|ing|er)|power supply|power consumption|current draw|supply current|rail|input range|input voltage|mah|wh\b|runtime|run time|battery life|watts?|standby|ldo|low-dropout|regulator|buck|boost)\b|\b\d+(\.\d+)?\s?v\b/i, "power"],
  [/\b(thermal|heat|temperature rise|cool(ing)?|fan|heatsink|hot ?spot|junction temperature)\b/i, "thermal"],
  [/\b(cost|price|budget|bom cost|usd|eur)\b|\$\s?\d/i, "cost"],
  [/\b(manufactur\w*|assembl\w*|dfm|tooling|mold|mould|yield|pcba|fabricat\w*|production line|test fixture|jig)\b/i, "manufacturing"],
  [/\b(esd|emc|emi|erc|drc|impedance|noise|ripple|jitter|oscillator|crystal|tcxo|ppm|frequency stability|clock accuracy|adc|dac|gpio|trace|layers?|schematic|resistor|capacitor|mcu|processor|soc|ram|flash|emmc)\b/i, "electrical"],
  [/\b(usb|uart|spi|i2c|i²c|can bus|ethernet|hdmi|sdi|bluetooth|ble|wi-?fi|wlan|lora|nfc|gps|gnss|connectors?|ports?|interfaces?|protocol|api|ltc|smpte|genlock|sd card|microsd|antenna|xlr|jack|dbu)\b/i, "interface"],
  [/\b(enclosure|housing|bezel|case|weight|dimensions?|size|thickness|mount\w*|screws?|bracket|buttons?|knob|material|finish|colou?r|grip|strap|hinge|outline|height|mm|grams?|kg)\b/i, "mechanical"],
];
export function classifyRequirement(text: string): RequirementKind {
  return KINDS.find(([re]) => re.test(text))?.[1] ?? "functional";
}

/** Sentences of a block, each exactly as written (so it can be cited). */
function sentences(text: string): string[] {
  return text.split(/(?<=[.;!?])\s+(?=[A-Z(“"'])|\n+/).map((s) => s.trim()).filter((s) => s.length > 0);
}

/** One rule requirement from a sentence, or "ai" when it needs judgment, or null when it is not a requirement. */
function readSentence(s: string, blockId: string): RuleRequirement | "ai" | null {
  const modals = [...s.matchAll(MODAL)].map((m) => m[1]!.toLowerCase());
  // Specifications are often written as direction ("Sensor | Hall effect, debounced") rather than "shall": anything
  // without a modal verb is read by the model, never skipped by guesswork.
  if (!modals.length) return "ai";
  if (modals.length > 1) return "ai";                                         // "shall X and shall Y"
  const m = modals[0]!;
  if (m === "may") return "ai";                                                // options and permissions need reading
  const after = s.slice(s.toLowerCase().search(new RegExp(`\\b${m}\\b`)) + m.length);
  if (/,\s*and\b|;\s|\band\s+(also|then)\b|\bor\b.*\bor\b/i.test(after)) return "ai";     // a list of obligations
  if (s.length > 320 || s.length < 18) return "ai";
  const priority = m === "should" ? "should" : "must";
  const open = OPEN.exec(s)?.[0], vague = VAGUE.exec(s)?.[0];
  const ambiguity = open ? `A value is still open (${open}).` : vague ? `"${vague}" has no measurable criterion.` : null;
  const UNIT = String.raw`(?:%|°\s?C|ppm|dBu|dB|mV|V|mA|µA|uA|A|mW|W|mAh|Wh|h|hrs?|hours?|min|ms|s|MHz|GHz|kHz|Hz|mm|cm|m|kg|g|fps|frames?|kΩ|MΩ|Ω|ohms?|lux|nits?|bits?|GB|MB|positions?|pins?|layers?)`;
  const figures = [...s.matchAll(new RegExp(String.raw`[≥≤<>±+-]?\s?\d[\d.]*\s*${UNIT}(?![A-Za-z])(?:\s*(?:to|-|–)\s*[+-]?\d[\d.]*\s*${UNIT}(?![A-Za-z]))?`, "g"))]
    .map((m) => m[0].trim());
  return {
    statement: s.replace(/^[-•*\d.)\s]+(?=[A-Z])/, "").trim(),
    kind: classifyRequirement(s),
    priority,
    blockId,
    excerpt: s,
    acceptanceCriteria: figures.length ? `Measured or inspected value meets the stated figure(s): ${[...new Set(figures)].slice(0, 4).join(", ")}.` : null,
    ambiguity,
  };
}

export interface RuleExtraction {
  requirements: RuleRequirement[];
  /** Blocks the model must read (each read whole, so a block is never split between rules and AI). */
  aiBlocks: string[];
  /** Blocks skipped as not requirements (background, informational sections). */
  skipped: number;
}

export function ruleExtract(doc: ParsedDocument, opts: { reused?: Set<string> } = {}): RuleExtraction {
  const requirements: RuleRequirement[] = [];
  const aiBlocks: string[] = [];
  let skipped = 0;
  const info = (s: Section) => [...s.path, s.title].some((t) => INFORMATIONAL.test(t.replace(/^\d+(\.\d+)*\.?\s*/, "")));
  for (const section of doc.sections) {
    if (info(section)) { skipped += section.blocks.length; continue; }
    for (const block of section.blocks as Block[]) {
      if (opts.reused?.has(block.id)) continue;
      // A parameter/value table row with a figure is a requirement in table form: the model reads it.
      if (block.kind === "table_row" && /\d/.test(block.text)) { aiBlocks.push(block.id); continue; }
      const read = sentences(block.text).map((s) => readSentence(s, block.id));
      if (read.some((r) => r === "ai")) { aiBlocks.push(block.id); continue; }
      const found = read.filter((r): r is RuleRequirement => !!r && r !== "ai");
      if (!found.length) { skipped++; continue; }
      requirements.push(...found);
    }
  }
  return { requirements, aiBlocks, skipped };
}

/** The document cut down to the given blocks, keeping every heading for context. */
export function subsetDocument(doc: ParsedDocument, blockIds: Set<string>): ParsedDocument {
  return { ...doc, sections: doc.sections.map((s) => ({ ...s, blocks: s.blocks.filter((b) => blockIds.has(b.id)) })) };
}
