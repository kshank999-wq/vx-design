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

test("extraction: verified citations, document-order numbering, one repair round", async () => {
  const model = new ScriptedModel([
    () => ({
      requirements: [
        // Returned out of document order on purpose.
        req("LTC output at standard frame rates", "S2.1.p1", "output SMPTE 12M LTC at 23.976, 24, 25, 29.97 DF and 30 fps", "interface"),
        req("Current draw at most 60 mA", "S2.p2", "Total current draw shall not exceed 60 mA", "power"),
        req("Input range 4.5-5.5 V", "S2.p1", "input range of 4.5 V to 5.5 V", "power"),
        req("Board is waterproof", "S3.p1", "The board shall be waterproof"), // invented
      ],
      open_questions: [{ question: "Which Lemo part number?", block_id: "S3.p5" }],
    }),
    (r) => {
      const last = r.messages.at(-1)!.content as string;
      assert.match(last, /The board shall be waterproof/);
      assert.match(last, /excerpt not found/);
      return {
        requirements: [
          req("LTC output at standard frame rates", "S2.1.p1", "output SMPTE 12M LTC at 23.976, 24, 25, 29.97 DF and 30 fps", "interface"),
          req("Current draw at most 60 mA", "S2.p2", "Total current draw shall not exceed 60 mA", "power"),
          req("Input range 4.5-5.5 V", "S2.p1", "input range of 4.5 V to 5.5 V", "power", { ambiguity: "Is reverse polarity protection needed?" }),
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
    ["REQ-PWR-001", "S2.p1"],
    ["REQ-PWR-002", "S2.p2"],
    ["REQ-IFC-001", "S2.1.p1"],
    ["REQ-MEC-001", "S3.p2"],
  ]);
  assert.equal(out.requirements[0]!.status, "ambiguous");
  assert.equal(out.requirements[0]!.notes, "Is reverse polarity protection needed?");
  assert.equal(out.requirements[2]!.sectionTitle, "2.1 Timecode interface");
  assert.deepEqual(out.dropped, []);
});

test("extraction: citations still invalid after repair are dropped and reported", async () => {
  const bad = () => ({ requirements: [req("Made up", "S1.p1", "this text is not in the document")], open_questions: [] });
  const model = new ScriptedModel([bad, bad]);
  const out = await extractRequirements(doc, model);
  assert.equal(out.requirements.length, 0);
  assert.equal(out.dropped.length, 1);
  assert.equal(out.dropped[0]!.reason, "excerpt not found in the document");
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

test("plan: validation problems are fed back and the repaired plan is ordered", async () => {
  const model = new ScriptedModel([
    () => ({
      summary: "v1",
      tasks: [task("arch", ["layout"], ["REQ-PWR-001"]), task("layout", ["arch"], ["REQ-IFC-001"])],
      deferred_requirements: [],
      assumptions: [],
    }),
    (r) => {
      const feedback = r.messages.at(-1)!.content as string;
      assert.match(feedback, /dependency cycle/);
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
  const invalid = () => ({ summary: "", tasks: [task("a", ["missing"], [])], deferred_requirements: [], assumptions: [] });
  const model = new ScriptedModel([invalid, invalid, invalid]);
  await assert.rejects(generatePlan(REQS, model), (e: unknown) => {
    assert.ok(e instanceof PlanValidationError);
    assert.equal(e.attempts, 3);
    assert.ok(e.problems.some((p) => p.code === "unknown_upstream"));
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
