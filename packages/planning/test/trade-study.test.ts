import { test } from "node:test";
import assert from "node:assert/strict";
import { rankOptions, TRADE_TEMPLATES } from "../src/index.ts";

const t = TRADE_TEMPLATES.module_vs_custom!;
const scores = {
  module: { meets_requirements: { value: true }, unit_cost: { value: 9.5, basis: "DigiKey at 500 pcs" }, nre: { value: 2000 },
            time_to_prototype: { value: 3 }, certification_effort: { value: 5 }, board_area: { value: 300 }, supply_risk: { value: 4 } },
  custom: { meets_requirements: { value: true }, unit_cost: { value: 4.2 }, nre: { value: 25000 }, time_to_prototype: { value: 10 },
            certification_effort: { value: 1 }, board_area: { value: 180 }, supply_risk: { value: 3 } },
};

test("weighted ranking from normalised scores; the winner and its margin are explained by the parts", () => {
  const r = rankOptions(t.criteria, t.options, scores);
  assert.equal(r.winner, "module");
  assert.deepEqual(r.ranking.map((x) => [x.key, x.total]), [["module", 62.9], ["custom", 40.9]]);
  assert.equal(r.ranking[0]!.parts.unit_cost, 0, "the dearer option scores 0 on cost");
  assert.equal(r.ranking[0]!.parts.certification_effort, 1);
  assert.ok(r.complete);
  assert.equal(r.robust, false);
  assert.deepEqual(r.sensitive_to, [{ criterion: "Unit cost at the target quantity", change: "doubled", winner: "Custom design (chip-down)" }],
    "if unit cost mattered twice as much, the custom design would win");
});

test("a failed must-criterion rules an option out", () => {
  const r = rankOptions(t.criteria, t.options, { ...scores, module: { ...scores.module, meets_requirements: { value: false } } });
  assert.equal(r.winner, "custom");
  assert.deepEqual(r.ranking.find((x) => x.key === "module")!.excluded, ["Meets the requirements"]);
  assert.equal(r.ranking.find((x) => x.key === "module")!.total, null);
});

test("missing values are listed; a clear winner is reported as robust", () => {
  const clear = { ...scores, module: { ...scores.module, unit_cost: { value: 4.0 } } };
  const r = rankOptions(t.criteria, t.options, clear);
  assert.equal(r.winner, "module");
  assert.ok(r.robust && r.sensitive_to.length === 0);
  const gaps = rankOptions(t.criteria, t.options, { module: { meets_requirements: { value: true }, unit_cost: { value: 5 } }, custom: {} });
  assert.equal(gaps.complete, false);
  assert.ok(gaps.ranking.find((x) => x.key === "custom")!.missing.includes("Meets the requirements"));
});
