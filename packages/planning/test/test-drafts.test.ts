import { test } from "node:test";
import assert from "node:assert/strict";
import { draftProcedures, readLimits } from "../src/index.ts";

test("limits are read only from numbers written in the requirement", () => {
  assert.deepEqual(readLimits("The 3.3 V rail shall stay between 3.2 V and 3.4 V.").map(({ min, max, unit }) => ({ min, max, unit })), [{ min: 3.2, max: 3.4, unit: "V" }]);
  assert.deepEqual(readLimits("Battery life of at least 8 hours; standby current ≤ 50 uA").map(({ min, max, unit }) => ({ min, max, unit })),
                   [{ min: 8, max: undefined, unit: "h" }, { min: undefined, max: 50, unit: "µA" }]);
  assert.deepEqual(readLimits("Clock 48 ± 0.5 MHz").map(({ min, max }) => ({ min, max })), [{ min: 47.5, max: 48.5 }]);
  assert.deepEqual(readLimits("The board shall decode LTC reliably."), []);
});

test("drafts: one procedure per uncovered requirement, limits with their source, yes/no otherwise", () => {
  const d = draftProcedures([
    { ref_code: "REQ-PWR-001", kind: "power", text: "The 3.3 V rail shall stay between 3.2 V and 3.4 V." },
    { ref_code: "REQ-IF-002", kind: "interface", text: "The board shall decode LTC at 30 fps.", acceptance_criteria: "Decode a Tentacle source for 10 minutes without dropped frames." },
    { ref_code: "REQ-MEC-003", kind: "mechanical", text: "The board shall fit the enclosure." },
  ], new Set(["REQ-MEC-003"]));
  assert.equal(d.length, 2);
  assert.equal(d[0]!.stage, "bring_up");
  assert.deepEqual(d[0]!.measurements[0], { key: "req_pwr_001_1", label: "REQ-PWR-001: between 3.2 V and 3.4 V", kind: "numeric", unit: "V", min: 3.2, max: 3.4,
    requirement_ref: "REQ-PWR-001", basis: 'read from REQ-PWR-001: "between 3.2 V and 3.4 V"' });
  assert.equal(d[1]!.stage, "functional");
  assert.match(d[1]!.steps, /Acceptance criteria \(from the specification\): Decode a Tentacle/);
  assert.ok(d[1]!.measurements.some((m) => m.unit === "fps" || m.kind === "boolean"));
});
