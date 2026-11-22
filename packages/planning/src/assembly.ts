/**
 * Assembly instructions (work instructions) for the finished product: how the circuit boards, bought parts (display,
 * battery, modules) and made parts (enclosure, bezel, buttons) go together, step by step, with fasteners, torques,
 * tools, cautions and an inspection check per step. Drafted by the model from what the project already knows; checked
 * (every part is fitted somewhere, figures are real files, fasteners have a torque or say why not) and repaired; then
 * edited and approved by people.
 */
import { z } from "zod";
import { ProgressTracker } from "./progress.ts";
import type { LanguageModel, Usage } from "./llm/model.ts";

export const ASSEMBLY_PROMPT_VERSION = "assembly-v1";
export const MAX_ASSEMBLY_REPAIRS = 2;

export const AssemblyStep = z.object({
  title: z.string().describe("Imperative, short: 'Fit the display into the front bezel'"),
  parts: z.array(z.object({ name: z.string().describe("Exactly as listed in the inputs (made part name or bought part number), or a fastener/consumable"), qty: z.number() })),
  fasteners: z.array(z.object({ spec: z.string().describe("e.g. 'M2.5 × 6 pan head, thread-forming for plastics'"), qty: z.number(),
    torque_nm: z.number().nullable().describe("Tightening torque in N·m, or null for heat-set inserts, clips and press fits"),
    torque_note: z.string().nullable().describe("Why no torque, or the basis of the torque (e.g. 'insert maker's figure; confirm on the first build')") })),
  tools: z.array(z.string()),
  instructions: z.array(z.string()).describe("One action per line, in order"),
  cautions: z.array(z.string()).describe("ESD, battery handling, cable routing, cosmetic surfaces, things that break"),
  check: z.string().nullable().describe("What the operator checks before the next step"),
  figure: z.string().nullable().describe("A REF-n code from the figures list that shows this step, or null"),
  minutes: z.number().describe("Estimated time for one unit"),
});
export type AssemblyStep = z.infer<typeof AssemblyStep>;

export const AssemblyDraft = z.object({
  title: z.string(),
  safety: z.array(z.string()).describe("General precautions for the whole build"),
  tools: z.array(z.string()).describe("Every tool and fixture the build needs"),
  steps: z.array(AssemblyStep),
  final_test: z.array(z.string()).describe("The functional check after assembly"),
  assumptions: z.array(z.string()),
  open_questions: z.array(z.string()),
});
export type AssemblyDraft = z.infer<typeof AssemblyDraft>;

export interface AssemblyInput {
  project: { name: string; description?: string | null };
  /** Made parts (manufacturing routes): name and how it is made. */
  made: { name: string; route: string }[];
  /** Bought parts already chosen. */
  bought: { mpn: string; manufacturer: string | null; role: string; subsystem: string }[];
  /** Circuit boards to fit (from layout tasks or Flux imports). */
  boards: { name: string; detail: string }[];
  /** The generated enclosure's design (process, fastening, standoffs), when there is one. */
  enclosure: string | null;
  requirements: { refCode: string; text: string }[];
  figures: { code: string; title: string; note: string | null }[];
  guidance: string | null;
}

const SYSTEM = `You are a manufacturing engineer writing assembly work instructions for the final assembly (box build) of an electronic product, for an assembler who has never seen it.

Write the steps in the order a person builds one unit on a bench: prepare made parts (inserts, gaskets, labels), sub-assemblies (display into bezel, battery into holder), boards into the housing, cables and connectors, closing, then the final functional test. One step is one sub-assembly or one operation a person can check.

For every fastener give the size and type and a tightening torque in N·m suited to the screw and the material it goes into (thread-forming screws into plastic bosses or heat-set inserts need low torques); say the basis of the figure and that it is confirmed on the first build. Heat-set inserts, clips and press fits have no torque: say so.

Name every part exactly as the inputs list it (the made part's name or the bought part's number); every made part, bought part and board must be fitted in some step. Add the cautions an assembler needs: ESD handling for boards, lithium battery handling, connector orientation and latches, cable routing away from screws and hinges, protecting cosmetic and display surfaces. Give each step one check the operator makes before moving on. Use a figure only from the figures list, by its REF code.

Do not invent parts that are not in the inputs, except fasteners, inserts, adhesives, labels and consumables, which you may add and must list. Record assumptions and open questions (things the designer must confirm).`;

export function renderAssemblyPrompt(i: AssemblyInput): string {
  const L = [`Project: ${i.project.name}${i.project.description ? ` — ${i.project.description}` : ""}`, ""];
  L.push("Made parts (fit each):", ...(i.made.length ? i.made.map((m) => `- [made] ${m.name}: ${m.route}`) : ["- (none recorded)"]), "");
  L.push("Bought parts (fit each):", ...(i.bought.length ? i.bought.map((b) => `- [bought] ${b.mpn}${b.manufacturer ? ` (${b.manufacturer})` : ""}: ${b.role} [${b.subsystem}]`) : ["- (none recorded)"]), "");
  L.push("Circuit boards (fit each):", ...(i.boards.length ? i.boards.map((b) => `- [board] ${b.name}: ${b.detail}`) : ["- (none recorded)"]), "");
  if (i.enclosure) L.push("Enclosure design:", i.enclosure, "");
  if (i.requirements.length) L.push("Requirements that affect assembly:", ...i.requirements.map((r) => `- ${r.refCode}: ${r.text}`), "");
  L.push("Figures you may cite:", ...(i.figures.length ? i.figures.map((f) => `- ${f.code}: ${f.title}${f.note ? ` (${f.note})` : ""}`) : ["- (none)"]), "");
  if (i.guidance) L.push(`From the engineer: ${i.guidance}`, "");
  L.push("Write the assembly instructions.");
  return L.join("\n");
}

const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Problems that send the draft back: parts never fitted, unknown figures, fasteners without torque or reason, empty steps. */
export function checkAssembly(d: AssemblyDraft, i: AssemblyInput): string[] {
  const problems: string[] = [];
  const used = new Set(d.steps.flatMap((s) => s.parts.map((p) => norm(p.name))));
  const named = (n: string) => used.has(norm(n)) || d.steps.some((s) => s.parts.some((p) => norm(p.name).includes(norm(n)) || norm(n).includes(norm(p.name)) && norm(p.name).length >= 4));
  const missing = [...i.made.map((m) => m.name), ...i.bought.map((b) => b.mpn), ...i.boards.map((b) => b.name)].filter((n) => !named(n));
  if (missing.length) problems.push(`not fitted in any step (name each exactly as listed): ${missing.join("; ")}`);
  const codes = new Set(i.figures.map((f) => f.code));
  d.steps.forEach((s, k) => {
    if (s.figure && !codes.has(s.figure)) problems.push(`step ${k + 1} cites figure ${s.figure}, which is not in the figures list`);
    if (!s.instructions.length) problems.push(`step ${k + 1} "${s.title}" has no instructions`);
    for (const f of s.fasteners) if (f.torque_nm == null && !f.torque_note) problems.push(`step ${k + 1}: ${f.spec} has no torque and no reason for none`);
  });
  if (!d.steps.length) problems.push("no steps");
  return problems;
}

export async function generateAssembly(i: AssemblyInput, model: LanguageModel):
    Promise<{ promptVersion: string; draft: AssemblyDraft; rounds: number; remaining: string[]; usage: Usage[] }> {
  const usage: Usage[] = [];
  const messages: Parameters<LanguageModel["generate"]>[0]["messages"] = [{ role: "user", content: renderAssemblyPrompt(i) }];
  const progress = new ProgressTracker();
  for (let round = 1; ; round++) {
    const r = await model.generate({ purpose: round === 1 ? "assembly_instructions" : "assembly_instructions_repair", system: SYSTEM, messages, schema: AssemblyDraft, effort: "medium" });
    usage.push(r.usage);
    const problems = checkAssembly(r.output, i);
    if (!problems.length || round > MAX_ASSEMBLY_REPAIRS || progress.check(r.output, problems)) return { promptVersion: ASSEMBLY_PROMPT_VERSION, draft: r.output, rounds: round, remaining: problems, usage };
    messages.push(r.assistantMessage, { role: "user", content: `Fix these problems and return the complete instructions:\n${problems.map((p) => `- ${p}`).join("\n")}` });
  }
}

/** Offline stand-in (not AI): a generic box-build sequence over the listed parts. */
export function offlineAssembly(prompt: string): AssemblyDraft {
  const grab = (tag: string) => [...prompt.matchAll(new RegExp(`^- \\[${tag}\\] (.+?)(?: \\(|:)`, "gm"))].map((m) => m[1]!.trim());
  const made = grab("made"), bought = grab("bought"), boards = grab("board");
  const figure = /^- (REF-\d+):/m.exec(prompt)?.[1] ?? null;
  const housing = made.filter((m) => /base|housing|enclosure|back/i.test(m));
  const covers = made.filter((m) => !housing.includes(m));
  const step = (title: string, parts: string[], extra: Partial<AssemblyStep> = {}): AssemblyStep => ({
    title, parts: parts.map((name) => ({ name, qty: 1 })), fasteners: [], tools: [], instructions: [`${title}.`], cautions: [], check: null, figure: null, minutes: 5, ...extra });
  const steps: AssemblyStep[] = [];
  if (housing.length) steps.push(step("Prepare the housing: press heat-set inserts into the bosses", housing, {
    fasteners: [{ spec: "M3 heat-set insert", qty: 4, torque_nm: null, torque_note: "pressed in with a soldering iron; no torque" }], tools: ["Soldering iron with insert tip"],
    instructions: ["Heat the insert tip to the insert maker's temperature.", "Press each insert square into its boss until flush."], check: "Inserts flush and square; no plastic bulging.", figure }));
  for (const b of bought) steps.push(step(`Fit ${b}`, [b], { cautions: ["Handle by the edges."], check: `${b} seated and its connector latched.` }));
  for (const b of boards) steps.push(step(`Mount ${b} on the standoffs`, [b], {
    fasteners: [{ spec: "M3 × 6 pan head", qty: 4, torque_nm: 0.4, torque_note: "typical for M3 into brass inserts in plastic; confirm on the first build" }],
    tools: ["ESD wrist strap", "Torque screwdriver"], cautions: ["ESD: wear a grounded wrist strap."], check: "Board does not rock; no cable under the board." }));
  if (covers.length) steps.push(step("Close the housing", covers, {
    fasteners: [{ spec: "M3 × 8 pan head", qty: 4, torque_nm: 0.4, torque_note: "as above" }], tools: ["Torque screwdriver"], check: "Even gap all round; no pinched cables." }));
  if (!steps.length) steps.push(step("Assemble the unit", []));
  return { title: "Assembly instructions (offline stand-in)", safety: ["Offline stand-in: no assembly reasoning was performed."], tools: [...new Set(steps.flatMap((s) => s.tools))],
    steps, final_test: ["Power on and check the unit starts."], assumptions: ["Offline stand-in (not AI): a generic sequence over the listed parts."], open_questions: [] };
}

/** Steps as plain lines for editing: "2 × Front bezel"; "4 × M3 × 6 pan head @ 0.4 N·m (basis)"; "4 × M3 insert @ none (pressed in)". */
export const partsToLines = (s: AssemblyStep) => s.parts.map((p) => `${p.qty} × ${p.name}`).join("\n");
export const fastenersToLines = (s: AssemblyStep) => s.fasteners.map((f) =>
  `${f.qty} × ${f.spec} @ ${f.torque_nm != null ? `${f.torque_nm} N·m` : "none"}${f.torque_note ? ` (${f.torque_note})` : ""}`).join("\n");

const lines = (t: string) => t.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
const qtyLine = (l: string) => { const m = /^(\d+(?:\.\d+)?)\s*[×x*]\s*(.+)$/i.exec(l); return m ? { qty: Number(m[1]), rest: m[2]!.trim() } : { qty: 1, rest: l }; };

export function linesToParts(t: string): AssemblyStep["parts"] {
  return lines(t).map((l) => { const q = qtyLine(l); return { name: q.rest, qty: q.qty }; });
}
export function linesToFasteners(t: string): AssemblyStep["fasteners"] {
  return lines(t).map((l) => {
    const q = qtyLine(l);
    const m = /^(.*?)\s*@\s*(none|[\d.]+\s*N·?m)\s*(?:\((.*)\))?\s*$/i.exec(q.rest);
    if (!m) return { spec: q.rest, qty: q.qty, torque_nm: null, torque_note: null };
    const torque = /none/i.test(m[2]!) ? null : Number.parseFloat(m[2]!);
    return { spec: m[1]!.trim(), qty: q.qty, torque_nm: torque, torque_note: m[3]?.trim() || null };
  });
}
export const textLines = lines;
