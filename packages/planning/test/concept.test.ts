import { test } from "node:test";
import assert from "node:assert/strict";
import { generateConceptBrief, OFFLINE_FIXTURE_CONCEPT, renderConceptPrompt, type ConceptInput } from "../src/concept.ts";
import { OfflineModel } from "../src/llm/offline.ts";
import { ScriptedModel } from "../src/llm/model.ts";

const input: ConceptInput = {
  project: { name: "Slate", description: "Timecode slate" },
  requirements: [{ ref_code: "REQ-MECH-001", kind: "mechanical", text: "The slate shall be at most 170 mm long." }],
  direction: "Rugged, matte black", count: 2,
  parent: { name: "Field Brick", prompt: "rugged slate", cmf_summary: "matte black" },
  freeze: { name: "Slim Clap", envelope: { length_mm: 150, width_mm: 85, height_mm: 26 } },
};

test("prompt carries requirements, refinement, freeze and the count", () => {
  const p = renderConceptPrompt(input);
  assert.match(p, /REQ-MECH-001 \[mechanical\]/);
  assert.match(p, /REFINE THIS VARIANT .*"Field Brick"/);
  assert.match(p, /CURRENT DESIGN FREEZE: "Slim Clap", envelope 150 x 85 x 26 mm/);
  assert.match(p, /Write exactly 2 variant\(s\)\./);
});

test("too few variants are sent back once; then the brief is used", async () => {
  const one = { ...structuredClone(OFFLINE_FIXTURE_CONCEPT), variants: OFFLINE_FIXTURE_CONCEPT.variants.slice(0, 1) };
  const m = new ScriptedModel([() => one, () => structuredClone(OFFLINE_FIXTURE_CONCEPT)]);
  const r = await generateConceptBrief(input, m);
  assert.equal(r.brief.variants.length, 2, "trimmed to the count");
  assert.equal(m.calls.length, 2);
  assert.match(String(m.calls[1]!.messages.at(-1)!.content), /1 variant\(s\) written; 2 were asked for/);
});

test("offline model returns the labelled fixture", async () => {
  const r = await generateConceptBrief({ ...input, count: 3 }, new OfflineModel());
  assert.equal(r.brief.variants.length, 3);
  assert.match(r.brief.product_summary, /Offline stand-in/);
});
