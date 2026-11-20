/**
 * How Flux's real exports differ from its documentation (found on a real project's files; reproduced here with
 * invented data): eight BOM variants per export, IPC-D-356 pin names cut to four characters, parts numbered in one
 * export and named in the other, ODB++ in a ZIP without "odb" in its name, an IDF board file, and design notes in
 * the Flux-format BOM.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { zipSync } from "fflate";
import { buildInventory, reconcilePins, compareConnectivity, parseEdif, parseIpc356, runAudit, type Upload } from "../src/index.ts";
import { parseIdf, parseOdb } from "../src/parsers/board.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const MTIME = new Date(Date.UTC(2026, 10, 20));
const rec = (net: string, ref: string, pin: string) => `327${net.padEnd(14).slice(0, 14)}   ${ref.padEnd(6).slice(0, 6)}-${pin.padEnd(4).slice(0, 4)}       A01X-030947Y-010857X0291Y1098R090 S2`;

// Schematic: a debug header (named pins, one name repeated with _2) and an oscillator (named pins).
const EDIF = `(edif board (edifVersion 2 0 0) (edifLevel 0) (keywordMap (keywordLevel 0))
 (library work (edifLevel 0) (technology (numberDefinition))
  (cell board (cellType GENERIC) (view netlist (viewType NETLIST) (interface) (contents
   (instance J1 (viewRef netlist (cellRef hdr))) (instance Y1 (viewRef netlist (cellRef osc))) (instance U1 (viewRef netlist (cellRef mcu)))
   (net TC_3V3 (joined (portRef VTref (instanceRef J1)) (portRef VDD (instanceRef Y1)) (portRef OE (instanceRef Y1)) (portRef VDD (instanceRef U1))))
   (net GND (joined (portRef GND (instanceRef J1)) (portRef GND_2 (instanceRef J1)) (portRef GNDDetect (instanceRef J1)) (portRef GND (instanceRef Y1)) (portRef VSS (instanceRef U1))))
   (net TC_RST_N (joined (portRef (rename &_RESET_ "~RESET~") (instanceRef J1)) (portRef NRST (instanceRef U1))))
   (net CLK (joined (portRef CLK (instanceRef Y1)) (portRef PH0 (instanceRef U1))))
  )))))`;
// Layout: names cut to four characters, GND repeated, the oscillator by pad number.
const D356 = ["P  JOB   input", "P  UNITS CUST 0", "P  VER   IPC-D-356A",
  rec("TC_3V3", "J1", "VTref"), rec("GND", "J1", "GND"), rec("GND", "J1", "GND"), rec("GND", "J1", "GNDDetect"), rec("TC_RST_N", "J1", "~RESET~"),
  rec("N/C", "J1", "NC/TDI"), rec("TC_3V3", "Y1", "1"), rec("TC_3V3", "Y1", "9"), rec("GND", "Y1", "4"), rec("CLK", "Y1", "6"), rec("N/C", "Y1", "2"),
  rec("TC_3V3", "U1", "VDD"), rec("GND", "U1", "VSS"), rec("TC_RST_N", "U1", "NRST"), rec("CLK", "U1", "PH0"), "999"].join("\n");

const BOM_HEAD = "Designator,Quantity,Specification,Role,Role Details,Manufacturer Part Number,LCSC Part Number,Manufacturer Name,Package,Functional Group,Design Note";
const FLUX_BOM = [BOM_HEAD,
  `"J1","1","Connector","SWD debug","Service connector","FTSH-105-01-L-DV-007-K","","Samtec","","MCU","Keyed 10-pin 0.05in"`,
  `"U1","1","Microcontroller","Timecode MCU","Autonomous LTC","STM32L476RGT6","","STMicroelectronics","LQFP-64","MCU","Per DS10198"`,
  `"Y1","1","Oscillator","Clock","10 MHz TCXO","SiT5356AI-FQ-33E0-10.000000","C123","SiTime","","CLOCK",""`].join("\r\n");
const ADV_BOM = "Designator,Quantity,Description\r\nJ1,1,Connector\r\nU1,1,MCU\r\nY1,1,Oscillator\r\n";
const PNP = "Designator,Layer,Rotation,Mid X,Mid Y\r\n\"J1\",\"Top\",0,\"5mm\",\"40mm\"\r\n\"U1\",\"Top\",0,\"60mm\",\"50mm\"\r\n\"Y1\",\"Top\",0,\"80mm\",\"50mm\"\r\n";

function odb(routed: boolean): Uint8Array {
  const layer = (row: number, type: string, name: string) => `LAYER {\n    ROW=${row}\n    CONTEXT=BOARD\n    TYPE=${type}\n    NAME=${name}\n}\n`;
  const pads = "UNITS=MM\n#\nF 2\n$0 rect740.0x2790.0\nP 15.46 -119.54 0 P 0 8 90.0 ;0=0,1\nP 15.46 -120.81 0 P 0 8 90.0 ;0=0,1\n" + (routed ? "L 15.46 -119.54 20 -119.54 r200 P 0\n" : "");
  return zipSync({
    "matrix/matrix": enc(`STEP {\n    COL=1\n    NAME=PCB\n}\n${layer(1, "SILK_SCREEN", "F.SILKS")}${layer(2, "SIGNAL", "F.CU")}${layer(3, "DIELECTRIC", "D1")}${layer(4, "SIGNAL", "IN1.CU")}${layer(5, "POWER_GROUND", "IN2.CU")}${layer(6, "SIGNAL", "B.CU")}${layer(7, "DOCUMENT", "DWGS.USER")}`),
    "misc/info": enc("UNITS=MM\nODB_SOURCE=flux.ai\n"),
    "steps/pcb/profile": enc("UNITS=MM\n#\nS P 0\nOB 170.0 -10.0 I\nOS 170.0 -10.0\nOS 170.0 -110.0\nOS 10.0 -110.0\nOS 10.0 -10.0\nOE\nSE\n"),
    "steps/pcb/layers/f.cu/features": enc(pads), "steps/pcb/layers/b.cu/features": enc("UNITS=MM\nF 0\n"),
    "steps/pcb/eda/data": enc("# eda\n"),
  }, { mtime: MTIME });
}
const IDF = ".HEADER\nBOARD_FILE 3.0 \"Flux\" 11/20/26.21:11:37 1\nBoard MM\n.END_HEADER\n\n.BOARD_OUTLINE ECAD\n1.6\n0 -80 -50 0\n0 80 -50 0\n0 80 50 0\n0 -80 50 0\n0 -80 -50 0\n.END_BOARD_OUTLINE\n\n.DRILLED_HOLES\n3.2 -75 -45 PTH BOARD MTG ECAD\n.END_DRILLED_HOLES\n";

function bundle(routed = false): Upload[] {
  const bom = zipSync({ "bom/board-BOM-AdvancedCircuits.csv": enc(ADV_BOM), "bom/board-BOM-Flux.csv": enc(FLUX_BOM), "bom/board-BOM-JLCPCB.csv": enc("Comment,Designator,Footprint,LCSC Part #\r\n") }, { mtime: MTIME });
  return [
    { name: "board.edif", revision: "r1", data: enc(EDIF) }, { name: "board.d356", revision: "r1", data: enc(D356) },
    { name: "board-BOM.zip", revision: "r1", data: bom }, { name: "board-PickandPlace.zip", revision: "r1", data: zipSync({ "pnp/board-PickandPlace-JLCPCB.csv": enc(PNP) }, { mtime: MTIME }) },
    { name: "board.zip", revision: "r1", data: odb(routed) }, { name: "board - IDF.zip", revision: "r1", data: zipSync({ "Layout.emn": enc(IDF), "Layout.emp": enc(".HEADER\nLIBRARY_FILE 3.0 \"Flux\" x 1\n.END_HEADER\n") }, { mtime: MTIME }) },
  ];
}

test("pin names cut to four characters, repeated names and numbered pads match the schematic", () => {
  const sch = parseEdif("s.edif", EDIF).nets!, lay = parseIpc356("l.d356", D356).nets!;
  assert.ok([...lay.get("GND")!].includes("J1.GND#2"), "the repeated GND record is kept apart");
  const raw = compareConnectivity(sch, lay);
  assert.ok(raw.missing.length > 0, "without matching, the names do not line up");
  const matched = reconcilePins(sch, lay);
  assert.deepEqual(matched.byNet, ["Y1"], "the oscillator is matched by net and reported");
  assert.deepEqual(compareConnectivity(sch, matched.lay), { opens: [], shorts: [], missing: [], extra: [] });
  // A real fault still shows: the reset pin moved to the clock net.
  const broken = parseIpc356("l.d356", D356.replace(rec("TC_RST_N", "J1", "~RESET~"), rec("CLK", "J1", "~RESET~"))).nets!;
  const cmp = compareConnectivity(sch, reconcilePins(sch, broken).lay);
  assert.ok(cmp.shorts.some((s) => s.layout_net === "CLK") || cmp.missing.length || cmp.extra.length, "a moved pin is still caught");
});

test("ODB++ without 'odb' in the name, IDF, and routing", () => {
  const { files } = buildInventory(bundle());
  assert.equal(files.find((f) => f.path === "board.zip")?.kind, "odbpp", "an ODB++ job is recognised by its matrix and kept whole");
  assert.ok(!files.some((f) => f.path.startsWith("board.zip!/")), "not unpacked into loose files");
  assert.equal(files.find((f) => f.path.endsWith("Layout.emn"))?.kind, "idf");
  const o = parseOdb("board.zip", odb(false));
  assert.deepEqual(o.board, { copper_layers: 4, layer_names: ["f.cu", "in1.cu", "in2.cu", "b.cu"], width_mm: 160, height_mm: 100 });
  assert.deepEqual(o.meta?.copper, { pads: 2, tracks: 0, surfaces: 0 });
  assert.equal((parseOdb("board.zip", odb(true)).meta?.copper as { tracks: number }).tracks, 1);
  const i = parseIdf("Layout.emn", IDF)!;
  assert.deepEqual(i.board, { thickness_mm: 1.6, width_mm: 160, height_mm: 100, holes: [{ d_mm: 3.2, x_mm: -75, y_mm: -45 }] });
  assert.equal(parseIdf("Layout.emp", ".HEADER\nLIBRARY_FILE 3.0\n.END_HEADER\n"), null, "library files carry no board");
});

test("the audit of a Flux-shaped export: Flux BOM chosen, design notes kept, no false blocker, unrouted layout flagged", () => {
  const r = runAudit({ uploads: bundle(), revisions: [{ label: "r1", date: "2026-11-20" }] });
  const c = r.current!;
  const u1 = c.components.find((x) => x.designator === "U1")!;
  assert.equal(u1.mpn, "STM32L476RGT6", "the Flux-format BOM is read, not the AdvancedCircuits one without part numbers");
  assert.deepEqual(u1.design, { role: "Timecode MCU", details: "Autonomous LTC", note: "Per DS10198", group: "MCU", datasheet: null, specification: "Microcontroller" });
  assert.deepEqual(c.components.find((x) => x.designator === "Y1")!.suppliers, { LCSC: "C123" });
  assert.equal(r.summary.blockers, 0);
  assert.ok(r.findings.some((f) => f.title === "Layout connectivity matches the schematic netlist" && /no tracks yet/.test(f.detail)));
  assert.ok(r.findings.some((f) => f.title === "The layout is not routed"));
  assert.ok(r.migration.some((m) => m.title === "Route the board"));
  assert.deepEqual({ w: c.board.width_mm, h: c.board.height_mm, t: c.board.thickness_mm, l: c.board.copper_layers, src: c.board.sources }, { w: 160, h: 100, t: 1.6, l: 4, src: ["ODB++", "IDF"] });
  assert.ok(c.power_rails.some((p) => p.net === "TC_3V3"), "a rail with a domain prefix is recognised");
  const routed = runAudit({ uploads: bundle(true), revisions: [{ label: "r1" }] });
  assert.ok(!routed.findings.some((f) => f.title === "The layout is not routed"));
});
