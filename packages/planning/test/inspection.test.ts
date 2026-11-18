import { test } from "node:test";
import assert from "node:assert/strict";
import { enclosurePlan, inspectionCsv, isBottomTerminated, pcbaPlan, pitchMm } from "../src/inspection.ts";

const board = {
  board: { width_mm: 34, height_mm: 22, copper_layers: 2, holes: { plated: 3, nonplated: 4, vias: 6 }, min_drill_mm: 0.3 },
  parts: [
    { ref: "U1", value: "AP2112K", footprint: "Package_TO_SOT_SMD:SOT-23-5", side: "top", smd: true },
    { ref: "U2", value: "MCU", footprint: "Package_DFN_QFN:QFN-32-1EP_5x5mm_P0.5mm_EP3.45x3.45mm", side: "top", smd: true },
    { ref: "C1", value: "1u", footprint: "Capacitor_SMD:C_0603_1608Metric", side: "bottom", smd: true },
    { ref: "D1", value: "LED", footprint: "LED_SMD:LED_0603_1608Metric", side: "top", smd: true },
    { ref: "J1", value: "Header", footprint: "Connector_PinHeader_2.54mm:PinHeader_1x03_P2.54mm_Vertical", side: "top", smd: false },
    { ref: "H1", value: "M3", footprint: "MountingHole:MountingHole_3.2mm_M3", side: "top", smd: false },
  ],
};

test("footprint facts", () => {
  assert.equal(pitchMm("Package_DFN_QFN:QFN-32-1EP_5x5mm_P0.5mm_EP3.45x3.45mm"), 0.5);
  assert.equal(pitchMm("Connector_PinHeader_2.54mm:PinHeader_1x03_P2.54mm_Vertical"), 2.54);
  assert.equal(pitchMm("Capacitor_SMD:C_0603_1608Metric"), null);
  assert.ok(isBottomTerminated("Package_DFN_QFN:QFN-32-1EP_5x5mm_P0.5mm"));
  assert.ok(!isBottomTerminated("Package_TO_SOT_SMD:SOT-23-5"));
});

test("PCBA plan items follow the board's facts", () => {
  const items = pcbaPlan(board, { assembled: true, productionTest: { code: "TP-003", version: 2, title: "Jig test" } });
  const by = new Map(items.map((i) => [i.key, i]));
  assert.equal(by.get("outline")!.characteristic, "Board outline 34 × 22 mm");
  assert.match(by.get("outline")!.acceptance, /± 0\.2 mm \(typical routing tolerance; confirm with the fab\)/);
  assert.equal(by.get("holes")!.characteristic, "Holes: 3 plated, 4 non-plated, 6 vias; smallest 0.3 mm");
  assert.equal(by.get("polarity")!.characteristic, "Orientation of polarized parts: U1, U2, D1");
  assert.equal(by.get("fine_pitch")!.characteristic, "Bridges on fine-pitch parts (≤ 0.5 mm): U2");
  assert.equal(by.get("xray")!.characteristic, "Hidden joints under U2");
  assert.equal(by.get("through_hole")!.characteristic, "Through-hole joints: J1");
  assert.equal(by.get("bottom_side")!.characteristic, "Bottom-side parts after second reflow: C1");
  assert.equal(by.get("placement")!.characteristic, "5 components present, correct part and value", "mounting holes are not components");
  assert.equal(by.get("functional")!.method, "TP-003 v2 Jig test");
  assert.equal(new Set(items.map((i) => i.key)).size, items.length);
  // A bare-board plan stops at incoming inspection; a simple board has no X-ray or fine-pitch items.
  assert.ok(pcbaPlan(board, { assembled: false }).every((i) => i.stage === "incoming"));
  const simple = pcbaPlan({ ...board, parts: board.parts.filter((p) => p.ref !== "U2") });
  assert.ok(!simple.some((i) => i.key === "xray" || i.key === "fine_pitch"));
});

test("enclosure plan from the fit report, with the tolerance's source", () => {
  const items = enclosurePlan({ process: { label: "FDM" }, material: "PETG", dimensions_mm: { x: 64, y: 44, z: 24 }, spec: { wall_mm: 2 },
    mounting: { H1: { hole_mm: 4.2, boss_od_mm: 7 } }, openings: [{ ref: "J1", kind: "edge", side: "front", width_mm: 9.2, height_mm: 3.6 }, { ref: "SW1", kind: "top", diameter_mm: 6, error: undefined }] },
    { mm: 0.25, basis: "Print Farm's FDM rules" });
  const by = new Map(items.map((i) => [i.key, i]));
  assert.equal(by.get("overall")!.acceptance, "Each dimension ± 0.25 mm (Print Farm's FDM rules)");
  assert.equal(by.get("opening_j1")!.characteristic, "Opening for J1 (edge, front): 9.2 × 3.6 mm");
  assert.equal(by.get("opening_sw1")!.characteristic, "Opening for SW1 (top): ⌀6 mm");
  assert.equal(by.get("boss_h1")!.critical, true);
  assert.equal(by.get("material")!.characteristic, "Material: PETG, FDM");
});

test("CSV for suppliers quotes fields", () => {
  const csv = inspectionCsv([{ key: "a", stage: "in_process", characteristic: 'Holes "A"', method: "Gauge, pin", sample: "100%", acceptance: "ok", reference: "r", critical: true }]);
  assert.equal(csv, 'Stage,Characteristic,Method,Sample,Acceptance,Reference,Critical\r\n"in-process","Holes ""A""","Gauge, pin","100%","ok","r","yes"\r\n');
});
