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
], spice: null, checks: [{ id: "C1", description: "half a frame at 24 fps", expression: "drift_ms <= 1000 / 24 / 2", requirement_ref: "REQ-TC-1", role: "requirement" }] });

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
    checks: [{ id: "C1", description: "under 2 ms", expression: "tau_ms < 2", requirement_ref: null, role: "requirement" }] };
  const model: LanguageModel = { async generate() { return { output: out as never, assistantMessage: { role: "assistant", content: "" }, usage: { model: "m", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } }; } };
  const r = await generateSimulation({ projectContext: "x", task: { key: "k", title: "t", description: null }, requirements: [], acceptanceTests: [], upstream: [], reviewNotes: [], spiceAvailable: true },
    model, async () => ({ ok: true, stage: "done", problems: [], measures: { tau: 0.001 }, ngspice: "42" }));
  assert.equal(r.values.tau_ms, 1);
  assert.equal(r.checks[0]!.passed, true);
});

test("a repair loop stops as soon as it stops making progress", async () => {
  const { ProgressTracker } = await import("../src/index.ts");
  const p = new ProgressTracker();
  assert.equal(p.check({ a: 1 }, ["x too wide", "y missing"]), null);
  assert.equal(p.check({ a: 2 }, ["x too wide"]), null, "fewer problems: progress");
  assert.match(p.check({ a: 3 }, ["x too wide"])!, /same 1 problem\(s\) as round 2/);
  const q = new ProgressTracker();
  q.check({ b: 1, a: 1 }, ["p"]);
  q.check({ a: 2 }, ["q"]);
  assert.match(q.check({ a: 1, b: 1 }, ["p"])!, /same output as round 1 with the same problems/, "an oscillation back to round 1; key order does not matter");
  const r = new ProgressTracker();
  r.check({ a: 1 }, ["routing left 2 unrouted"]);
  assert.equal(r.check({ a: 1 }, ["routing left 1 unrouted"]), null, "same input, different tool result: not stuck");
  // Wired into a real loop: identical problems twice ends after round 2, not after all repair rounds.
  let calls = 0;
  const model: LanguageModel = { async generate() { calls++; return { output: holdover(`bad_${calls}`) as never, assistantMessage: { role: "assistant", content: "" }, usage: { model: "m", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } }; } };
  const fixed: LanguageModel = { async generate() { calls++; return { output: holdover("missing_name") as never, assistantMessage: { role: "assistant", content: "" }, usage: { model: "m", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } }; } };
  calls = 0;
  await assert.rejects(generateSimulation({ projectContext: "x", task: { key: "k", title: "t", description: null }, requirements: [], acceptanceTests: [], upstream: [], reviewNotes: [], spiceAvailable: false },
    fixed, async () => { throw new Error("no"); }), /stopped early: round 2 returned the same output as round 1/);
  assert.equal(calls, 2);
  void model;
});

test("check roles: scenarios and stretch targets do not fail the task, but cannot hide a must", async () => {
  const { judgeChecks } = await import("../src/simulation.ts");
  const c = (id: string, ref: string | null, role: "requirement" | "stretch" | "scenario", passed: boolean) =>
    ({ id, description: id, expression: "x", requirement_ref: ref, role, passed, value: passed ? 1 : 0 });
  const reqs = [{ refCode: "REQ-MUST", priority: "must" }, { refCode: "REQ-SHOULD", priority: "should" }];
  const v = (checks: ReturnType<typeof c>[]) => Object.fromEntries(judgeChecks(checks, reqs).map((j) => [j.id, j.verdict]));
  // The holdover case: uncompensated baseline fails, compensated design passes the must, the should stretch is missed.
  assert.deepEqual(v([c("base", "REQ-MUST", "scenario", false), c("design", "REQ-MUST", "requirement", true), c("stretch", "REQ-SHOULD", "stretch", false)]),
    { base: "scenario", design: "pass", stretch: "short_of_stretch" });
  // A scenario with no requirement check beside it is the requirement check.
  assert.deepEqual(v([c("only", "REQ-MUST", "scenario", false)]), { only: "fail" });
  // "Stretch" on a must is a requirement.
  assert.deepEqual(v([c("s", "REQ-MUST", "stretch", false)]), { s: "fail" });
  // Older analyses without roles behave as before.
  assert.deepEqual(v([{ ...c("old", null, "requirement", false), role: undefined } as never]), { old: "fail" });
});
