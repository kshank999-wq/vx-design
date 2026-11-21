import { test } from "node:test";
import assert from "node:assert/strict";
import { checkAssembly, generateAssembly, OfflineModel, renderAssemblyPrompt, type AssemblyDraft, type AssemblyInput, type LanguageModel } from "../src/index.ts";

const input: AssemblyInput = {
  project: { name: "Slate", description: "Touchscreen slate" },
  made: [{ name: "Enclosure base", route: "prototype ASA (fdm) × 3; production Injection molding, PC/ABS" }, { name: "Front bezel", route: "prototype SLA" }],
  bought: [{ mpn: "RVT101HVHNWC00-B", manufacturer: "Riverdi", role: "10.1-inch touchscreen", subsystem: "display" }],
  boards: [{ name: "Main board", detail: "160 × 100 mm, 4 layers" }],
  enclosure: "FDM PETG, M3 heat-set inserts, 6 mm standoffs",
  requirements: [{ refCode: "REQ-MECH-001", text: "Survive a 1.2 m drop." }],
  figures: [{ code: "REF-1", title: "Front view", note: null }],
  guidance: null,
};

test("prompt lists every part to fit, tagged, and the figures that may be cited", () => {
  const p = renderAssemblyPrompt(input);
  assert.match(p, /^- \[made\] Enclosure base: prototype ASA/m);
  assert.match(p, /^- \[bought\] RVT101HVHNWC00-B \(Riverdi\): 10\.1-inch touchscreen \[display\]$/m);
  assert.match(p, /^- \[board\] Main board: 160 × 100 mm/m);
  assert.match(p, /^- REF-1: Front view$/m);
});

const step = (o: Partial<AssemblyDraft["steps"][number]>) => ({ title: "t", parts: [], fasteners: [], tools: [], instructions: ["do"], cautions: [], check: null, figure: null, minutes: 2, ...o });
const draft = (steps: AssemblyDraft["steps"]): AssemblyDraft => ({ title: "x", safety: [], tools: [], steps, final_test: [], assumptions: [], open_questions: [] });

test("checks: unfitted parts, unknown figures, fasteners without torque or reason", () => {
  const d = draft([step({ parts: [{ name: "Enclosure base", qty: 1 }, { name: "rvt101hvhnwc00b", qty: 1 }], figure: "REF-9",
    fasteners: [{ spec: "M3 × 6", qty: 4, torque_nm: null, torque_note: null }] })]);
  const p = checkAssembly(d, input);
  assert.match(p[0]!, /^not fitted in any step .*: Front bezel; Main board$/);
  assert.ok(p.some((x) => /cites figure REF-9/.test(x)));
  assert.ok(p.some((x) => /M3 × 6 has no torque and no reason/.test(x)));
});

test("a draft with problems goes back once, then passes", async () => {
  let calls = 0;
  const good = draft([step({ parts: ["Enclosure base", "Front bezel", "RVT101HVHNWC00-B", "Main board"].map((name) => ({ name, qty: 1 })), figure: "REF-1" })]);
  const model: LanguageModel = { async generate(req) {
    calls++;
    if (calls === 2) assert.match(String(req.messages.at(-1)!.content), /not fitted in any step/);
    return { output: (calls === 1 ? draft([step({})]) : good) as never, assistantMessage: { role: "assistant", content: "" },
             usage: { model: "m", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } };
  } };
  const r = await generateAssembly(input, model);
  assert.equal(r.rounds, 2);
  assert.deepEqual(r.remaining, []);
});

test("offline draft fits every listed part", async () => {
  const r = await generateAssembly(input, new OfflineModel());
  assert.deepEqual(r.remaining, []);
  assert.match(r.draft.steps[0]!.title, /heat-set inserts/);
  assert.equal(r.draft.steps[0]!.figure, "REF-1");
});

test("steps round-trip through the editing lines", async () => {
  const { partsToLines, fastenersToLines, linesToParts, linesToFasteners } = await import("../src/index.ts");
  const s = step({ parts: [{ name: "Front bezel", qty: 2 }], fasteners: [
    { spec: "M3 × 6 pan head", qty: 4, torque_nm: 0.4, torque_note: "into brass inserts" }, { spec: "M3 heat-set insert", qty: 4, torque_nm: null, torque_note: "pressed in" }] });
  assert.equal(partsToLines(s), "2 × Front bezel");
  assert.equal(fastenersToLines(s), "4 × M3 × 6 pan head @ 0.4 N·m (into brass inserts)\n4 × M3 heat-set insert @ none (pressed in)");
  assert.deepEqual(linesToParts(partsToLines(s)), s.parts);
  assert.deepEqual(linesToFasteners(fastenersToLines(s)), s.fasteners);
  assert.deepEqual(linesToParts("Gasket\n\n 3x Label "), [{ name: "Gasket", qty: 1 }, { name: "Label", qty: 3 }]);
  assert.deepEqual(linesToFasteners("2 x M2 screw"), [{ spec: "M2 screw", qty: 2, torque_nm: null, torque_note: null }]);
});
