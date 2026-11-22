import { test } from "node:test";
import assert from "node:assert/strict";
import { identifyPart, matchModelToPart, OfflineModel, stepNames, type LanguageModel } from "../src/index.ts";

const usage = { model: "m", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
const scripted = (out: object): LanguageModel => ({ async generate() { return { output: out as never, assistantMessage: { role: "assistant", content: "" }, usage }; } });
const TEXT = "RVT101HVHNWC00-B\n10.1\" IPS TFT with capacitive touch\nOrdering information: RVT101HVHNWC00-B, RVT101HVHNWC00-D (with bezel)";

test("the part number must appear in the datasheet; a listed variant that does is used instead", async () => {
  const ok = await identifyPart(TEXT, "rvt101.pdf", scripted({ mpn: "RVT101HVHNWC00B", manufacturer: "Riverdi", title: "10.1-inch display", subsystem: "display", specs: [], variants: [] }));
  assert.equal(ok.identity?.mpn, "RVT101HVHNWC00B", "punctuation differences are fine");
  const invented = await identifyPart(TEXT, "rvt101.pdf", scripted({ mpn: "RVT101-XYZ", manufacturer: null, title: "x", subsystem: "display", specs: [], variants: ["RVT101HVHNWC00-D"] }));
  assert.equal(invented.identity?.mpn, "RVT101HVHNWC00-D");
  const none = await identifyPart(TEXT, "x.pdf", scripted({ mpn: "NOPE-123", manufacturer: null, title: "x", subsystem: "other", specs: [], variants: [] }));
  assert.equal(none.identity, null);
  assert.match(none.problem!, /does not appear in the datasheet/);
});

test("offline reading: labelled part number, manufacturer, description, specs and subsystem", async () => {
  const r = await identifyPart("Riverdi display module\nPart number: RVT101HVHNWC00-B\nManufacturer: Riverdi\nDescription: 10.1 inch IPS TFT display with capacitive touch\nResolution: 1280 x 800\nSupply voltage: 3.3 V",
    "rvt101.pdf", new OfflineModel());
  assert.deepEqual({ ...r.identity, variants: undefined }, { mpn: "RVT101HVHNWC00-B", manufacturer: "Riverdi", title: "10.1 inch IPS TFT display with capacitive touch",
    subsystem: "display", specs: [{ name: "Resolution", value: "1280 x 800" }, { name: "Supply voltage", value: "3.3 V" }], variants: undefined });
});

test("models are matched to parts by the names inside them or their file names", () => {
  const step = new TextEncoder().encode("ISO-10303-21;\nHEADER;\nFILE_NAME('RVT101HVHNWC00-B_3D','2024-01-01',(''),(''),'','','');\nENDSEC;\nDATA;\n#1=PRODUCT('RVT101 display','RVT101HVHNWC00-B','',(#2));\nENDSEC;\nEND-ISO-10303-21;\n");
  assert.deepEqual(stepNames(step), ["RVT101HVHNWC00-B_3D", "RVT101 display", "RVT101HVHNWC00-B"]);
  const parts = [{ mpn: "RVT101HVHNWC00-B" }, { mpn: "SIT5356AI-FQ" }, { mpn: "ABC-12" }, { mpn: "ABC-123" }];
  assert.equal(matchModelToPart("model.step", stepNames(step), parts)?.mpn, "RVT101HVHNWC00-B");
  assert.equal(matchModelToPart("sit5356ai_fq.stp", [], parts)?.mpn, "SIT5356AI-FQ");
  assert.equal(matchModelToPart("abc-123.step", [], parts)?.mpn, "ABC-123", "the longest part number wins");
  assert.equal(matchModelToPart("bracket.step", [], parts), null);
  assert.deepEqual(stepNames(new TextEncoder().encode("solid x")), []);
});
