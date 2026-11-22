/**
 * Circuit design for schematic tasks. The model proposes components (KiCad library symbol +
 * footprint + sourcing data) and nets; the engineering worker checks the design against the
 * installed KiCad libraries and runs ERC on the generated schematic. Problems go back to the
 * model with the exact library facts (pin lists, close matches) until the design is clean or
 * the repair budget is spent.
 */
import { z } from "zod";
import type { LanguageModel, Usage } from "./llm/model.ts";
import type { BriefAcceptanceTest, BriefRequirement, BriefUpstream } from "./brief.ts";

export const CIRCUIT_PROMPT_VERSION = "circuit-v1";
export const MAX_CIRCUIT_REPAIRS = 3;

export const CircuitDesign = z.object({
  name: z.string().describe("Short snake_case project name, e.g. timecode_frontend"),
  title: z.string(),
  summary: z.string().describe("What the circuit does and the main design choices, 2-4 sentences."),
  components: z.array(z.object({
    ref: z.string().describe("Reference designator: R1, C3, U2, J1, D1, Y1 ..."),
    symbol: z.string().describe("KiCad library symbol 'Library:Name' from the official KiCad 10 libraries"),
    value: z.string(),
    footprint: z.string().describe("KiCad footprint 'Library:Name' from the official KiCad 10 libraries"),
    mpn: z.string().nullable().describe("Manufacturer part number to buy, or null for generic passives"),
    manufacturer: z.string().nullable(),
    datasheet: z.string().nullable().describe("Manufacturer datasheet URL, or null"),
    purpose: z.string(),
    claims: z.array(z.object({
      parameter: z.string(),
      value: z.string().describe("As written in the datasheet, e.g. '600mA', '250mV', '-40 to 85'"),
    })).describe("Datasheet ratings this design relies on; each is checked against the datasheet text"),
  })),
  nets: z.array(z.object({
    name: z.string().describe("Net name, e.g. GND, +3V3, LTC_OUT"),
    pins: z.array(z.string()).describe("Pins as REF.NUMBER using the symbol's pin numbers, e.g. U1.5"),
    driven_externally: z.boolean().describe("True for supply nets fed from outside the circuit (connector, battery)"),
  })),
  no_connect: z.array(z.string()).describe("Pins deliberately left unconnected, REF.NUMBER"),
  assumptions: z.array(z.string()),
  open_questions: z.array(z.string()),
});
export type CircuitDesign = z.infer<typeof CircuitDesign>;

export interface CircuitInput {
  projectContext: string;
  task: { key: string; title: string; description: string | null };
  requirements: BriefRequirement[];
  acceptanceTests: BriefAcceptanceTest[];
  upstream: BriefUpstream[];
  reviewNotes: string[];
}

/** Result of checking a design with the KiCad libraries and ERC (done by the engineering worker). */
export interface CircuitCheck {
  ok: boolean;
  /** Each problem the model must fix, with library facts and suggestions inlined. */
  problems: string[];
  warnings: string[];
  stage: "validation" | "erc" | "netlist" | "built";
}

export class CircuitDesignError extends Error {
  readonly problems: string[];
  readonly rounds: number;
  constructor(problems: string[], rounds: number) {
    super(`circuit design still has ${problems.length} problem(s) after ${rounds} round(s): ${problems.slice(0, 5).join("; ")}`);
    this.problems = problems;
    this.rounds = rounds;
  }
}

export interface CircuitResult {
  promptVersion: string;
  design: CircuitDesign;
  rounds: number;
  check: CircuitCheck;
  history: { round: number; stage: string; problems: number }[];
  usage: Usage[];
}

const SYSTEM = `You are a senior electronics engineer designing a small, manufacturable circuit (a sub-board) as a KiCad schematic.

Use only symbols and footprints from the official KiCad 10 libraries, written exactly as 'Library:Name' (for example Device:R, Device:C, Device:LED, Regulator_Linear:AP2112K-3.3, Connector_Generic:Conn_01x04, Resistor_SMD:R_0603_1608Metric, Package_TO_SOT_SMD:SOT-23-5). Prefer a symbol whose name is the exact part; use generic Device symbols for passives.

Connections:
- Every pin of every component must be in exactly one net or listed in no_connect. Pins are REF.NUMBER using the symbol's pin numbers (not names).
- Do not add power symbols or PWR_FLAGs as components; name the nets (GND, +3V3, ...) and set driven_externally on supply nets that come from a connector, battery or other board.
- Include what a reviewer expects: decoupling capacitors next to ICs, pull-ups, current limiting, protection where the requirements call for it, and a connector for every off-board signal and supply.

Sourcing: give a real manufacturer part number, manufacturer and datasheet URL for every active part and connector. In claims, list the datasheet ratings your design depends on (voltage, current, dropout, temperature range...) with values written as the datasheet writes them; each claim is checked against the datasheet text. Never invent part numbers or ratings; if unsure, say so in open_questions.

Keep the design to the task's scope. Record assumptions and open questions rather than guessing silently.`;

export function renderCircuitPrompt(input: CircuitInput): string {
  const reqs = input.requirements.map((r) => `- ${r.refCode} [${r.kind}, ${r.priority}] ${r.text}`).join("\n") || "- (none linked)";
  const tests = input.acceptanceTests.map((t) => `- ${t.id} (${t.method}): ${t.description}`).join("\n") || "- (none)";
  const upstream = input.upstream.map((u) => `### ${u.title} (${u.taskKey})\n${u.content}`).join("\n\n") || "(no upstream outputs)";
  const notes = input.reviewNotes.length
    ? `\n\nA reviewer returned the previous design with these notes; address them:\n${input.reviewNotes.map((n) => `- ${n}`).join("\n")}` : "";
  return `Project: ${input.projectContext}\n\nTask: ${input.task.title} (${input.task.key})\n${input.task.description ?? ""}\n\n` +
    `Requirements:\n${reqs}\n\nAcceptance tests:\n${tests}\n\nUpstream outputs:\n${upstream}${notes}\n\nDesign the circuit.`;
}

/**
 * Propose a design, check it, and repair until it passes or MAX_CIRCUIT_REPAIRS rounds are spent.
 * `check` validates against the KiCad libraries and, once valid, builds the schematic and runs ERC.
 */
export async function generateCircuit(
  input: CircuitInput,
  model: LanguageModel,
  check: (design: CircuitDesign) => Promise<CircuitCheck>,
  onRound?: (round: number, check: CircuitCheck, usage: Usage) => Promise<void>,
): Promise<CircuitResult> {
  const usage: Usage[] = [];
  const history: CircuitResult["history"] = [];
  const messages: Parameters<LanguageModel["generate"]>[0]["messages"] = [{ role: "user", content: renderCircuitPrompt(input) }];
  for (let round = 1; ; round++) {
    const result = await model.generate({
      purpose: round === 1 ? "circuit_design" : "circuit_design_repair", system: SYSTEM, messages, schema: CircuitDesign, cache: "follow-up",
    });
    usage.push(result.usage);
    const c = await check(result.output);
    history.push({ round, stage: c.stage, problems: c.problems.length });
    await onRound?.(round, c, result.usage);
    if (c.ok) return { promptVersion: CIRCUIT_PROMPT_VERSION, design: result.output, rounds: round, check: c, history, usage };
    if (round > MAX_CIRCUIT_REPAIRS) throw new CircuitDesignError(c.problems, round);
    messages.push(result.assistantMessage, {
      role: "user",
      content: `The design failed at the ${c.stage} stage:\n${c.problems.map((p) => `- ${p}`).join("\n")}` +
        (c.warnings.length ? `\n\nWarnings (fix if they matter):\n${c.warnings.map((w) => `- ${w}`).join("\n")}` : "") +
        "\n\nReturn the complete corrected design.",
    });
  }
}

/**
 * Fixture used by the offline stand-in: a 5 V to 3.3 V LDO with a power LED. It is not derived
 * from the project's requirements and is labelled as such wherever it appears.
 */
export const OFFLINE_FIXTURE_CIRCUIT: CircuitDesign = {
  name: "offline_fixture_ldo_led",
  title: "Offline stand-in: 3.3 V LDO with power LED (fixture, not from your requirements)",
  summary: "Offline stand-in fixture. This circuit is a fixed test design, not derived from the project's requirements.",
  components: [
    { ref: "J1", symbol: "Connector_Generic:Conn_01x02", value: "VIN 5V", footprint: "Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical",
      mpn: null, manufacturer: null, datasheet: null, purpose: "5 V input", claims: [] },
    { ref: "C1", symbol: "Device:C", value: "1uF", footprint: "Capacitor_SMD:C_0603_1608Metric",
      mpn: null, manufacturer: null, datasheet: null, purpose: "LDO input capacitor", claims: [] },
    { ref: "U1", symbol: "Regulator_Linear:AP2112K-3.3", value: "AP2112K-3.3", footprint: "Package_TO_SOT_SMD:SOT-23-5",
      mpn: "AP2112K-3.3TRG1", manufacturer: "Diodes Incorporated", datasheet: "https://www.diodes.com/assets/Datasheets/AP2112.pdf",
      purpose: "3.3 V regulator",
      claims: [{ parameter: "Output current", value: "600mA" }, { parameter: "Dropout voltage", value: "250mV" }] },
    { ref: "C2", symbol: "Device:C", value: "1uF", footprint: "Capacitor_SMD:C_0603_1608Metric",
      mpn: null, manufacturer: null, datasheet: null, purpose: "LDO output capacitor", claims: [] },
    { ref: "R1", symbol: "Device:R", value: "1k", footprint: "Resistor_SMD:R_0603_1608Metric",
      mpn: null, manufacturer: null, datasheet: null, purpose: "LED current limit", claims: [] },
    { ref: "D1", symbol: "Device:LED", value: "Green", footprint: "LED_SMD:LED_0603_1608Metric",
      mpn: null, manufacturer: null, datasheet: null, purpose: "power indicator", claims: [] },
  ],
  nets: [
    { name: "VIN", pins: ["J1.1", "C1.1", "U1.1", "U1.3"], driven_externally: true },
    { name: "GND", pins: ["J1.2", "C1.2", "U1.2", "C2.2", "D1.1"], driven_externally: true },
    { name: "+3V3", pins: ["U1.5", "C2.1", "R1.1"], driven_externally: false },
    { name: "LED_A", pins: ["R1.2", "D1.2"], driven_externally: false },
  ],
  no_connect: ["U1.4"],
  assumptions: ["Offline stand-in: no assumptions were reasoned about."],
  open_questions: [],
};
