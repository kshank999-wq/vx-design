/**
 * Deterministic, keyword-based stand-in for the language model.
 *
 * Used for local development and end-to-end tests when no API key is configured
 * (VX_LLM=offline). It is not AI: it treats every "shall/must/should" block as a
 * requirement and builds a fixed-shape plan. Results are labelled as offline in the UI.
 */
import type { GenerateRequest, GenerateResult, LanguageModel } from "./model.ts";
import { OFFLINE_FIXTURE_CIRCUIT } from "../circuit.ts";
import { OFFLINE_FIXTURE_LAYOUT } from "../layout.ts";
import { OFFLINE_FIXTURE_POWER } from "../power.ts";
import { OFFLINE_FIXTURE_ENCLOSURE } from "../enclosure.ts";
import { OFFLINE_FIXTURE_CONCEPT } from "../concept.ts";
import { offlineFluxHistory } from "../flux-history.ts";
import { offlinePriorWork } from "../prior-work.ts";
import { offlineAssembly } from "../assembly.ts";

const KIND_KEYWORDS: [string, RegExp][] = [
  ["power", /\b(rail|current|voltage|power|battery|regulator|mA|V)\b/i],
  ["interface", /\b(connector|interface|LTC|USB|HDMI|SDI|output|input)\b/i],
  ["mechanical", /\b(mm|outline|enclosure|height|mount|mechanical|layer)\b/i],
  ["thermal", /\b(°C|thermal|temperature)\b/i],
  ["manufacturing", /\b(ERC|DRC|ordering|assembly|fab)\b/i],
];

export class OfflineModel implements LanguageModel {
  async generate<T>(req: GenerateRequest<T>): Promise<GenerateResult<T>> {
    const prompt = String(req.messages[0]?.content ?? "");
    const raw = req.purpose.startsWith("extract") ? this.extract(prompt)
      : req.purpose.startsWith("design_brief") ? this.brief(prompt)
      : req.purpose.startsWith("circuit_design") ? structuredClone(OFFLINE_FIXTURE_CIRCUIT)
      : req.purpose.startsWith("board_layout") ? structuredClone(OFFLINE_FIXTURE_LAYOUT)
      : req.purpose.startsWith("power_tree") ? structuredClone(OFFLINE_FIXTURE_POWER)
      : req.purpose.startsWith("enclosure_design") ? structuredClone(OFFLINE_FIXTURE_ENCLOSURE)
      : req.purpose.startsWith("concept_brief") ? structuredClone(OFFLINE_FIXTURE_CONCEPT)
      : req.purpose.startsWith("flux_history") ? offlineFluxHistory(prompt)
      : req.purpose.startsWith("prior_work") ? offlinePriorWork(prompt)
      : req.purpose.startsWith("assembly_instructions") ? offlineAssembly(prompt)
      : this.plan(prompt);
    const output = req.schema.parse(raw);
    return {
      output,
      assistantMessage: { role: "assistant", content: JSON.stringify(output) },
      usage: { model: "offline-heuristic", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
  }

  private extract(prompt: string) {
    const requirements = [];
    for (const line of prompt.split("\n")) {
      const m = /^\[([^\]]+\.p\d+)\]\s+(?:- )?(.*)$/.exec(line);
      if (!m) continue;
      const [, blockId, text] = m as unknown as [string, string, string];
      const tableRow = text.includes(" | ") && !/\b(parameter|value)\b/i.test(text);
      if (!/\b(shall|must|should)\b/i.test(text) && !tableRow) continue;
      const kind = KIND_KEYWORDS.find(([, re]) => re.test(text))?.[0] ?? "functional";
      requirements.push({
        statement: text,
        kind,
        priority: /\bshould\b/i.test(text) ? "should" : "must",
        block_id: blockId,
        excerpt: text,
        acceptance_criteria: null,
        ambiguity: null,
      });
    }
    return { requirements, open_questions: [] };
  }

  /** A template that answers every requirement and test as open: no engineering content. */
  private brief(prompt: string) {
    const section = (name: string) => prompt.split(`${name}:\n`)[1]?.split("\n\n")[0] ?? "";
    const refs = [...section("Requirements").matchAll(/^- (REQ-[A-Z]+-\d+) /gm)].map((m) => m[1]!);
    const tests = [...section("Acceptance tests").matchAll(/^- (AT\d+) /gm)].map((m) => m[1]!);
    return {
      summary: "Offline stand-in: no analysis was performed.",
      approach: "The offline heuristic does not do engineering work. Configure ANTHROPIC_API_KEY to draft real briefs.",
      requirement_responses: refs.map((ref) => ({ ref, status: "open", response: "Not analysed (offline mode).", open_question: null })),
      acceptance_responses: tests.map((test_id) => ({ test_id, claim: "needs_review", explanation: "Not assessed (offline mode)." })),
      proposed_decisions: [],
      risks: [],
      assumptions: [],
      open_questions: [],
    };
  }

  private plan(prompt: string) {
    const reqs = [...prompt.matchAll(/^- (REQ-([A-Z]{3})-\d{3}) \[/gm)].map((m) => ({ ref: m[1]!, code: m[2]! }));
    const refs = (codes: string[]) => reqs.filter((r) => codes.includes(r.code)).map((r) => r.ref);
    const test = (description: string, validation_kind: string | null = null) =>
      [{ description, method: validation_kind ? "validation" : "human_review", validation_kind }];
    const t = (key: string, title: string, discipline: string, upstream: string[], codes: string[], extra: object = {}) => ({
      key, title, discipline, description: `${title} (offline plan).`, upstream_keys: upstream,
      requirement_refs: refs(codes), acceptance_tests: test(`${title} reviewed`), risk_level: "medium",
      required_tools: [], approval_required: false, approval_reason: null, estimated_hours: 4, ...extra,
    });
    const tasks = [
      t("architecture", "System and component architecture", "architecture", [], ["FUN", "GEN"],
        { risk_level: "high", approval_required: true, approval_reason: "component architecture" }),
      t("power-budget", "Preliminary power budget", "power", ["architecture"], ["PWR", "ELE", "THM"]),
      t("enclosure-envelope", "Mechanical envelope", "mechanical", ["architecture"], ["MEC", "ENV"]),
      t("schematic", "Schematic capture", "schematic", ["power-budget", "enclosure-envelope"], ["IFC"],
        { acceptance_tests: test("ERC passes with zero errors", "erc"), required_tools: ["kicad"] }),
      t("pcb-layout", "PCB stackup and layout", "pcb_layout", ["schematic"], [],
        { acceptance_tests: test("DRC passes with zero errors", "drc"), required_tools: ["kicad", "freerouting"] }),
      t("verification", "Verification and manufacturing outputs", "verification", ["pcb-layout"], ["MFG", "REG", "CST"],
        { required_tools: ["kicad", "kikit"] }),
    ];
    // Inputs to build on: prior work (PW-n) goes to the electronics, mock-ups and drawings (REF-n) to the envelope.
    const pw = [...prompt.matchAll(/^Prior work \[(PW-\d+)\]/gm)].map((m) => m[1]!);
    const refsIn = [...prompt.matchAll(/^- \[(REF-\d+)\] .*?\((mockup|sketch|render|photo|drawing|prior design|datasheet|other),/gm)];
    const looks = refsIn.filter((m) => /mockup|sketch|render|photo|drawing/.test(m[2]!)).map((m) => m[1]!);
    const prior = [...pw, ...refsIn.filter((m) => m[2] === "prior design").map((m) => m[1]!)];
    // Register items already committed to (selected, designed, laid out, verified): the architecture task continues them.
    const committed = [...prompt.matchAll(/^\s+- \[(PR-\d+)\] \((selected|designed|laid out|verified)/gm)].map((m) => m[1]!);
    if (pw.length || refsIn.length || committed.length) {
      const none = { concerns: [] as string[], alternatives: [] as string[] };
      const basis = (key: string) => key === "enclosure-envelope" && looks.length ? { mode: "adapt", sources: looks, reason: "Start from the mock-ups (offline plan).", ...none }
        : key === "architecture" && (prior.length || committed.length) ? { mode: "adapt", sources: [...prior, ...committed], reason: "Continue the earlier work and re-check it (offline plan).", ...none }
        : ["schematic", "pcb-layout"].includes(key) && prior.length ? { mode: "adapt", sources: prior, reason: "Start from the prior design and re-check it (offline plan).", ...none }
        : { mode: "new", sources: [], reason: "Nothing to build on (offline plan).", ...none };
      for (const x of tasks) Object.assign(x, { basis: basis(x.key) });
    }
    const covered = new Set(tasks.flatMap((x) => x.requirement_refs));
    const leftovers = reqs.map((r) => r.ref).filter((r) => !covered.has(r));
    tasks[0]!.requirement_refs.push(...leftovers);
    return { summary: "Offline heuristic plan (not AI-generated).", tasks, deferred_requirements: [], assumptions: [] };
  }
}
