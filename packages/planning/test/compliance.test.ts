import { test } from "node:test";
import assert from "node:assert/strict";
import { normaliseMarkets, suggestCompliance } from "../src/compliance.ts";

const keys = (r: ReturnType<typeof suggestCompliance>) => r.suggestions.map((s) => s.key);

test("markets: aliases, global, unknown", () => {
  assert.deepEqual(normaliseMarkets(["USA", "Europe", "Mars"]), { markets: ["US", "EU"], unknown: ["Mars"] });
  assert.equal(normaliseMarkets(["worldwide"]).markets.length, 6);
  assert.deepEqual(normaliseMarkets(["North America"]).markets, ["US", "CA"]);
});

test("a BLE Li-ion product for the US and EU", () => {
  const r = suggestCompliance({ regions: ["US", "EU"], radios: ["Bluetooth LE"], power_source: "Li-ion 1S 2000 mAh, USB-C charging",
                                intended_use: "Timecode slate for film sets" });
  assert.deepEqual(keys(r), ["us_fcc_15b", "us_fcc_15c", "eu_red", "eu_rohs", "eu_weee", "eu_reach", "eu_battery", "un38_3", "iec62133"]);
  const red = r.suggestions.find((s) => s.key === "eu_red")!;
  assert.ok(red.standards.includes("ETSI EN 300 328") && red.standards.includes("ETSI EN 301 489-17"));
  assert.equal(red.basis, "radios: Bluetooth LE");
  assert.ok(!keys(r).includes("eu_emc"), "RED covers EMC for radio equipment");
  assert.ok(!keys(r).includes("us_safety"), "USB-powered: no mains safety listing");
  assert.deepEqual(r.gaps, []);
});

test("no radio, mains powered, EU: EMC and LVD instead of RED", () => {
  const r = suggestCompliance({ regions: ["EU", "US"], radios: ["none"], power_source: "230 V mains, IEC C14 inlet" });
  assert.ok(keys(r).includes("eu_emc") && keys(r).includes("eu_lvd") && keys(r).includes("us_safety"));
  assert.ok(!keys(r).includes("eu_red") && !keys(r).includes("us_fcc_15c") && !keys(r).includes("un38_3"));
});

test("GNSS receive-only is not a transmitter; cellular adds carrier approval", () => {
  assert.ok(!keys(suggestCompliance({ regions: ["US"], radios: ["GPS"], power_source: "USB" })).includes("us_fcc_15c"));
  assert.ok(keys(suggestCompliance({ regions: ["US"], radios: ["LTE Cat-M1"], power_source: "USB" })).includes("cellular_carrier"));
});

test("missing facts are reported as gaps, not guessed", () => {
  const r = suggestCompliance({ regions: [], radios: [], power_source: "" });
  assert.equal(r.suggestions.length, 0);
  assert.equal(r.gaps.length, 3);
});

test("children's and medical uses are flagged", () => {
  const r = suggestCompliance({ regions: ["US"], radios: ["none"], power_source: "2× AA alkaline", intended_use: "Toy for kids aged 8+" });
  assert.ok(keys(r).includes("children"));
  assert.ok(!keys(r).includes("un38_3"), "alkaline cells are not lithium");
  assert.ok(keys(suggestCompliance({ regions: ["EU"], radios: ["none"], power_source: "USB", intended_use: "Patient monitor" })).includes("medical"));
});
