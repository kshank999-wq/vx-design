import { test } from "node:test";
import assert from "node:assert/strict";
import { autoFixPlan, generatePlan, revisePlan, ScriptedModel, validatePlan, type PlanOutput } from "../src/index.ts";

const reqs = [
  { refCode: "REQ-PWR-001", kind: "power", priority: "must", status: "confirmed", text: "Run 8 hours on battery." },
  { refCode: "REQ-PWR-002", kind: "power", priority: "must", status: "confirmed", text: "Charge over USB-C." },
  { refCode: "REQ-MEC-001", kind: "mechanical", priority: "must", status: "confirmed", text: "Survive a 1.2 m drop." },
  { refCode: "REQ-ENV-001", kind: "environmental", priority: "must", status: "confirmed", text: "Work at 50 °C in sun." },
];
const at = [{ description: "reviewed", method: "human_review" as const, validation_kind: null }];
const task = (key: string, discipline: string, refs: string[], upstream: string[] = [], extra: object = {}) => ({
  key, title: key, discipline, description: `${key} work`, upstream_keys: upstream, requirement_refs: refs, acceptance_tests: at,
  risk_level: "medium", required_tools: [], approval_required: false, approval_reason: null, estimated_hours: 4,
  basis: { mode: "new", sources: [], reason: "fresh", concerns: [], alternatives: [] }, ...extra,
}) as PlanOutput["tasks"][number];

// Everything a model gets wrong mechanically, in one plan.
const flawed = (): PlanOutput => ({
  summary: "Slate plan",
  tasks: [
    task("Architecture", "architecture", ["REQ-PWR-001", "REQ-XXX-999"], ["missing-task"], { basis: null }),
    task("power-budget", "power", ["REQ-PWR-001"], ["Architecture", "enclosure"]),
    task("enclosure", "enclosure", [], ["power-budget"], { acceptance_tests: [], basis: { mode: "adapt", sources: ["PW-9"], reason: "x", concerns: [], alternatives: [] } }),
    task("enclosure", "mechanical", []),
  ],
  deferred_requirements: [{ ref: "REQ-GONE-001", reason: "n/a" }],
  assumptions: [],
});
const ctx = { requirements: reqs, inputIds: ["PT-1", "PR-1"], mustAddress: [{ id: "PT-1", label: "BQ25895 battery charger (selected)" }, { id: "PR-1", label: "Hirose DM1AA microSD socket" }] };

test("mechanical plan failures are fixed in code, and each fix is listed", () => {
  const before = validatePlan(flawed(), reqs.map((r) => r.refCode), ctx.inputIds, ctx.mustAddress);
  for (const c of ["bad_key", "duplicate_key", "unknown_upstream", "unknown_requirement", "no_acceptance", "no_basis", "unknown_source", "basis_without_source", "cycle", "uncovered", "prior_work_ignored", "unknown_deferred"]) {
    assert.ok(before.some((p) => p.code === c) || c === "cycle" || c === "basis_without_source", `fixture has ${c}`);
  }
  const { plan, fixes } = autoFixPlan(flawed(), ctx);
  assert.deepEqual(validatePlan(plan, reqs.map((r) => r.refCode), ctx.inputIds, ctx.mustAddress), [], "the fixed plan passes every check");
  const byKey = new Map(plan.tasks.map((t) => [t.key, t]));
  assert.deepEqual([...byKey.keys()], ["architecture", "power-budget", "enclosure", "enclosure-2"]);
  assert.ok(byKey.get("power-budget")!.upstream_keys.includes("architecture"), "renamed link followed");
  const pe = byKey.get("power-budget")!.upstream_keys.includes("enclosure"), ep = byKey.get("enclosure")!.upstream_keys.includes("power-budget");
  assert.ok(pe !== ep, "exactly one link of the power-budget/enclosure loop removed");
  assert.ok(byKey.get("power-budget")!.requirement_refs.includes("REQ-PWR-002"), "a power requirement goes to the task holding its siblings");
  assert.ok(byKey.get("enclosure")!.requirement_refs.includes("REQ-ENV-001"), "an environmental requirement goes to the enclosure");
  assert.ok(byKey.get("enclosure-2")!.requirement_refs.includes("REQ-MEC-001") || byKey.get("enclosure")!.requirement_refs.includes("REQ-MEC-001"));
  assert.ok(byKey.get("power-budget")!.basis!.sources.includes("PT-1"), "the charger is cited by the power task");
  assert.equal(byKey.get("power-budget")!.basis!.mode, "adapt");
  assert.equal(byKey.get("enclosure")!.basis!.mode, "new", "adapt with no real source becomes new");
  assert.equal(byKey.get("enclosure")!.acceptance_tests[0]!.method, "human_review");
  assert.deepEqual(plan.deferred_requirements, []);
  for (const m of [/Task key "Architecture" is now "architecture"/, /used twice; the second is now "enclosure-2"/, /dropped link\(s\) to "missing-task"/, /dropped unknown requirement\(s\) REQ-XXX-999/,
    /closed a dependency loop/, /Placed by rule in "power-budget".*REQ-PWR-002/, /Cited by rule in "power-budget".*PT-1/, /no acceptance test/, /had no basis/, /REQ-GONE-001/]) {
    assert.ok(fixes.some((f) => m.test(f)), `fix listed: ${m}`);
  }
});

test("a flawed plan is accepted after one model call: no paid repair round", async () => {
  const model = new ScriptedModel([() => flawed()]);
  const r = await generatePlan(reqs, model, { inputIds: ctx.inputIds, mustAddress: ctx.mustAddress });
  assert.equal(model.calls.length, 1);
  assert.equal(r.attempts, 1);
  assert.ok(r.adjustments.some((a) => /Placed by rule/.test(a)));
});

test("what code cannot decide still goes back to the model", async () => {
  const replace = () => ({ ...flawed(), tasks: flawed().tasks.map((t, i) => (i === 1 ? { ...t, basis: { mode: "replace", sources: ["PR-1"], reason: "swap", concerns: [], alternatives: [] } } : t)) });
  const model = new ScriptedModel([replace, () => flawed()]);
  const r = await generatePlan(reqs, model, { inputIds: ctx.inputIds, mustAddress: ctx.mustAddress });
  assert.equal(model.calls.length, 2, "a replacement with no reason is the model's to explain");
  assert.match(JSON.stringify(model.calls[1]!.messages.at(-1)), /replaces earlier work/);
  assert.doesNotMatch(JSON.stringify(model.calls[1]!.messages.at(-1)), /not covered by any task/, "only what code could not fix is sent back");
  assert.equal(r.attempts, 2);
});

test("a plan update with a gap is fixed in code too", async () => {
  const prev = { version: 1, summary: "s", deferred: [], assumptions: [], tasks: autoFixPlan(flawed(), ctx).plan.tasks };
  const more = [...reqs, { refCode: "REQ-PWR-003", kind: "power", priority: "must", status: "confirmed", text: "Show battery level." }];
  const model = new ScriptedModel([() => ({ summary: "updated", changed_tasks: [], removed_tasks: [], deferred_requirements: [], assumptions: [] })]);
  const r = await revisePlan(prev, more, model, { changes: ["1 requirement added"], inputIds: ctx.inputIds, mustAddress: ctx.mustAddress });
  assert.equal(model.calls.length, 1);
  assert.ok(r.tasks.find((t) => t.key === "power-budget")!.requirementRefs.includes("REQ-PWR-003"));
});
