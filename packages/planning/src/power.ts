/**
 * Power tree for power tasks. The model proposes sources, converters, rails, loads and operating modes
 * from the requirements, upstream outputs and any circuit design; the deterministic calculator in
 * @vx/power checks every rating, headroom, temperature and limit. Errors go back to the model with the
 * calculated numbers until the tree is clean or the repair budget is spent. Warnings are kept for review.
 */
import { calculate, PowerTree, type PowerReport } from "@vx/power";
import type { LanguageModel, Usage } from "./llm/model.ts";
import type { BriefAcceptanceTest, BriefRequirement, BriefUpstream } from "./brief.ts";
import type { CircuitDesign } from "./circuit.ts";

export const POWER_PROMPT_VERSION = "power-v1";
export const MAX_POWER_REPAIRS = 3;

export interface PowerInput {
  projectContext: string;
  task: { key: string; title: string; description: string | null };
  requirements: BriefRequirement[];
  acceptanceTests: BriefAcceptanceTest[];
  upstream: BriefUpstream[];
  reviewNotes: string[];
  circuit: CircuitDesign | null;
}

export class PowerTreeError extends Error {
  readonly problems: string[];
  readonly rounds: number;
  constructor(problems: string[], rounds: number) {
    super(`power tree still has ${problems.length} error(s) after ${rounds} round(s): ${problems.slice(0, 5).join("; ")}`);
    this.problems = problems;
    this.rounds = rounds;
  }
}

export interface PowerResult {
  promptVersion: string;
  tree: PowerTree;
  report: PowerReport;
  rounds: number;
  history: { round: number; errors: number; warnings: number }[];
  usage: Usage[];
}

const SYSTEM = `You are a senior power electronics engineer writing the power tree for a product: where power comes from, how it is converted, and what every rail feeds.

Describe it exactly in the schema:
- sources: every input (battery pack, USB, DC jack). Give the real voltage range at the terminals (battery cut-off to full charge; USB 4.75-5.25 V), the current the source can deliver, and for batteries the chemistry, cell arrangement, capacity and usable fraction.
- converters: every regulator or load switch, its kind, the rail it takes and the rail it makes, and the datasheet numbers that matter: rated input range, maximum output current, quiescent current, LDO dropout at full load, switcher efficiency at the expected load, package theta-JA on a small board, Tj(max), soft-start time. Use a real part number where one is chosen.
- rails: every converter output, with its total capacitance where known.
- loads: every consumer with its average current in each operating mode and its short peak (radio bursts, backlight, motors).
- modes: the operating modes (active, standby, sleep, charging ...) with typical hours per day.
- sequencing: rails that must be up before others, and enable_after on the converter that enforces it.

Every source, converter and load has a basis: datasheet (part number and the stated value), requirement (ref code), measurement, calculation or assumption (say why). Do not invent datasheet values: if a value is not known, mark it as an assumption and list it in assumptions or open_questions.

A deterministic calculator checks the tree at the minimum, nominal and maximum source voltage: converter current ratings, LDO dropout, buck/boost headroom, input ranges, junction temperatures, source and battery limits, inrush and sequencing. Design so it passes: an LDO cannot make 3.3 V from a Li-ion cell at 3.0 V; a buck cannot make an output above its input; keep converters under 80% of rating and junctions 25 C below their limit.`;

function render(input: PowerInput): string {
  const reqs = input.requirements.map((r) => `- ${r.refCode} [${r.kind}, ${r.priority}] ${r.text}`).join("\n") || "- (none linked)";
  const tests = input.acceptanceTests.map((t) => `- ${t.id} (${t.method}): ${t.description}`).join("\n") || "- (none)";
  const upstream = input.upstream.map((u) => `### ${u.title} (${u.taskKey})\n${u.content}`).join("\n\n") || "(no text outputs)";
  const circuit = input.circuit
    ? `\n\nCircuit design (${input.circuit.title}):\n${input.circuit.components.map((c) =>
        `- ${c.ref} ${c.value} ${c.mpn ?? ""} — ${c.purpose}${c.claims.length ? ` [datasheet: ${c.claims.map((x) => `${x.parameter} ${x.value}`).join(", ")}]` : ""}`).join("\n")}\n` +
      `Nets: ${input.circuit.nets.map((n) => n.name).join(", ")}` : "";
  const notes = input.reviewNotes.length
    ? `\n\nA reviewer returned the previous power tree with these notes; address them:\n${input.reviewNotes.map((n) => `- ${n}`).join("\n")}` : "";
  return `Project: ${input.projectContext}\n\nTask: ${input.task.title} (${input.task.key})\n${input.task.description ?? ""}\n\n` +
    `Requirements:\n${reqs}\n\nAcceptance tests:\n${tests}\n\nUpstream outputs:\n${upstream}${circuit}${notes}\n\nWrite the power tree.`;
}

export function renderPowerPrompt(input: PowerInput): string { return render(input); }

export function powerFeedback(report: PowerReport): string {
  const errors = report.findings.filter((f) => f.severity === "error");
  const warnings = report.findings.filter((f) => f.severity === "warning");
  return `The calculator found ${errors.length} error(s):\n${errors.map((f) => `- ${f.subject}: ${f.message}`).join("\n")}` +
    (warnings.length ? `\n\nWarnings (fix if they matter):\n${warnings.map((f) => `- ${f.subject}: ${f.message}`).join("\n")}` : "") +
    "\n\nReturn the complete corrected power tree.";
}

export async function generatePowerTree(input: PowerInput, model: LanguageModel,
                                        onRound?: (round: number, report: PowerReport, usage: Usage) => Promise<void>): Promise<PowerResult> {
  const usage: Usage[] = [];
  const history: PowerResult["history"] = [];
  const messages: Parameters<LanguageModel["generate"]>[0]["messages"] = [{ role: "user", content: render(input) }];
  for (let round = 1; ; round++) {
    const r = await model.generate({ purpose: round === 1 ? "power_tree" : "power_tree_repair", system: SYSTEM, messages, schema: PowerTree, cache: "follow-up" });
    usage.push(r.usage);
    const report = calculate(r.output);
    history.push({ round, errors: report.counts.errors, warnings: report.counts.warnings });
    await onRound?.(round, report, r.usage);
    if (report.ok) return { promptVersion: POWER_PROMPT_VERSION, tree: r.output, report, rounds: round, history, usage };
    if (round > MAX_POWER_REPAIRS) {
      throw new PowerTreeError(report.findings.filter((f) => f.severity === "error").map((f) => `${f.subject}: ${f.message}`), round);
    }
    messages.push(r.assistantMessage, { role: "user", content: powerFeedback(report) });
  }
}

const A = (ref: string) => ({ kind: "assumption" as const, ref: `Offline stand-in: ${ref}` });

/**
 * Fixture used by the offline stand-in: a 1S Li-ion timecode board with a buck-boost 3.3 V rail.
 * Not derived from the project's requirements; every value is a labelled assumption.
 */
export const OFFLINE_FIXTURE_POWER: PowerTree = {
  name: "offline_fixture_power",
  title: "Offline stand-in: 1S Li-ion to 3.3 V power tree (fixture, not from your requirements)",
  summary: "Offline stand-in fixture. A fixed example tree, not derived from the project's requirements; all numbers are assumptions.",
  ambient_c: { nominal: 25, max: 45 },
  sources: [{
    id: "VBAT", kind: "battery", label: "1S Li-ion pack", voltage: { min: 3.0, nom: 3.7, max: 4.2 }, max_current_a: 2,
    battery: { chemistry: "li_ion", cells_series: 1, cells_parallel: 1, capacity_mah: 2000, usable_fraction: 0.8 },
    basis: A("typical 2000 mAh 18650-class cell"),
  }],
  converters: [{
    id: "U1", label: "3.3 V buck-boost", kind: "buck_boost", mpn: null, input: "VBAT", output_rail: "+3V3", vout: 3.3,
    vin_range: { min: 1.8, max: 5.5 }, max_output_a: 1, efficiency: 0.9, quiescent_a: 30e-6, dropout_v: null, ron_ohm: null,
    theta_ja_c_per_w: 60, tj_max_c: 125, enable_after: null, soft_start_ms: 1, basis: A("generic 1 A buck-boost class values"),
  }],
  rails: [{ id: "+3V3", label: "3.3 V system", capacitance_uf: 47 }],
  loads: [
    { id: "MCU", label: "Microcontroller", rail: "+3V3", current_a: { active: 0.03, standby: 0.002 }, peak_a: 0.06, basis: A("small MCU") },
    { id: "TCXO", label: "Timecode reference oscillator", rail: "+3V3", current_a: { active: 0.002, standby: 0.002 }, peak_a: null, basis: A("TCXO") },
    { id: "LED", label: "Power LED", rail: "+3V3", current_a: { active: 0.0013, standby: 0 }, peak_a: null, basis: A("(3.3 V - 2 V) / 1 kOhm") },
  ],
  modes: [{ id: "active", label: "Active (on set)", hours_per_day: 12 }, { id: "standby", label: "Standby", hours_per_day: 12 }],
  sequencing: [],
  assumptions: ["Offline stand-in: no power analysis was reasoned about."],
  open_questions: [],
};
