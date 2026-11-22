import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseText } from "../src/ingest/parsers.ts";
import { extractRequirements } from "../src/extract.ts";
import { generatePlan, PlanValidationError, validatePlan, type PlanOutput } from "../src/plan.ts";
import { ScriptedModel } from "../src/llm/model.ts";

const SAMPLE = readFileSync(join(import.meta.dirname, "../../../tests/fixtures/specs/sample-timecode-board.md"));
const doc = parseText(SAMPLE.toString(), "text/markdown", SAMPLE);

const req = (statement: string, block_id: string, excerpt: string, kind = "electrical", extra: object = {}) => ({
  statement, kind, priority: "must", block_id, excerpt, acceptance_criteria: null, ambiguity: null, ...extra,
});

test("extraction: clear statements by rules, the rest by the model with verified citations, one repair round", async () => {
  const model = new ScriptedModel([
    (r) => {
      const prompt = r.messages[0]!.content as string;
      assert.match(prompt, /\[S3\.p2\] Board outline/, "table rows go to the model");
      assert.match(prompt, /\[S4\.p1\] - Timecode drift shall be measured/, "a sentence with two obligations goes to the model");
      assert.doesNotMatch(prompt, /\[S2\.p1\]|\[S1\.p1\]/, "clear statements and the overview are not sent");
      return {
        requirements: [
          req("Timecode drift within 1 frame over 8 hours", "S4.p1", "must stay within 1 frame", "functional"),
          req("Board is waterproof", "S3.p1", "The board shall be waterproof"), // invented
        ],
        open_questions: [{ question: "Which Lemo part number?", block_id: "S3.p5" }],
      };
    },
    (r) => {
      const last = r.messages.at(-1)!.content as string;
      assert.match(last, /The board shall be waterproof/);
      assert.match(last, /excerpt not found/);
      return {
        requirements: [
          req("Timecode drift within 1 frame over 8 hours", "S4.p1", "must stay within 1 frame", "functional", { ambiguity: "Which reference generator?" }),
          // Wrong block cited, but the text exists elsewhere: corrected, not dropped.
          req("Board outline at most 40 x 25 mm", "S2.p1", "Board outline | 40 mm x 25 mm maximum", "mechanical"),
        ],
        open_questions: [],
      };
    },
  ]);
  const out = await extractRequirements(doc, model);
  assert.equal(model.calls.length, 2);
  assert.deepEqual(out.requirements.map((r) => [r.refCode, r.blockId]), [
    ["REQ-PWR-001", "S2.p1"], ["REQ-PWR-002", "S2.p2"], ["REQ-PWR-003", "S2.p3"], ["REQ-ELE-001", "S2.p4"],
    ["REQ-IFC-001", "S2.1.p1"], ["REQ-IFC-002", "S2.1.p2"], ["REQ-IFC-003", "S2.1.p3"],
    ["REQ-MEC-001", "S3.p2"], ["REQ-IFC-004", "S3.p5"], ["REQ-FUN-001", "S4.p1"], ["REQ-ELE-002", "S4.p2"],
  ]);
  const drift = out.requirements.find((r) => r.blockId === "S4.p1")!;
  assert.equal(drift.status, "ambiguous");
  assert.equal(drift.notes, "Which reference generator?");
  assert.equal(out.requirements[4]!.sectionTitle, "2.1 Timecode interface");
  assert.equal(out.requirements[1]!.acceptanceCriteria, "Measured or inspected value meets the stated figure(s): 60 mA.");
  assert.deepEqual(out.sources, { reused: 0, rules: 9, ai: 2, aiBlocks: 6, skippedBlocks: 1, blocks: 16 });
  assert.match(model.calls[0]!.messages[0]!.content as string, /\[S3\.p3\] Layer count/, "every table row with a figure is read");
  assert.deepEqual(out.dropped, []);
});

test("extraction: citations still invalid after repair are dropped and reported; the rule requirements stand", async () => {
  const bad = () => ({ requirements: [req("Made up", "S1.p1", "this text is not in the document")], open_questions: [] });
  const model = new ScriptedModel([bad, bad]);
  const out = await extractRequirements(doc, model);
  assert.equal(out.requirements.length, 9);
  assert.equal(out.dropped.length, 1);
  assert.equal(out.dropped[0]!.reason, "excerpt not found in the document");
});

test("extraction: a document of clear statements needs no AI; blocks read before are reused", async () => {
  const clear = parseText("# Spec\n\n## 1. Power\n\n- The slate shall run for 8 hours on one charge.\n- The battery should be user-replaceable.\n- The housing shall be robust.\n", "text/markdown", Buffer.from("x"));
  const none = new ScriptedModel([]);
  const out = await extractRequirements(clear, none);
  assert.equal(none.calls.length, 0, "no model call");
  assert.deepEqual(out.requirements.map((r) => [r.priority, r.status, r.kind]), [["must", "extracted", "power"], ["should", "extracted", "power"], ["must", "ambiguous", "mechanical"]]);
  assert.equal(out.requirements[2]!.notes, '"robust" has no measurable criterion.');
  // A new revision: the table rows were read before (by AI) and are reused; only the changed block is read again.
  const reuse = new Map([[ "Board outline | 40 mm x 25 mm maximum", [{ statement: "Board outline at most 40 x 25 mm", kind: "mechanical" as const, priority: "must" as const,
    excerpt: "Board outline | 40 mm x 25 mm maximum", acceptance_criteria: null, ambiguity: null }]]]);
  const model = new ScriptedModel([(r) => {
    assert.doesNotMatch(r.messages[0]!.content as string, /Board outline/, "a reused block is not sent again");
    return { requirements: [], open_questions: [] };
  }]);
  const rev = await extractRequirements(doc, model, { reuse });
  assert.equal(rev.sources!.reused, 1);
  assert.ok(rev.requirements.some((r) => r.blockId === "S3.p2" && r.text === "Board outline at most 40 x 25 mm"));
});
const REQS = [
  { refCode: "REQ-PWR-001", kind: "power", priority: "must", status: "extracted", text: "5 V input" },
  { refCode: "REQ-IFC-001", kind: "interface", priority: "must", status: "extracted", text: "LTC output" },
  { refCode: "REQ-MEC-001", kind: "mechanical", priority: "must", status: "extracted", text: "40x25 mm" },
  { refCode: "REQ-GEN-001", kind: "other", priority: "may", status: "rejected", text: "ignored" },
];

const task = (key: string, upstream: string[], refs: string[], extra: Partial<PlanOutput["tasks"][number]> = {}) => ({
  key, title: key, discipline: "architecture" as const, description: "", upstream_keys: upstream, requirement_refs: refs,
  acceptance_tests: [{ description: "reviewed", method: "human_review" as const, validation_kind: null }],
  risk_level: "medium" as const, required_tools: [], approval_required: false, approval_reason: null, estimated_hours: 4,
  ...extra,
});

test("plan: problems code cannot fix are fed back and the repaired plan is ordered", async () => {
  const model = new ScriptedModel([
    // An empty plan: nothing for code to place requirements in, so the model is asked again.
    () => ({ summary: "v1", tasks: [], deferred_requirements: [], assumptions: [] }),
    (r) => {
      const feedback = r.messages.at(-1)!.content as string;
      assert.match(feedback, /the plan has no tasks/);
      assert.match(feedback, /REQ-MEC-001 is not covered/);
      assert.doesNotMatch(feedback, /REQ-GEN-001/); // rejected requirements are not required
      return {
        summary: "v2",
        tasks: [
          task("layout", ["arch", "power"], ["REQ-IFC-001", "REQ-MEC-001"], { discipline: "pcb_layout", risk_level: "high" }),
          task("power", ["arch"], ["REQ-PWR-001"], { discipline: "power" }),
          task("arch", [], []),
        ],
        deferred_requirements: [],
        assumptions: ["LTC level set in firmware"],
      };
    },
  ]);
  const plan = await generatePlan(REQS, model);
  assert.equal(plan.attempts, 2);
  assert.deepEqual(plan.tasks.map((t) => t.key), ["arch", "power", "layout"]);
  const layout = plan.tasks[2]!;
  assert.equal(layout.approvalRequired, true); // forced by policy: high risk
  assert.deepEqual(plan.adjustments, ['"layout": approval required because risk is high']);
  assert.equal(layout.acceptanceTests[0]!.id, "AT1");
});

test("plan: gives up after the repair budget with the remaining problems", async () => {
  const invalid = () => ({ summary: "", tasks: [], deferred_requirements: [], assumptions: [] });
  const model = new ScriptedModel([invalid, invalid, invalid]);
  await assert.rejects(generatePlan(REQS, model), (e: unknown) => {
    assert.ok(e instanceof PlanValidationError);
    assert.equal(e.attempts, 3);
    assert.ok(e.problems.some((p) => p.code === "empty"));
    return true;
  });
  assert.equal(model.calls.length, 3);
});

test("validatePlan catches each structural problem", () => {
  const codes = (p: PlanOutput, refs = ["R1"]) => validatePlan(p, refs).map((x) => x.code).sort();
  const base = { summary: "", deferred_requirements: [], assumptions: [] };
  assert.deepEqual(codes({ ...base, tasks: [] }), ["empty", "uncovered"]);
  assert.deepEqual(codes({ ...base, tasks: [task("A b", [], ["R1"])] }), ["bad_key"]);
  assert.deepEqual(codes({ ...base, tasks: [task("a", [], ["R1"]), task("a", [], [])] }), ["duplicate_key"]);
  assert.deepEqual(codes({ ...base, tasks: [task("a", [], ["R1", "R9"], { acceptance_tests: [] })] }), ["no_acceptance", "unknown_requirement"]);
  assert.deepEqual(codes({ ...base, tasks: [task("a", [], [])], deferred_requirements: [{ ref: "R1", reason: "later" }] }), []);
  assert.deepEqual(codes({ ...base, tasks: [task("a", [], [])], deferred_requirements: [{ ref: "R7", reason: "x" }] }), ["uncovered", "unknown_deferred"]);
});

test("brief: missing answers trigger one repair round, then fail", async () => {
  const { generateBrief, validateBrief, BriefValidationError, ScriptedModel } = await import("../src/index.ts");
  const input = {
    projectContext: "Test",
    task: { key: "arch", title: "Architecture", discipline: "architecture", description: null },
    requirements: [{ refCode: "REQ-FUN-001", kind: "functional", priority: "must", text: "Output LTC" }],
    acceptanceTests: [{ id: "AT1", description: "Reviewed", method: "human_review" }],
    upstream: [], reviewNotes: ["Explain the clock source"],
  };
  const good = {
    summary: "Use an MCU with a TCXO.", approach: "Because jitter.",
    requirement_responses: [{ ref: "REQ-FUN-001", status: "addressed", response: "LTC via SPI", open_question: null }],
    acceptance_responses: [{ test_id: "AT1", claim: "needs_review", explanation: "Reviewer judges." }],
    proposed_decisions: [], risks: [], assumptions: [], open_questions: [],
  };
  const incomplete = { ...good, requirement_responses: [], acceptance_responses: [{ test_id: "AT9", claim: "met", explanation: "x" }] };
  const repaired = new ScriptedModel([() => incomplete, () => good]);
  const r = await generateBrief(input, repaired);
  assert.equal(r.attempts, 2);
  assert.match(String(repaired.calls[0]!.messages[0]!.content), /Explain the clock source/);
  assert.match(String(repaired.calls[1]!.messages.at(-1)!.content), /no response for REQ-FUN-001/);
  assert.deepEqual(validateBrief(good as never, input), []);
  await assert.rejects(generateBrief(input, new ScriptedModel([() => incomplete, () => incomplete])), BriefValidationError);
});

test("circuit: check problems go back to the model until the design passes", async () => {
  const { generateCircuit, CircuitDesignError, ScriptedModel, OFFLINE_FIXTURE_CIRCUIT } = await import("../src/index.ts");
  const input = {
    projectContext: "Test", task: { key: "schematic", title: "Schematic", description: null },
    requirements: [{ refCode: "REQ-PWR-001", kind: "power", priority: "must", text: "3.3 V rail" }],
    acceptanceTests: [{ id: "AT1", description: "ERC passes", method: "validation" }], upstream: [], reviewNotes: [],
  };
  const bad = { ...OFFLINE_FIXTURE_CIRCUIT, name: "bad" };
  const good = { ...OFFLINE_FIXTURE_CIRCUIT, name: "good" };
  const checks = [
    { ok: false, stage: "validation" as const, problems: ["U1: symbol Regulator_Linear:AP2112K-33 is not in the KiCad libraries (did you mean Regulator_Linear:AP2112K-3.3?)"], warnings: [] },
    { ok: false, stage: "erc" as const, problems: ["ERC error power_pin_not_driven: Input Power pin not driven by any Output Power pins"], warnings: ["J1 footprint filter"] },
    { ok: true, stage: "built" as const, problems: [], warnings: [] },
  ];
  const model = new ScriptedModel([() => bad, () => bad, () => good]);
  const seen: string[] = [];
  const r = await generateCircuit(input, model, async (d) => { seen.push(d.name); return checks.shift()!; });
  assert.equal(r.rounds, 3);
  assert.equal(r.design.name, "good");
  assert.deepEqual(r.history.map((h) => h.stage), ["validation", "erc", "built"]);
  const msgs = model.calls[2]!.messages;   // the conversation grows: prompt, design, feedback, design, feedback
  assert.match(String(msgs[2]!.content), /did you mean Regulator_Linear:AP2112K-3.3/);
  assert.match(String(msgs[4]!.content), /failed at the erc stage[\s\S]*Warnings/);

  const never = new ScriptedModel(Array.from({ length: 4 }, () => () => bad));
  await assert.rejects(generateCircuit(input, never, async () => ({ ok: false, stage: "erc", problems: ["x"], warnings: [] })),
    (e: unknown) => e instanceof CircuitDesignError && e.rounds === 4);
});

test("layout: placement and DRC problems go back to the model until the board passes", async () => {
  const { generateLayout, LayoutDesignError, ScriptedModel, OFFLINE_FIXTURE_CIRCUIT, OFFLINE_FIXTURE_LAYOUT, renderLayoutPrompt } =
    await import("../src/index.ts");
  const input = {
    projectContext: "Test", task: { key: "pcb-layout", title: "Layout", description: null },
    requirements: [{ refCode: "REQ-MEC-001", kind: "mechanical", priority: "must", text: "Fit a 40 x 30 mm outline" }],
    acceptanceTests: [{ id: "AT1", description: "DRC passes", method: "validation" }], upstream: [], reviewNotes: [],
    circuit: OFFLINE_FIXTURE_CIRCUIT,
    footprints: [{ ref: "U1", footprint: "Package_TO_SOT_SMD:SOT-23-5", value: "AP2112K-3.3", mount: "smd" as const, pads: 5,
                   courtyard_mm: { width: 4.19, height: 3.49, left: -2.1, top: -1.75, right: 2.1, bottom: 1.75 } }],
    fabProfiles: [{ name: "jlcpcb-2layer-standard", description: "JLCPCB" }],
  };
  const prompt = renderLayoutPrompt(input);
  assert.match(prompt, /U1 \(AP2112K-3.3\) Package_TO_SOT_SMD:SOT-23-5: smd, 5 pads, courtyard 4.19 x 3.49 mm/);
  assert.match(prompt, /- VIN: J1.1, C1.1, U1.1, U1.3/);
  const cramped = { ...OFFLINE_FIXTURE_LAYOUT, board: { ...OFFLINE_FIXTURE_LAYOUT.board, width_mm: 20 } };
  const checks = [
    { ok: false, stage: "placement" as const, problems: ["D1 courtyard spans x 28.2..29.8 mm, outside the 20 x 22 mm board"], warnings: [] },
    { ok: false, stage: "routing" as const, problems: ["the autorouter left 2 connection(s) unrouted"], warnings: [] },
    { ok: true, stage: "built" as const, problems: [], warnings: [] },
  ];
  const model = new ScriptedModel([() => cramped, () => cramped, () => OFFLINE_FIXTURE_LAYOUT]);
  const r = await generateLayout(input, model, async () => checks.shift()!);
  assert.equal(r.rounds, 3);
  assert.equal(r.layout.board.width_mm, 34);
  assert.deepEqual(r.history.map((h) => h.stage), ["placement", "routing", "built"]);
  assert.match(String(model.calls[2]!.messages[2]!.content), /outside the 20 x 22 mm board/);
  const never = new ScriptedModel(Array.from({ length: 4 }, () => () => cramped));
  await assert.rejects(generateLayout(input, never, async () => ({ ok: false, stage: "drc", problems: ["x"], warnings: [] })),
    (e: unknown) => e instanceof LayoutDesignError && e.rounds === 4);
});

test("layout: the offline fixture layout matches the engineering fixture", async () => {
  const { OFFLINE_FIXTURE_LAYOUT, BoardLayout } = await import("../src/index.ts");
  const py = JSON.parse(readFileSync(join(import.meta.dirname, "../../../services/engineering/vx_eng/fixtures/ldo_led_layout.json"), "utf8"));
  const parsed = BoardLayout.parse({ ...py, assumptions: [], open_questions: [] });
  assert.deepEqual(parsed.board, OFFLINE_FIXTURE_LAYOUT.board);
  assert.deepEqual(parsed.placements, OFFLINE_FIXTURE_LAYOUT.placements);
});

test("power: calculator errors go back to the model until the tree passes", async () => {
  const { generatePowerTree, PowerTreeError, ScriptedModel, OFFLINE_FIXTURE_POWER, renderPowerPrompt } = await import("../src/index.ts");
  const input = {
    projectContext: "Test", task: { key: "power-budget", title: "Power budget", description: null },
    requirements: [{ refCode: "REQ-PWR-001", kind: "power", priority: "must", text: "Run 12 h from one 1S Li-ion cell" }],
    acceptanceTests: [], upstream: [], reviewNotes: [], circuit: null,
  };
  assert.match(renderPowerPrompt(input), /REQ-PWR-001 \[power, must\] Run 12 h/);
  const ldoFromCell = structuredClone(OFFLINE_FIXTURE_POWER);
  ldoFromCell.converters[0] = { ...ldoFromCell.converters[0]!, kind: "ldo", efficiency: null, dropout_v: 0.25 };
  const model = new ScriptedModel([() => ldoFromCell, () => OFFLINE_FIXTURE_POWER]);
  const r = await generatePowerTree(input, model);
  assert.equal(r.rounds, 2);
  assert.equal(r.report.ok, true);
  assert.equal(r.history[0]!.errors, 1);
  assert.match(String(model.calls[1]!.messages.at(-1)!.content), /U1: U1 cannot make 3.3 V from 3 V/);
  const never = new ScriptedModel(Array.from({ length: 4 }, () => () => ldoFromCell));
  await assert.rejects(generatePowerTree(input, never), (e: unknown) => e instanceof PowerTreeError && e.rounds === 4);
});

test("power: the offline fixture tree passes the calculator", async () => {
  const { OFFLINE_FIXTURE_POWER } = await import("../src/index.ts");
  const { calculate } = await import("@vx/power");
  const r = calculate(OFFLINE_FIXTURE_POWER);
  assert.equal(r.ok, true, JSON.stringify(r.findings));
  assert.ok(r.runtime[0]!.perMode.find((m) => m.mode === "active")!.hours! > 40);
});

test("enclosure: fit problems go back to the model; the offline fixture matches the engineering fixture", async () => {
  const { generateEnclosure, EnclosureDesignError, ScriptedModel, OFFLINE_FIXTURE_ENCLOSURE, EnclosureDesign, renderEnclosurePrompt } =
    await import("../src/index.ts");
  const facts = {
    board: { width_mm: 34, height_mm: 22, thickness_mm: 1.6 }, holes: [{ ref: "H1", x: 3.5, y: -3.5, size: "M3" }],
    parts: [{ ref: "J1", value: "VIN 5V", side: "top", has_model: true, height_above_board_mm: 8.5, bottom_z_mm: -1.4, nearest_edge: "left", edge_distance_mm: 2.7 },
            { ref: "X1", value: "?", side: "top", has_model: false }],
    processes: { fdm: { label: "FDM", min_wall_mm: 1.2, fastenings: ["heat_set_insert"], min_inner_radius_mm: 0, build_mm: [250, 210, 210] } },
    fastener_depth_mm: { heat_set_insert: { M3: 5.7 } },
  };
  const input = { projectContext: "Test", task: { key: "enclosure", title: "Enclosure", description: null }, requirements: [],
                  acceptanceTests: [], upstream: [], reviewNotes: [], facts, components: [{ ref: "J1", value: "VIN 5V", purpose: "5 V input" }] };
  const prompt = renderEnclosurePrompt(input);
  assert.match(prompt, /J1 \(VIN 5V, 5 V input\): top side, 8.5 mm above the board, bottom at z -1.4 mm, 2.7 mm from the left edge/);
  assert.match(prompt, /X1 \(\?\): no 3D model/);
  const noWindow = { ...OFFLINE_FIXTURE_ENCLOSURE, top_clearance_mm: -1 };
  const model = new ScriptedModel([() => noWindow, () => OFFLINE_FIXTURE_ENCLOSURE]);
  const checks = [{ ok: false, stage: "fit" as const, problems: ["U1 collides with the lid: 4.6 mm³"], warnings: [] },
                  { ok: true, stage: "built" as const, problems: [], warnings: [] }];
  const r = await generateEnclosure(input, model, async () => checks.shift()!);
  assert.equal(r.rounds, 2);
  assert.match(String(model.calls[1]!.messages.at(-1)!.content), /U1 collides with the lid/);
  await assert.rejects(generateEnclosure(input, new ScriptedModel(Array.from({ length: 4 }, () => () => noWindow)),
    async () => ({ ok: false, stage: "fit", problems: ["x"], warnings: [] })), (e: unknown) => e instanceof EnclosureDesignError);
  const py = JSON.parse(readFileSync(join(import.meta.dirname, "../../../services/engineering/vx_eng/fixtures/ldo_led_enclosure.json"), "utf8"));
  assert.deepEqual(EnclosureDesign.parse(py), OFFLINE_FIXTURE_ENCLOSURE);
});
