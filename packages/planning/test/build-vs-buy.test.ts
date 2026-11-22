import { test } from "node:test";
import assert from "node:assert/strict";
import { buildVsBuyStudy, matchModules, rankOptions, type CatalogModule, type Need } from "../src/index.ts";

const mod = (o: Partial<CatalogModule>): CatalogModule => ({ id: o.name!, kind: "radio_module", manufacturer: "M", mpn: o.name!.toUpperCase(), status: "draft", lifecycle: "active",
  interfaces: [], radios: [], supply: {}, dimensions_mm: {}, certifications: [], ...o } as CatalogModule);
const need: Need = { title: "Wireless link", kind: "radio_module", interfaces: ["UART"], radios: ["Wi-Fi", "BLE"], supply_v: 3.3, max_dims_mm: { x: 30, y: 20 }, regions: ["FCC", "CE/RED"], quantity: 500 };

test("modules are matched by code: misses are reasons, missing catalog data is unknown, never assumed", () => {
  const ms = matchModules(need, [
    mod({ name: "good", interfaces: ["UART", "SPI"], radios: ["802.11 b/g/n", "Bluetooth LE"], supply: { v_min: 3.0, v_max: 3.6 }, dimensions_mm: { x: 18, y: 25.5 },
          certifications: [{ regime: "FCC", id: "X1" }, { regime: "RED", id: "Y1" }], status: "verified" }),
    mod({ name: "too-big", interfaces: ["UART"], radios: ["WiFi", "BLE"], supply: { v_min: 3, v_max: 3.6 }, dimensions_mm: { x: 40, y: 25 }, certifications: [{ regime: "FCC", id: "a" }, { regime: "CE", id: "b" }] }),
    mod({ name: "5v-only", interfaces: ["UART"], radios: ["WiFi", "BLE"], supply: { v_min: 4.5, v_max: 5.5 }, dimensions_mm: { x: 20, y: 20 }, certifications: [{ regime: "FCC", id: "a" }] }),
    mod({ name: "sparse", radios: ["WiFi", "BLE"] }),
    mod({ name: "a-som", kind: "som" }),
  ]);
  const by = new Map(ms.map((m) => [m.module.name, m]));
  assert.equal(by.has("a-som"), false, "other kinds are not candidates");
  assert.deepEqual(by.get("good")!.misses, []);
  assert.deepEqual(by.get("too-big")!.misses, ["40 x 25 mm does not fit 30 x 20 mm"]);
  assert.match(by.get("5v-only")!.misses.join(), /does not accept the 3.3 V rail.*CE\/RED certification/);
  assert.deepEqual(by.get("sparse")!.misses, []);
  assert.deepEqual(by.get("sparse")!.unknown, ["interfaces (UART)", "supply range (needs to accept 3.3 V)", "size", "FCC certification", "CE/RED certification"]);
  assert.equal(ms[0]!.module.name, "good", "fitting and known first");

  const study = buildVsBuyStudy(need, ms);
  assert.deepEqual(study.options.map((o) => o.key), ["good", "sparse", "custom"], "modules that miss a constraint are left out; custom is always there");
  assert.match(study.context, /Catalog modules that do not fit: (too-big|5v-only)/);
  assert.equal(study.scores.good!.certification_effort!.value, 5);
  assert.equal(study.scores.good!.nre!.value, 24 * 120 + 3000);
  assert.equal(study.scores.custom!.nre!.value, 160 * 120 + 15000);
  assert.equal(study.scores.sparse!.meets_requirements!.value, null);
  const r = rankOptions(study.criteria, study.options, study.scores);
  assert.equal(r.winner, "good", "the certified module beats a chip-down radio on these criteria");
});
