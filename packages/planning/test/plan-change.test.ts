import { test } from "node:test";
import assert from "node:assert/strict";
import { applyPlanChange, describePlanChange, type PlanTaskPayload } from "../src/plan-change.ts";

const t = (key: string, up: string[] = []): PlanTaskPayload => ({ key, title: key.toUpperCase(), discipline: "schematic", description: null, required_tools: [],
  acceptance_tests: [], approval_required: false, approval_reason: null, risk_level: "medium", estimated_hours: null, upstream_keys: up, requirement_refs: [] });
const plan = [t("arch"), t("sch", ["arch"]), t("pcb", ["sch"]), t("fab", ["pcb"])];
const base = { task_key: null, discipline: null, description: "", after_key: null, reason: "asked in chat" };

test("add after a task keeps dependency order and makes a unique key", () => {
  const out = applyPlanChange(plan, { ...base, action: "add_task", title: "SCH", discipline: "verification", description: "Peer review", after_key: "sch" });
  assert.deepEqual(out.map((x) => x.key), ["arch", "sch", "sch-2", "pcb", "fab"]);
  assert.deepEqual(out[2]!.upstream_keys, ["sch"]);
  assert.equal(out[2]!.approval_required, true);
  assert.equal(plan.length, 4, "the input is not changed");
  assert.deepEqual(applyPlanChange(plan, { ...base, action: "add_task", title: "Drop test" }).map((x) => x.key).at(-1), "drop-test");
});

test("change and remove", () => {
  const ch = applyPlanChange(plan, { ...base, action: "change_task", task_key: "pcb", title: "", discipline: "pcb_layout" });
  assert.equal(ch[2]!.title, "PCB");
  assert.equal(ch[2]!.discipline, "pcb_layout");
  const rm = applyPlanChange(plan, { ...base, action: "remove_task", task_key: "pcb", title: "PCB" });
  assert.deepEqual(rm.map((x) => [x.key, x.upstream_keys]), [["arch", []], ["sch", ["arch"]], ["fab", ["sch"]]]);
  assert.throws(() => applyPlanChange(plan, { ...base, action: "remove_task", task_key: "nope", title: "" }), /there is no task nope/);
  assert.throws(() => applyPlanChange(plan, { ...base, action: "add_task", title: "x", after_key: "nope" }), /no task nope to follow/);
  assert.throws(() => applyPlanChange([t("only")], { ...base, action: "remove_task", task_key: "only", title: "" }), /at least one task/);
  assert.equal(describePlanChange({ ...base, action: "remove_task", task_key: "pcb", title: "PCB" }), 'Remove pcb ("PCB")');
});
