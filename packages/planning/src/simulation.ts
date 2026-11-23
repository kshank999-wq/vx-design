/**
 * Simulation and calculation tasks (holdover drift, an analog interface, a filter, a battery runtime). The model writes
 * the analysis as named quantities, each an expression over inputs it states with their source, plus checks against
 * the requirements; when a circuit matters it also writes a self-contained ngspice deck whose .meas results feed the
 * checks. Every number is then computed here (and by ngspice), not taken from the model: expressions that do not
 * evaluate and decks that do not run go back to the model; checks that evaluate false are reported as results.
 */
import { z } from "zod";
import { ProgressTracker } from "./progress.ts";
import type { LanguageModel, Usage } from "./llm/model.ts";
import type { BriefAcceptanceTest, BriefRequirement, BriefUpstream } from "./brief.ts";
import { evaluate, evaluateAll } from "./calc.ts";

export const SIMULATION_PROMPT_VERSION = "simulation-v2";
export const MAX_SIMULATION_REPAIRS = 2;

export const SimulationOutput = z.object({
  title: z.string(),
  summary: z.string().describe("What was analysed and the outcome, 2-4 sentences."),
  approach: z.string().describe("Method: the model of the circuit or effect, the formulas used and why they apply."),
  quantities: z.array(z.object({
    name: z.string().describe("Identifier: letters, digits and _ only, e.g. tcxo_ppm, holdover_s, drift_ms"),
    expression: z.string().describe("A number, or an expression over earlier names, e.g. 'tcxo_ppm * 1e-6 * holdover_s * 1000'. Operators + - * / ^ ( ); functions sqrt abs min max pow exp ln log10; constants pi e. Spice results are available as spice_<meas name>."),
    unit: z.string(),
    meaning: z.string(),
    source: z.string().describe("Where an input value comes from: a requirement ref, a datasheet (part and parameter), an upstream task, or 'assumption: why'. For computed values: 'computed'."),
  })),
  spice: z.object({
    purpose: z.string(),
    deck: z.string().describe("Self-contained ngspice netlist: elements, .model/.subckt written inline, one analysis (.tran/.ac/.dc/.op), and .meas statements for every result used. No .control blocks, no .include or .lib files."),
  }).nullable(),
  checks: z.array(z.object({
    id: z.string().describe("C1, C2, ..."),
    description: z.string(),
    expression: z.string().describe("A comparison over quantity names, e.g. 'drift_ms <= 0.5'"),
    requirement_ref: z.string().nullable(),
    role: z.enum(["requirement", "stretch", "scenario"]).describe(
      "requirement: the design must meet this (a must requirement or acceptance criterion). stretch: a should/stretch target, reported but not blocking. " +
      "scenario: an information-only comparison of an alternative or baseline the design does not rely on (e.g. 'oscillator alone, uncompensated'), shown for context."),
  })),
  findings: z.array(z.string()).describe("Design consequences: what downstream tasks must use or change (values, parts, margins)."),
  assumptions: z.array(z.string()),
  open_questions: z.array(z.string()),
});
export type SimulationOutput = z.infer<typeof SimulationOutput>;

export interface SimulationInput {
  projectContext: string;
  task: { key: string; title: string; description: string | null };
  requirements: BriefRequirement[];
  acceptanceTests: BriefAcceptanceTest[];
  upstream: BriefUpstream[];
  reviewNotes: string[];
  /** Whether ngspice can run on this worker. */
  spiceAvailable: boolean;
}

export interface SpiceRun { ok: boolean; stage: string; problems: string[]; measures: Record<string, number>; ngspice: string | null }

export interface SimulationResult {
  promptVersion: string;
  output: SimulationOutput;
  values: Record<string, number>;
  checks: { id: string; description: string; expression: string; requirement_ref: string | null; role?: "requirement" | "stretch" | "scenario"; passed: boolean; value: number }[];
  spice: SpiceRun | null;
  rounds: number;
  usage: Usage[];
}

export class SimulationError extends Error {
  readonly problems: string[];
  constructor(problems: string[], rounds: number) {
    super(`the analysis still does not compute after ${rounds} round(s): ${problems.slice(0, 5).join("; ")}`);
    this.problems = problems;
  }
}

const SYSTEM = `You are a senior hardware engineer doing a calculation or simulation task for a product team. Your numbers are recomputed by software, so write them as data:

- quantities: every input as a number with its source (requirement, datasheet, upstream task, or an explicit assumption with the reason), then every derived value as an expression over earlier names. Use SI-consistent units and say them. Do not write results you did not compute through an expression.
- checks: one comparison per acceptance criterion or requirement limit, over quantity names (e.g. 'drift_ms <= 0.5'). A check that fails is a valid result: report it, do not bend the inputs to pass it. Give each a role: "requirement" for what the chosen design must meet (every must requirement and acceptance criterion you check needs one), "stretch" for should/stretch targets, "scenario" for information-only comparisons of alternatives the design does not rely on (a baseline without a technique the design uses, for example). A scenario never replaces the requirement check for the design itself.
- spice: when the behaviour depends on a circuit (filters, level shifting, input protection, timing edges, regulators), write a self-contained ngspice deck with .meas statements and use the results as spice_<name> in quantities and checks. Otherwise null.
- findings: what downstream design tasks must use (component values, part requirements, margins, firmware constants).

Be conservative: use worst-case datasheet values (temperature, ageing, tolerance) where the requirement is a limit.`;

export function renderSimulationPrompt(input: SimulationInput): string {
  const reqs = input.requirements.map((r) => `- ${r.refCode} [${r.kind}, ${r.priority}] ${r.text}`).join("\n") || "- (none linked)";
  const tests = input.acceptanceTests.map((t) => `- ${t.id} (${t.method}): ${t.description}`).join("\n") || "- (none)";
  const upstream = input.upstream.map((u) => `### ${u.title} (${u.taskKey})\n${u.content}`).join("\n\n") || "(no upstream outputs)";
  const notes = input.reviewNotes.length ? `\n\nA reviewer returned the previous analysis with these notes; address them:\n${input.reviewNotes.map((n) => `- ${n}`).join("\n")}` : "";
  return `Project: ${input.projectContext}\n\nTask: ${input.task.title} (${input.task.key})\n${input.task.description ?? ""}\n\n` +
    `Requirements:\n${reqs}\n\nAcceptance tests:\n${tests}\n\nUpstream outputs:\n${upstream}${notes}\n\n` +
    (input.spiceAvailable ? "ngspice is available for circuit simulation." : "No circuit simulator is available here: set spice to null and calculate.") +
    "\n\nDo the analysis.";
}

export type CheckVerdict = "pass" | "fail" | "short_of_stretch" | "scenario";

/**
 * What a check's outcome means for the task. The model's role is honoured only where it cannot hide a failure:
 *  - a "scenario" on a requirement or acceptance test counts as information only when another check on the same one is
 *    a "requirement" (so the design itself is still checked against it); a scenario on none (a what-if) needs at least
 *    one requirement check in the analysis; otherwise it is treated as a requirement;
 *  - a "stretch" check on a must requirement is treated as a requirement.
 */
export function judgeChecks(checks: SimulationResult["checks"], requirements: { refCode: string; priority: string }[]):
    { id: string; role: "requirement" | "stretch" | "scenario"; verdict: CheckVerdict }[] {
  const priority = new Map(requirements.map((r) => [r.refCode, r.priority]));
  const refOf = (c: SimulationResult["checks"][number]) => (c.requirement_ref ?? "").trim();
  const hasRequirementCheck = new Set(checks.filter((c) => (c.role ?? "requirement") === "requirement" && refOf(c)).map(refOf));
  const anyRequirementCheck = checks.some((c) => (c.role ?? "requirement") === "requirement");
  return checks.map((c) => {
    let role = c.role ?? "requirement";
    // A scenario tied to a requirement needs a requirement check on that requirement beside it; one tied to none
    // (a what-if such as another frame rate) is information as long as the analysis checks the design at all.
    if (role === "scenario" && (refOf(c) ? !hasRequirementCheck.has(refOf(c)) : !anyRequirementCheck)) role = "requirement";
    if (role === "stretch" && priority.get(refOf(c)) === "must") role = "requirement";
    const verdict: CheckVerdict = c.passed ? "pass" : role === "requirement" ? "fail" : role === "stretch" ? "short_of_stretch" : "scenario";
    return { id: c.id, role, verdict };
  });
}

/** Problems that make the analysis not compute (sent back to the model); failing checks are not problems. */
function evaluateOutput(o: SimulationOutput, spice: SpiceRun | null): { problems: string[]; values: Record<string, number>; checks: SimulationResult["checks"] } {
  const given = Object.fromEntries(Object.entries(spice?.measures ?? {}).map(([k, v]) => [`spice_${k}`, v]));
  const { values, problems } = evaluateAll(o.quantities, given);
  const checks: SimulationResult["checks"] = [];
  if (!o.checks.length) problems.push("there are no checks: add one comparison per acceptance criterion or requirement limit");
  for (const c of o.checks) {
    try { const v = evaluate(c.expression, values); checks.push({ ...c, value: v, passed: v !== 0 }); }
    catch (e) { problems.push(`check ${c.id} (${c.expression}): ${(e as Error).message}`); }
  }
  return { problems, values, checks };
}

export async function generateSimulation(
  input: SimulationInput, model: LanguageModel,
  runSpice: (deck: string) => Promise<SpiceRun>,
  onRound?: (round: number, problems: string[], usage: Usage) => Promise<void>,
): Promise<SimulationResult> {
  const usage: Usage[] = [];
  const messages: Parameters<LanguageModel["generate"]>[0]["messages"] = [{ role: "user", content: renderSimulationPrompt(input) }];
  const progress = new ProgressTracker();
  for (let round = 1; ; round++) {
    const r = await model.generate({ purpose: round === 1 ? "simulation" : "simulation_repair", system: SYSTEM, messages, schema: SimulationOutput, cache: "follow-up" });
    usage.push(r.usage);
    let spice: SpiceRun | null = null;
    const problems: string[] = [];
    if (r.output.spice) {
      if (!input.spiceAvailable) problems.push("no simulator is available: set spice to null and calculate instead");
      else {
        spice = await runSpice(r.output.spice.deck);
        if (!spice.ok) problems.push(...spice.problems.map((p) => `ngspice: ${p}`));
      }
    }
    const ev = evaluateOutput(r.output, spice);
    problems.push(...ev.problems);
    await onRound?.(round, problems, r.usage);
    if (!problems.length) {
      return { promptVersion: SIMULATION_PROMPT_VERSION, output: r.output, values: ev.values, checks: ev.checks, spice, rounds: round, usage };
    }
    const stall = progress.check(r.output, problems);
    if (stall) throw new SimulationError([...problems, stall], round);
    if (round > MAX_SIMULATION_REPAIRS) throw new SimulationError(problems, round);
    messages.push(r.assistantMessage, { role: "user", content: `The analysis does not compute yet:\n${problems.map((p) => `- ${p}`).join("\n")}\n\nReturn the complete corrected analysis.` });
  }
}

const fmt = (v: number) => (Math.abs(v) >= 1e5 || (Math.abs(v) < 1e-3 && v !== 0) ? v.toExponential(4) : Number(v.toPrecision(6)).toString());

export function renderSimulationMarkdown(r: SimulationResult): string {
  const o = r.output;
  const rows = o.quantities.map((q) => `| ${q.name} | ${q.expression.replace(/\|/g, "\\|")} | ${q.name in r.values ? fmt(r.values[q.name]!) : "—"} | ${q.unit} | ${q.meaning} | ${q.source} |`);
  return [
    `# ${o.title}`, "", o.summary, "", "## Approach", "", o.approach, "",
    "## Quantities (computed by VX Design, not by the model)", "", "| Name | Expression | Value | Unit | Meaning | Source |", "|---|---|---|---|---|---|", ...rows, "",
    "## Checks", "", ...r.checks.map((c) => `- **${c.id} ${c.passed ? "PASS" : c.role === "scenario" ? "does not hold (scenario, for information)" : c.role === "stretch" ? "short of stretch target" : "FAIL"}**: ${c.description} (\`${c.expression}\`)${c.requirement_ref ? ` · ${c.requirement_ref}` : ""}${c.role && c.role !== "requirement" ? ` · ${c.role}` : ""}`), "",
    ...(r.spice ? ["## Circuit simulation (ngspice " + (r.spice.ngspice ?? "") + ")", "", o.spice!.purpose, "", "```spice", o.spice!.deck, "```", "",
                   ...Object.entries(r.spice.measures).map(([k, v]) => `- ${k} = ${fmt(v)}`), ""] : []),
    "## Findings for downstream tasks", "", ...o.findings.map((f) => `- ${f}`), "",
    ...(o.assumptions.length ? ["## Assumptions", "", ...o.assumptions.map((a) => `- ${a}`), ""] : []),
    ...(o.open_questions.length ? ["## Open questions", "", ...o.open_questions.map((q) => `- ${q}`), ""] : []),
  ].join("\n");
}

/** Offline stand-in: an RC time constant, labelled as a fixture. */
export const OFFLINE_SIMULATION: SimulationOutput = {
  title: "Offline stand-in: RC time constant (fixture, not from your requirements)",
  summary: "Offline stand-in fixture: computes an RC time constant and checks it against a limit.",
  approach: "tau = R * C.",
  quantities: [
    { name: "r_ohm", expression: "1000", unit: "Ω", meaning: "resistor", source: "assumption: fixture" },
    { name: "c_f", expression: "1e-6", unit: "F", meaning: "capacitor", source: "assumption: fixture" },
    { name: "tau_ms", expression: "r_ohm * c_f * 1000", unit: "ms", meaning: "time constant", source: "computed" },
  ],
  spice: null,
  checks: [{ id: "C1", description: "time constant under 2 ms", expression: "tau_ms <= 2", requirement_ref: null, role: "requirement" }],
  findings: ["Fixture: no design consequences."], assumptions: ["Offline stand-in."], open_questions: [],
};
