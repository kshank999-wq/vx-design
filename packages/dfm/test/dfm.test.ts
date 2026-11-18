import { test } from "node:test";
import assert from "node:assert/strict";
import { boardFactsFromFabCheck, checkBoard, checkEnclosure, parseRules, TEMPLATES } from "../src/index.ts";

const fabCheck = {
  board: { width_mm: 50, height_mm: 30, copper_layers: 2, min_track_mm: 0.2, min_drill_mm: 0.3 },
  gerbers: { min_drill_mm: 0.3 },
  parts: [
    { footprint: "Resistor_SMD:R_0402_1005Metric", side: "top", smd: true },
    { footprint: "Capacitor_SMD:C_0603_1608Metric", side: "top", smd: true },
    { footprint: "Connector_PinHeader_2.54mm:PinHeader_1x04_P2.54mm_Vertical", side: "top", smd: false },
    { footprint: "Package_TO_SOT_SMD:SOT-23", side: "bottom", smd: true },
  ],
};
const profile = { clearance_mm: 0.2, thickness_mm: 1.6, finish: "HASL (lead-free)" };
const rules = (key: string) => TEMPLATES.find((t) => t.key === key)!.rules;

test("board facts come from the fab check file and the profile it was built with", () => {
  const b = boardFactsFromFabCheck(fabCheck, profile);
  assert.deepEqual(b, { width_mm: 50, height_mm: 30, copper_layers: 2, min_track_mm: 0.2, min_clearance_mm: 0.2, min_drill_mm: 0.3,
    thickness_mm: 1.6, finish: "HASL (lead-free)", bottom_parts: true, through_hole: true, bga: false, smallest_passive: "0402" });
});

test("bare PCB: every limit compared, verdict fits", () => {
  const r = checkBoard("pcb_fab", rules("jlcpcb-2l"), boardFactsFromFabCheck(fabCheck, profile));
  assert.equal(r.verdict, "fits");
  assert.deepEqual(r.items.map((i) => `${i.check}:${i.status}`), ["Layer count:pass", "Track width:pass", "Clearance:pass",
    "Smallest drill:pass", "Smallest side:pass", "Board size:pass", "Thickness:pass", "Surface finish:pass"]);
});

test("a finer fab limit fails with the design value and the limit side by side", () => {
  const r = checkBoard("pcb_fab", { ...rules("oshpark-2l"), min_drill_mm: 0.35, finishes: ["ENIG"] }, boardFactsFromFabCheck(fabCheck, profile));
  assert.equal(r.verdict, "does_not_fit");
  const drill = r.items.find((i) => i.check === "Smallest drill")!;
  assert.deepEqual([drill.status, drill.design, drill.limit], ["fail", "0.3 mm", "≥ 0.35 mm"]);
  assert.equal(r.items.find((i) => i.check === "Surface finish")!.status, "fail");
});

test("assembly: single-sided service refuses bottom-side parts; missing limits are unknown, not pass", () => {
  const r = checkBoard("pcb_assembly", rules("jlcpcb-smt"), boardFactsFromFabCheck(fabCheck, profile));
  assert.equal(r.items.find((i) => i.check === "Parts on both sides")!.status, "fail");
  assert.equal(r.items.find((i) => i.check === "Smallest passive")!.status, "pass");
  const sparse = checkBoard("pcb_assembly", { double_sided: true }, boardFactsFromFabCheck(fabCheck, profile));
  assert.equal(sparse.verdict, "incomplete");
  assert.ok(sparse.items.some((i) => i.status === "unknown" && i.limit === "not stated"));
});

test("board size fits in any orientation", () => {
  const b = boardFactsFromFabCheck({ board: { width_mm: 30, height_mm: 120, copper_layers: 2 } });
  assert.equal(checkBoard("pcb_fab", { max_board_mm: [150, 100] }, b).items.find((i) => i.check === "Board size")!.status, "pass");
  assert.equal(checkBoard("pcb_fab", { max_board_mm: [100, 100] }, b).items.find((i) => i.check === "Board size")!.status, "fail");
});

test("enclosure: wall, size, process and material", () => {
  const e = { process: "fdm", wall_mm: 2, dimensions_mm: [60, 40, 20] as [number, number, number], material: "PETG" };
  assert.equal(checkEnclosure("fdm", rules("generic-fdm"), e).verdict, "fits");
  const sla = checkEnclosure("sla", rules("generic-sla"), e);
  assert.equal(sla.verdict, "does_not_fit");
  assert.match(sla.items[0]!.note!, /designed for another process/);
  assert.equal(checkEnclosure("fdm", { min_wall_mm: 2.5 }, e).items.find((i) => i.check === "Wall thickness")!.status, "fail");
});

test("rules forms are parsed with the problems named", () => {
  assert.deepEqual(parseRules("pcb_fab", { min_track_mm: "0.1", layer_counts: "2, 4", max_board_mm: "400 × 500", finishes: "ENIG; HASL" }),
    { rules: { min_track_mm: 0.1, layer_counts: [2, 4], max_board_mm: [400, 500], finishes: ["ENIG", "HASL"] }, problems: [] });
  assert.deepEqual(parseRules("pcb_fab", { min_track_mm: "thin", max_board_mm: "400" }).problems,
    ['Minimum track width: "thin" is not a number', "Largest board: give 2 sizes, e.g. 400 × 500"]);
  assert.deepEqual(parseRules("pcb_assembly", { bga: "yes", smallest_passive: "0402" }).rules, { smallest_passive: "0402", bga: true });
});
