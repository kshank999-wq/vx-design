import { test } from "node:test";
import assert from "node:assert/strict";
import { buildInventory, keepQuoted, parseBom, parseEdif, parseIpc356, parsePnp, parseProjectJson, renderReport, runAudit,
         splitDesignators, gerberExtents, compareConnectivity, historyDocuments, type HistoryInput } from "../src/index.ts";
import { fluxFixture } from "./fixture.ts";

const REVS = [{ label: "Rev A", date: "2026-10-02" }, { label: "Rev B", date: "2026-11-02" }, { label: "Rev C", date: "2026-11-09" }];

test("inventory unpacks nested ZIPs and classifies each export", () => {
  const { files, problems } = buildInventory(fluxFixture());
  assert.deepEqual(problems, []);
  const c = files.filter((f) => f.revision === "Rev C");
  const kind = (p: string) => c.find((f) => f.path.endsWith(p))?.kind;
  assert.equal(kind("project.json"), "flux_json");
  assert.equal(kind("schematic.edif"), "edif");
  assert.equal(kind("layout.d356"), "ipc356");
  assert.equal(kind("timecode-F_Cu.gbr"), "gerber");
  assert.equal(kind("timecode.drl"), "drill");
  assert.equal(kind("pick_and_place.csv"), "pnp_csv");
  assert.equal(kind("bom/bom.csv"), "bom_csv");
  assert.equal(kind("screenshot.png"), "image");
  assert.equal(kind("chat-export.md"), "text");
  assert.ok(c.find((f) => f.path === "timecode-revC.zip!/manufacturing.zip!/gerbers/timecode-Edge_Cuts.gbr"), "nested path kept");
  assert.ok(c.every((f) => /^[0-9a-f]{64}$/.test(f.sha256)));
});

test("parsers: designators, BOM, placement, IPC-D-356, EDIF, Gerber outline, project JSON", () => {
  assert.deepEqual(splitDesignators("R1, R2 R5-R7"), ["R1", "R2", "R5", "R6", "R7"]);
  const bom = parseBom("b.csv", 'Designator,Qty,MPN\n"R1,R2",2,RC0402\nC1,1,GRM\n');
  assert.deepEqual(bom.components!.map((c) => [c.designator, c.mpn]), [["R1", "RC0402"], ["R2", "RC0402"], ["C1", "GRM"]]);
  const p = parsePnp("p.csv", "Ref,PosX (mil),PosY (mil),Rot,Side\nU1,1000,500,90,bottom\nU2,10mm,5mm,0,top\n");
  assert.deepEqual(p.components!.map((c) => [c.designator, c.x_mm, c.y_mm, c.side]), [["U1", 25.4, 12.7, "bottom"], ["U2", 10, 5, "top"]]);
  const rec = (op: string, net: string, ref: string, pin: string) => `${op}${net.padEnd(14)}   ${ref.padEnd(6)}-${pin.padEnd(4)}M`;
  const d = parseIpc356("l.d356", ["P  NNAME1     A_VERY_LONG_NET_NAME", rec("327", "NNAME1", "U1", "1"), rec("327", "GND", "U1", "2"),
                                   rec("317", "GND", "VIA", ""), rec("327", "N/C", "U1", "3")].join("\n"));
  assert.deepEqual([...d.nets!.entries()].map(([n, s]) => [n, [...s]]), [["A_VERY_LONG_NET_NAME", ["U1.1"]], ["GND", ["U1.2"]], ["N/C:U1.3", ["U1.3"]]]);
  const e = parseEdif("s.edif", '(edif x (library l (cell c (view v (contents (instance (rename U_1 "U1") (property MPN (string "ABC"))) (net (rename N1 "3V3") (joined (portRef (rename P1 "1") (instanceRef U_1)) (portRef VDD))))))))');
  assert.deepEqual(e.components!.map((c) => [c.designator, c.mpn]), [["U1", "ABC"]]);
  assert.deepEqual([...e.nets!.get("3V3")!], ["U1.1"]);
  assert.deepEqual(gerberExtents("%FSLAX46Y46*%\n%MOIN*%\nX0Y0D02*\nX2000000Y0D01*\nY1000000D01*\nM02*"), { width_mm: 50.8, height_mm: 25.4 });
  const j = parseProjectJson("p.json", JSON.stringify({ parts: [{ refdes: "r9", properties: [{ name: "Manufacturer Part Number", value: "X1" }] }], nets: [{ name: "N", pins: ["R9.1", "R9:2"] }] }));
  assert.deepEqual(j.components!.map((c) => [c.designator, c.mpn]), [["R9", "X1"]]);
  assert.deepEqual([...j.nets!.get("N")!], ["R9.1", "R9.2"]);
  assert.ok(j.notes.includes("no board section found"));
});

test("connectivity is compared by pins, not names", () => {
  const sch = new Map([["A", new Set(["U1.1", "R1.1"])], ["B", new Set(["U1.2", "R1.2"])]]);
  const lay = new Map([["NET1", new Set(["U1.1", "R1.1"])], ["NET2", new Set(["U1.2"])], ["NET3", new Set(["R1.2"])]]);
  const cmp = compareConnectivity(sch, lay);
  assert.deepEqual(cmp.opens, [{ net: "B", layout_nets: ["NET2", "NET3"] }]);
  assert.deepEqual(cmp.shorts, []);
  const merged = compareConnectivity(sch, new Map([["X", new Set(["U1.1", "R1.1", "U1.2", "R1.2"])]]));
  assert.deepEqual(merged.shorts, [{ layout_net: "X", schematic_nets: ["A", "B"] }]);
});

test("the audit finds the planted problems and never calls anything verified", () => {
  const chat = historyDocuments(buildInventory(fluxFixture()).files).find((d) => d.file.endsWith("chat-export.md"))!;
  const extracted: HistoryInput = {
    model: "test", offline: true, dropped_quotes: 0,
    decisions: [{ statement: "Use the AP2112K regulator", rationale: "MCP1700 dropout too high", file: chat.file, quote: "We decided to use the AP2112K because the MCP1700 dropout was too high", date: null }],
    claims: [
      { claim: "DRC passed on rev C", kind: "drc", file: chat.file, quote: "DRC passed with no errors on the rev C layout." },
      { claim: "LTC decode bench tested at 30 fps", kind: "bench_test", file: chat.file, quote: "Bench tested LTC decode at 30 fps" },
    ],
  };
  const r = runAudit({ uploads: fluxFixture(), revisions: REVS, history: extracted,
                       catalog: new Map([["STM32G031K8T6", { mpn: "STM32G031K8T6", manufacturer: "ST", lifecycle: "active" }]]) });
  const titles = r.findings.map((f) => `${f.severity}: ${f.title}`);
  const find = (re: RegExp) => r.findings.find((f) => re.test(f.title));

  const conn = find(/layout does not match the schematic/)!;
  assert.equal(conn.severity, "blocker");
  assert.ok(conn.items!.some((i) => /net LTC_RX is split in the layout into LTC_RX, LTC_RX_STUB/.test(i)), conn.items!.join("\n"));
  assert.ok(conn.items!.some((i) => /pin J2\.2 \(GND\) is not connected in the layout/.test(i)));
  assert.deepEqual(find(/without a manufacturer part number/)!.items, ["D1 green 0402"]);
  assert.match(find(/conflicting part numbers/)!.items!.join(), /J1: USB4105-GF-A vs USB4110-GF-A/);
  assert.ok(find(/Designators do not match/)!.items!.includes("C2: not in the BOM"));
  assert.match(find(/referenced file\(s\) missing/)!.items![0]!, /models\/USB4105-GF-A.step/);
  assert.deepEqual(find(/made and then undone/)!.items, ["U2 mpn: AP2112K-3.3TRG1 → MCP1700T-3302E/TT → AP2112K-3.3TRG1 (Rev A → Rev B → Rev C)"]);
  assert.ok(!find(/Layer count differs|Board size differs/), titles.join("\n"));
  assert.ok(find(/screenshot/));

  const cur = r.current!;
  assert.equal(cur.revision, "Rev C");
  assert.equal(cur.board.copper_layers, 2);
  assert.equal(cur.enclosure.outline_mm, "50 × 30 × 1.6 mm");
  assert.deepEqual(cur.enclosure.mounting_holes, ["H1", "H2"]);
  assert.ok(cur.enclosure.edge_connectors.some((e) => /^J1: left edge/.test(e)));
  assert.deepEqual(cur.power_rails.map((p) => p.net).sort(), ["3V3", "GND", "VBUS"]);
  const u1 = cur.components.find((c) => c.designator === "U1")!;
  assert.equal(u1.status, "consistent");
  assert.deepEqual([...u1.sources].sort(), ["bom", "edif", "flux_json", "pnp"]);
  assert.ok(cur.components.every((c) => c.status !== ("verified" as never)));
  assert.equal(cur.components.find((c) => c.designator === "H1")!.status, "consistent", "mounting holes need no part number");

  const [ab, bc] = r.comparisons;
  assert.deepEqual(ab!.changed.map((c) => `${c.designator}.${c.field}`).sort(), ["R2.mpn", "R2.value", "U2.mpn"]);
  assert.ok(bc!.changed.some((c) => c.designator === "D1" && c.field === "mpn" && c.to === null));

  assert.equal(r.history.claims.find((c) => c.kind === "drc")!.status, "evidence_present_not_rerun");
  assert.equal(r.history.claims.find((c) => c.kind === "bench_test")!.status, "unverifiable");
  assert.ok(r.history.decisions.every((d) => d.status === "unverifiable"));
  assert.match(r.statement, /never assumed verified/);

  const plan = r.migration.map((m) => m.title);
  for (const t of ["Recover missing referenced files", "Resolve the schematic/layout differences", "Reconcile the BOM, placement and schematic",
                   "Choose and source the uncertain parts", "Rebuild the design in KiCad from the export", "Re-establish the claimed validations",
                   "Write the power budget", "Record the enclosure constraints", "Record the repeated decisions"]) assert.ok(plan.includes(t), `${t} in ${plan.join(" | ")}`);
  assert.ok(r.migration.every((m) => m.done_when && m.scope));
  assert.equal(r.summary.blockers, r.findings.filter((f) => f.severity === "blocker").length);

  const md = renderReport(r, "Smart Slate");
  assert.match(md, /# Flux audit: Smart Slate/);
  assert.match(md, /\| U1 \| STM32G031K8T6 \|/);
  assert.equal(JSON.stringify(runAudit({ uploads: fluxFixture(), revisions: REVS, history: extracted, catalog: new Map([["STM32G031K8T6", { mpn: "STM32G031K8T6", manufacturer: "ST", lifecycle: "active" }]]) })), JSON.stringify(r), "deterministic");
});

test("quotes must appear word for word in the source", () => {
  const docs = [{ file: "chat.md", text: "Sam:  DRC passed\nwith no errors." }];
  const { kept, dropped } = keepQuoted([{ file: "chat.md", quote: "DRC passed with no errors" }, { file: "chat.md", quote: "ERC passed with no errors" },
                                      { file: "other.md", quote: "DRC passed with no errors" }], docs);
  assert.equal(kept.length, 1);
  assert.equal(dropped, 2);
});
