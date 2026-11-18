import { test } from "node:test";
import assert from "node:assert/strict";
import { checkFeasibility } from "../src/index.ts";

const reqs = [
  { ref_code: "REQ-PWR-001", kind: "power", text: "The slate shall run for 10 hours on its rechargeable Li-ion battery.", status: "confirmed" },
  { ref_code: "REQ-IF-001", kind: "interface", text: "The slate shall sync timecode over Bluetooth LE.", status: "confirmed" },
  { ref_code: "REQ-IF-002", kind: "interface", text: "The slate shall have a 3.5 inch touchscreen.", status: "confirmed" },
  { ref_code: "REQ-ENV-001", kind: "environmental", text: "It shall operate from -20 °C to 50 °C.", status: "confirmed" },
  { ref_code: "REQ-MEC-001", kind: "mechanical", text: "The housing shall feel robust.", status: "ambiguous" },
  { ref_code: "REQ-FUN-001", kind: "functional", text: "The slate shall be easy to use.", status: "confirmed" },
  { ref_code: "REQ-X-001", kind: "other", text: "It shall stream HDMI video.", status: "rejected" },
];

test("rules fire on requirement text and intake, citing what triggered them", () => {
  const { findings } = checkFeasibility({ regions: ["US", "EU"], quantity: 500, target_unit_cost: 120, power_source: "Li-ion 1S" }, reqs);
  const by = new Map(findings.map((f) => [f.rule_key, f]));
  assert.deepEqual(by.get("battery-lithium")!.requirement_refs, ["REQ-PWR-001"]);
  assert.ok(by.get("battery-lithium")!.evidence.some((e) => e.ref === "intake"), "the intake's power source counts too");
  assert.equal(by.get("radio-intentional")!.category, "regulatory");
  assert.match(by.get("radio-intentional")!.evidence[0]!.excerpt, /Bluetooth LE/);
  assert.ok(by.has("display-oem") && by.has("battery-life"));
  assert.ok(!by.has("temperature-range"), "-20 °C is inside the commercial-ish range this rule ignores");
  assert.ok(!by.has("high-speed"), "rejected requirements are ignored");
  assert.deepEqual(by.get("requirements-ambiguous")!.requirement_refs, ["REQ-MEC-001"]);
  assert.deepEqual(by.get("requirements-untestable")!.requirement_refs, ["REQ-IF-001", "REQ-FUN-001"]);
  assert.ok(!by.has("markets-unknown") && !by.has("cost-target-unknown"));
});

test("intake gaps are listed and leave regulatory and cost risks open", () => {
  const { findings, gaps } = checkFeasibility(null, [{ ref_code: "REQ-1", text: "Operate at 85 °C in a vehicle.", status: "confirmed" }]);
  assert.deepEqual(gaps, ["intended use", "target markets (regions)", "first production quantity", "target unit cost",
                          "maximum dimensions", "power source", "target standards"]);
  const keys = findings.map((f) => f.rule_key);
  for (const k of ["markets-unknown", "cost-target-unknown", "regulated-domain", "temperature-range"]) assert.ok(keys.includes(k), k);
});

test("the same inputs give the same findings", () => {
  assert.deepEqual(checkFeasibility({ regions: ["US"] }, reqs), checkFeasibility({ regions: ["US"] }, reqs));
});
