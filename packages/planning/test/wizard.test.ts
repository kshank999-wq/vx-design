import { test } from "node:test";
import assert from "node:assert/strict";
import { suggestCompliance } from "../src/compliance.ts";
import { checkFeasibility } from "../src/feasibility.ts";
import { wizardIntake, wizardRequirements, type WizardAnswers } from "../src/wizard.ts";

const slate: WizardAnswers = {
  product: { purpose: "Show and send film timecode on set", users: "camera crews", settings: ["indoor", "outdoor"], quantity: 300, unit_cost: 85, currency: "USD", lifetime_years: 5 },
  markets: { regions: ["US", "EU"] },
  power: { source: "li_ion", battery_hours: 12, active_hours_per_day: 10, usb_c_charging: true },
  connectivity: { radios: ["Bluetooth LE"], radio_range_m: 30, wired: ["USB-C"], phone_app: true, display: "LED segment", display_size_in: 3, buttons: 3, audio: "none" },
  physical: { max_l_mm: 280, max_w_mm: 120, max_h_mm: 30, max_weight_g: 600, temp_min_c: -10, temp_max_c: 45, ip: "IP54", drop_m: 1.2, mounting: "handheld" },
  extras: { standards: ["SMPTE ST 12-1"], needs: "Readable in direct sunlight\n\nMust survive being clapped 2000 times a day" },
};

test("answers become requirements with a basis and stable keys", () => {
  const r = wizardRequirements(slate);
  const by = new Map(r.map((x) => [x.key, x]));
  assert.equal(by.get("battery_life")!.text, "The product shall run for at least 12 hours on one charge when used 10 hours a day.");
  assert.equal(by.get("battery_life")!.kind, "power");
  assert.equal(by.get("markets")!.text, "The product shall be lawful to sell in US and EU.");
  assert.equal(by.get("size")!.text, "The product shall fit within 280 × 120 × 30 mm.");
  assert.equal(by.get("temperature")!.text, "The product shall operate from -10 °C to 45 °C.");
  assert.equal(by.get("radio_bluetooth_le")!.text, "The product shall communicate over Bluetooth LE at up to 30 m.");
  assert.equal(by.get("ip")!.text, "The enclosure shall meet IP54 (IEC 60529).");
  assert.equal(by.get("std_smpte_st_12_1")!.kind, "regulatory");
  assert.deepEqual([by.get("need_1")!.text, by.get("need_2")!.text], ["Readable in direct sunlight.", "Must survive being clapped 2000 times a day."]);
  assert.ok(r.every((x) => x.text && x.acceptance_criteria && x.basis));
  assert.equal(new Set(r.map((x) => x.key)).size, r.length, "keys are unique");
  assert.deepEqual(wizardRequirements(slate), r, "deterministic");
});

test("blank answers give nothing; gaps are written as gaps", () => {
  assert.deepEqual(wizardRequirements({}), []);
  const r = wizardRequirements({ product: { settings: ["outdoor"] }, power: { source: "li_ion" } });
  assert.deepEqual(r.map((x) => [x.key, x.acceptance_criteria]), [
    ["battery_life", "Battery life target to be set (the wizard left it blank)."],
    ["ip", "IP rating chosen and recorded (the wizard left it blank)."],
  ]);
});

test("the intake feeds compliance suggestions and the feasibility check", () => {
  const intake = wizardIntake(slate);
  assert.equal(intake.max_dimensions, "280 × 120 × 30 mm");
  assert.equal(intake.power_source, "Rechargeable lithium battery, 12 h per charge, USB-C charging");
  assert.match(String(intake.intended_use), /Setting: Indoors, Outdoors/);
  const keys = suggestCompliance(intake as never).suggestions.map((s) => s.key);
  assert.ok(keys.includes("us_fcc_15c") && keys.includes("eu_red") && keys.includes("un38_3"));
  assert.deepEqual(wizardIntake({ power: { source: "usb" } }).radios, ["none"]);
  const reqs = wizardRequirements(slate).map((x, i) => ({ ref_code: `REQ-${i}`, kind: x.kind, text: x.text, acceptance_criteria: x.acceptance_criteria }));
  assert.ok(Array.isArray(checkFeasibility(intake as never, reqs).findings));
});
