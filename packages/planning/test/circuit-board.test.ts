import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { generateCircuit, keptPartProblems, OFFLINE_FIXTURE_CIRCUIT, renderCircuitPrompt, type CircuitDesign, type LanguageModel } from "../src/index.ts";

const base = OFFLINE_FIXTURE_CIRCUIT;
const input = { projectContext: "Slate", task: { key: "io", title: "IO", description: null }, requirements: [], acceptanceTests: [], upstream: [], reviewNotes: [],
  board: { name: "main", base: { taskKey: "core", design: base }, power: { taskKey: "pwr", summary: "{\"rails\":[\"+3V3\"]}" } } };

test("a board's next schematic task gets the design so far and must keep its parts", async () => {
  const prompt = renderCircuitPrompt(input);
  assert.match(prompt, /part of the board "main"/);
  assert.match(prompt, /Board design so far:\n\{"name":"offline_fixture_ldo_led"/);
  assert.match(prompt, /power tree \(from pwr\)/);
  const dropped: CircuitDesign = { ...base, components: base.components.filter((c) => c.ref !== "D1") };
  assert.deepEqual(keptPartProblems(base, dropped).length, 1);
  assert.deepEqual(keptPartProblems(base, base), []);

  // The model first drops a part, is told, then returns the complete board.
  const replies = [dropped, base];
  let checks = 0;
  const model: LanguageModel = { async generate() {
    const out = replies.shift()!;
    return { output: out as never, assistantMessage: { role: "assistant", content: "" }, usage: { model: "m", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } };
  } };
  const r = await generateCircuit(input, model, async () => { checks++; return { ok: true, problems: [], warnings: [], stage: "built" }; });
  assert.equal(r.rounds, 2);
  assert.equal(checks, 1, "the library and ERC check runs only once the earlier parts are all kept");
  void z;
});
