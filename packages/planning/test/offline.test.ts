import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseText } from "../src/ingest/parsers.ts";
import { extractRequirements } from "../src/extract.ts";
import { generatePlan } from "../src/plan.ts";
import { OfflineModel } from "../src/llm/offline.ts";

test("offline model runs the full pipeline on the sample spec and passes validation", async () => {
  const raw = readFileSync(join(import.meta.dirname, "../../../tests/fixtures/specs/sample-timecode-board.md"));
  const doc = parseText(raw.toString(), "text/markdown", raw);
  const model = new OfflineModel();
  const ex = await extractRequirements(doc, model);
  assert.ok(ex.requirements.length >= 10, `got ${ex.requirements.length}`);
  assert.deepEqual(ex.dropped, []);
  const plan = await generatePlan(ex.requirements, model);
  assert.equal(plan.attempts, 1);
  assert.equal(plan.tasks[0]!.key, "architecture");
  const covered = new Set(plan.tasks.flatMap((t) => t.requirementRefs));
  for (const r of ex.requirements) assert.ok(covered.has(r.refCode), `${r.refCode} uncovered`);
});

test("offline brief answers every requirement and test as open", async () => {
  const { generateBrief, OfflineModel } = await import("../src/index.ts");
  const input = {
    projectContext: "Test",
    task: { key: "power-budget", title: "Power budget", discipline: "power", description: null },
    requirements: [{ refCode: "REQ-PWR-001", kind: "power", priority: "must", text: "5 V input" },
                   { refCode: "REQ-PWR-002", kind: "power", priority: "must", text: "3.3 V rail" }],
    acceptanceTests: [{ id: "AT1", description: "Budget reviewed", method: "human_review" }],
    upstream: [], reviewNotes: [],
  };
  const r = await generateBrief(input, new OfflineModel());
  assert.deepEqual(r.brief.requirement_responses.map((x) => x.ref), ["REQ-PWR-001", "REQ-PWR-002"]);
  assert.deepEqual(r.brief.acceptance_responses.map((x) => x.claim), ["needs_review"]);
});
