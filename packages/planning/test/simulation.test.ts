import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, evaluateAll, generateSimulation, OFFLINE_SIMULATION, renderSimulationMarkdown, type LanguageModel, type SimulationOutput } from "../src/index.ts";

test("calculator: arithmetic, functions, comparisons, and nothing else", () => {
  assert.equal(evaluate("2 + 3 * 4 ^ 2 / 8", {}), 8);
  assert.equal(evaluate("sqrt(x) * -2 + max(1, 5, 3)", { x: 16 }), -3);
  assert.equal(evaluate("a <= 0.5 and not (b > 3)", { a: 0.5, b: 2 }), 1);
  assert.equal(evaluate("2.5e-3 * 1e3", {}), 2.5);
  for (const bad of ["process.exit()", "x.y", "'a'", "require(1)", "1 +", "foo(2)"]) assert.throws(() => evaluate(bad, { x: 1 }), Error, bad);
  const r = evaluateAll([{ name: "c", expression: "a * b" }, { name: "a", expression: "2" }, { name: "b", expression: "a + 1" }, { name: "loop", expression: "loop + 1" }]);
  assert.deepEqual([r.values.a, r.values.b, r.values.c], [2, 3, 6]);
  assert.match(r.problems.join(), /"loop" depends on itself/);
});

const holdover = (expr: string): SimulationOutput => ({ ...OFFLINE_SIMULATION, title: "Holdover", quantities: [
  { name: "tcxo_ppm", expression: "0.5", unit: "ppm", meaning: "TCXO stability", source: "datasheet" },
  { name: "holdover_s", expression: "8 * 3600", unit: "s", meaning: "holdover", source: "REQ-TC-1" },
  { name: "drift_ms", expression: expr, unit: "ms", meaning: "drift", source: "computed" },
], spice: null, checks: [{ id: "C1", description: "half a frame at 24 fps", expression: "drift_ms <= 1000 / 24 / 2", requirement_ref: "REQ-TC-1" }] });

test("numbers are computed in code; a broken expression is repaired; a failing check is a result", async () => {
  const replies = [holdover("tcxo_ppm * 1e-6 * holdover_ms"), holdover("tcxo_ppm * 1e-6 * holdover_s * 1000")];
  const prompts: string[] = [];
  const model: LanguageModel = { async generate(req) {
    prompts.push(String(req.messages.at(-1)!.content));
    return { output: replies.shift() as never, assistantMessage: { role: "assistant", content: "" }, usage: { model: "m", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } };
  } };
  const r = await generateSimulation({ projectContext: "Slate", task: { key: "holdover", title: "Holdover", description: null }, requirements: [], acceptanceTests: [],
    upstream: [], reviewNotes: [], spiceAvailable: false }, model, async () => { throw new Error("no spice"); });
  assert.equal(r.rounds, 2);
  assert.match(prompts[1]!, /unknown name holdover_ms/);
  assert.equal(Number(r.values.drift_ms!.toFixed(3)), 14.4);
  assert.deepEqual(r.checks.map((c) => c.passed), [true]);
  assert.match(renderSimulationMarkdown(r), /\| drift_ms \| tcxo_ppm \* 1e-6 \* holdover_s \* 1000 \| 14\.4 \| ms/);
});

test("spice results feed the checks", async () => {
  const out: SimulationOutput = { ...OFFLINE_SIMULATION, spice: { purpose: "RC", deck: "R1 a b 1k\n.tran 1u 1m\n.meas tran tau WHEN v(b)=0.6" },
    quantities: [{ name: "tau_ms", expression: "spice_tau * 1000", unit: "ms", meaning: "measured", source: "computed" }],
    checks: [{ id: "C1", description: "under 2 ms", expression: "tau_ms < 2", requirement_ref: null }] };
  const model: LanguageModel = { async generate() { return { output: out as never, assistantMessage: { role: "assistant", content: "" }, usage: { model: "m", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } }; } };
  const r = await generateSimulation({ projectContext: "x", task: { key: "k", title: "t", description: null }, requirements: [], acceptanceTests: [], upstream: [], reviewNotes: [], spiceAvailable: true },
    model, async () => ({ ok: true, stage: "done", problems: [], measures: { tau: 0.001 }, ngspice: "42" }));
  assert.equal(r.values.tau_ms, 1);
  assert.equal(r.checks[0]!.passed, true);
});
