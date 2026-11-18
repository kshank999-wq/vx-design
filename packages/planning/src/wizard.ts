/**
 * S0 requirement wizard: plain-language questions about the product, turned into draft requirements with acceptance
 * criteria and into the project's intake facts. Deterministic: each requirement comes from one answer and says which
 * (its basis), and has a stable key so answering again updates it instead of adding a duplicate. Wording that adds a
 * test method or a typical target (a supply range, a test standard) says so in the acceptance criteria, for the team
 * to confirm before the requirement is confirmed.
 */
import type { RequirementKind } from "@vx/contracts";

export interface WizardAnswers {
  product?: { purpose?: string; users?: string; settings?: string[]; quantity?: number | null; unit_cost?: number | null; currency?: string;
              lifetime_years?: number | null };
  markets?: { regions?: string[]; other?: string };
  power?: { source?: string; battery_hours?: number | null; active_hours_per_day?: number | null; standby_days?: number | null; usb_c_charging?: boolean };
  connectivity?: { radios?: string[]; radio_range_m?: number | null; wired?: string[]; phone_app?: boolean; display?: string; display_size_in?: number | null;
                   buttons?: number | null; audio?: string };
  physical?: { max_l_mm?: number | null; max_w_mm?: number | null; max_h_mm?: number | null; max_weight_g?: number | null; temp_min_c?: number | null;
               temp_max_c?: number | null; ip?: string; drop_m?: number | null; mounting?: string; finish?: string };
  extras?: { standards?: string[]; needs?: string };
}

export interface WizardRequirement {
  key: string; kind: RequirementKind; priority: "must" | "should" | "may"; text: string; acceptance_criteria: string; basis: string;
}

export const WIZARD_STEPS = [
  { key: "product", title: "Product and use" }, { key: "markets", title: "Markets" }, { key: "power", title: "Power" },
  { key: "connectivity", title: "Connectivity and controls" }, { key: "physical", title: "Size and environment" }, { key: "extras", title: "Anything else" },
] as const;

export const POWER_SOURCES: Record<string, string> = {
  usb: "USB power (5 V)", wall_adapter: "External wall adapter", mains: "Mains AC, built in", li_ion: "Rechargeable lithium battery",
  primary_cells: "Replaceable batteries (AA, coin cell…)", poe: "Power over Ethernet", vehicle_12v: "Vehicle 12 V", other: "Other",
};
export const SETTINGS: Record<string, string> = {
  indoor: "Indoors", outdoor: "Outdoors", vehicle: "In a vehicle", industrial: "Industrial site", wearable: "Worn on the body",
  children: "Used by children", medical: "Medical or patient use",
};
export const IP_RATINGS = ["none", "IP54", "IP65", "IP67", "IP68"];

const has = (v: unknown): boolean => v != null && v !== "" && !(Array.isArray(v) && v.length === 0);
const n = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const listText = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
const sentence = (s: string) => { const t = s.trim().replace(/\s+/g, " "); return /[.!?]$/.test(t) ? t : `${t}.`; };

export function wizardRequirements(a: WizardAnswers): WizardRequirement[] {
  const out: WizardRequirement[] = [];
  const add = (r: WizardRequirement) => out.push(r);
  const p = a.product ?? {}, m = a.markets ?? {}, pw = a.power ?? {}, c = a.connectivity ?? {}, ph = a.physical ?? {}, x = a.extras ?? {};

  // Product and use
  if (has(p.purpose)) add({ key: "purpose", kind: "functional", priority: "must", text: `The product shall do the following for its users: ${sentence(p.purpose!)}`,
    acceptance_criteria: "Demonstrated to the product owner in the intended setting with a prototype.", basis: `Product: purpose${has(p.users) ? `; users: ${p.users}` : ""}` });
  const settings = p.settings ?? [];
  if (settings.includes("children")) add({ key: "children", kind: "regulatory", priority: "must",
    text: "The product shall meet the toy and children's product safety rules of its markets.",
    acceptance_criteria: "Applicable children's product regimes listed on the Compliance page and passed by an accredited lab.", basis: "Product: used by children" });
  if (settings.includes("medical")) add({ key: "medical", kind: "regulatory", priority: "must",
    text: "The product's medical device classification shall be determined before detailed design.",
    acceptance_criteria: "Written classification from a regulatory specialist recorded as a project decision.", basis: "Product: medical or patient use" });
  if (n(p.quantity)) add({ key: "quantity", kind: "manufacturing", priority: "must", text: `The design shall be manufacturable in a first production run of ${n(p.quantity)} units.`,
    acceptance_criteria: `A fab package and an assembly quote for ${n(p.quantity)} units from an approved manufacturer.`, basis: "Product: first production quantity" });
  if (n(p.unit_cost)) add({ key: "unit_cost", kind: "cost", priority: "must",
    text: `The unit cost shall not exceed ${n(p.unit_cost)} ${p.currency || "USD"} at a quantity of ${n(p.quantity) ?? "the first production run"}.`,
    acceptance_criteria: "Sourced BOM per-board cost plus assembly and enclosure, from current quotes, at or below the target.", basis: "Product: target unit cost" });
  if (n(p.lifetime_years)) add({ key: "lifetime", kind: "other", priority: "should", text: `The product shall have a design life of at least ${n(p.lifetime_years)} years.`,
    acceptance_criteria: "No part with a known end-of-life inside the design life without a recorded plan (lifecycle watch), and parts rated for the use.",
    basis: "Product: expected lifetime" });

  // Markets
  if (has(m.regions) || has(m.other)) {
    const where = [...(m.regions ?? []), ...(m.other ? [m.other.trim()] : [])];
    add({ key: "markets", kind: "regulatory", priority: "must", text: `The product shall be lawful to sell in ${listText(where)}.`,
      acceptance_criteria: "Every regulatory regime for these markets listed on the Compliance page, each passed (with the lab's report) or marked not applicable with a reason.",
      basis: "Markets" });
  }

  // Power
  const src = pw.source;
  if (src === "usb") add({ key: "power_usb", kind: "power", priority: "must", text: "The product shall run from USB power.",
    acceptance_criteria: "Works across 4.5 V to 5.5 V at its USB connector (a typical design target; confirm), drawing within the USB port's current.", basis: "Power: USB" });
  if (src === "wall_adapter") add({ key: "power_adapter", kind: "power", priority: "must", text: "The product shall run from an external wall adapter supplied with it.",
    acceptance_criteria: "Works across the adapter's rated output tolerance; the adapter is certified for each market.", basis: "Power: wall adapter" });
  if (src === "mains") add({ key: "power_mains", kind: "power", priority: "must", text: "The product shall run from mains AC power in its markets.",
    acceptance_criteria: "Works from 90 V to 264 V AC, 47 Hz to 63 Hz (a typical universal-input target; confirm against the markets); passes electrical safety tests.",
    basis: "Power: mains" });
  if (src === "poe") add({ key: "power_poe", kind: "power", priority: "must", text: "The product shall be powered over Ethernet.",
    acceptance_criteria: "Works from an IEEE 802.3af power-sourcing switch; total draw within its PoE class.", basis: "Power: PoE" });
  if (src === "vehicle_12v") add({ key: "power_vehicle", kind: "power", priority: "must", text: "The product shall run from a vehicle's 12 V system, including its transients.",
    acceptance_criteria: "Survives and works through supply transients at levels agreed from ISO 16750-2 / ISO 7637-2 (levels to confirm).", basis: "Power: vehicle 12 V" });
  if ((src === "li_ion" || src === "primary_cells") && n(pw.battery_hours)) {
    const duty = n(pw.active_hours_per_day);
    add({ key: "battery_life", kind: "power", priority: "must",
      text: `The product shall run for at least ${n(pw.battery_hours)} hours ${src === "li_ion" ? "on one charge" : "on one set of batteries"}${duty ? ` when used ${duty} hours a day` : ""}.`,
      acceptance_criteria: `Measured runtime from ${src === "li_ion" ? "full charge" : "fresh cells"} at 25 °C under the stated use is at least ${n(pw.battery_hours)} hours.`,
      basis: `Power: ${POWER_SOURCES[src]}, battery life` });
  } else if (src === "li_ion" || src === "primary_cells") add({ key: "battery_life", kind: "power", priority: "must",
    text: `The product shall run from ${src === "li_ion" ? "a rechargeable lithium battery" : "replaceable batteries"}.`,
    acceptance_criteria: "Battery life target to be set (the wizard left it blank).", basis: `Power: ${POWER_SOURCES[src]}` });
  if (n(pw.standby_days)) add({ key: "standby", kind: "power", priority: "should", text: `The product shall keep at least ${n(pw.standby_days)} days of standby on one charge.`,
    acceptance_criteria: "Measured standby current × days is within the usable battery capacity, with margin.", basis: "Power: standby" });
  if (src === "li_ion" && pw.usb_c_charging) add({ key: "usb_c_charging", kind: "interface", priority: "must", text: "The product shall charge from a USB-C power source.",
    acceptance_criteria: "Charges from a standard USB-C 5 V source; charging stays within the cell's temperature limits.", basis: "Power: USB-C charging" });

  // Connectivity and controls
  for (const r of c.radios ?? []) {
    const k = r.toLowerCase().replace(/[^a-z0-9]+/g, "_");
    add({ key: `radio_${k}`, kind: "interface", priority: "must", text: `The product shall communicate over ${r}${n(c.radio_range_m) ? ` at up to ${n(c.radio_range_m)} m` : ""}.`,
      acceptance_criteria: `Link established with the intended counterpart device in the intended setting${n(c.radio_range_m) ? `, at ${n(c.radio_range_m)} m line of sight` : ""}.`,
      basis: "Connectivity: radios" });
  }
  if (c.phone_app) add({ key: "phone_app", kind: "functional", priority: "must",
    text: `The product shall work with a phone app${c.radios?.length ? ` over ${c.radios[0]}` : ""}.`,
    acceptance_criteria: "Pairing, the main tasks and a firmware update shown with the app on current iOS and Android phones.", basis: "Connectivity: phone app" });
  for (const w of c.wired ?? []) add({ key: `wired_${w.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`, kind: "interface", priority: "must",
    text: `The product shall provide a ${w} connection.`, acceptance_criteria: `${w} works with a standard counterpart (cable, host or device).`, basis: "Connectivity: wired interfaces" });
  if (c.display && c.display !== "none") add({ key: "display", kind: "functional", priority: "must",
    text: `The product shall have ${c.display === "leds" ? "status LEDs" : `a ${c.display} display${n(c.display_size_in) ? ` of about ${n(c.display_size_in)} inches` : ""}`}.`,
    acceptance_criteria: "Readable in the intended lighting by the product owner.", basis: "Connectivity: display" });
  if (n(c.buttons)) add({ key: "buttons", kind: "functional", priority: "should", text: `The product shall have ${n(c.buttons)} physical button(s).`,
    acceptance_criteria: "Each button's function demonstrated; buttons usable with the intended grip or gloves.", basis: "Connectivity: buttons" });
  if (c.audio && c.audio !== "none") add({ key: "audio", kind: "functional", priority: "should", text: `The product shall have a ${c.audio}.`,
    acceptance_criteria: "Audible at the intended distance in the intended setting.", basis: "Connectivity: audio" });

  // Size and environment
  const dims = [n(ph.max_l_mm), n(ph.max_w_mm), n(ph.max_h_mm)];
  if (dims.some((d) => d != null)) add({ key: "size", kind: "mechanical", priority: "must",
    text: `The product shall fit within ${dims.map((d) => d ?? "?").join(" × ")} mm.`, acceptance_criteria: "Measured outer dimensions of a production-intent unit are within the limit.",
    basis: "Physical: maximum size" });
  if (n(ph.max_weight_g)) add({ key: "weight", kind: "mechanical", priority: "should", text: `The product shall weigh no more than ${n(ph.max_weight_g)} g.`,
    acceptance_criteria: "Weighed production-intent unit, including battery, at or below the limit.", basis: "Physical: maximum weight" });
  if (n(ph.temp_min_c) != null || n(ph.temp_max_c) != null) add({ key: "temperature", kind: "environmental", priority: "must",
    text: `The product shall operate from ${n(ph.temp_min_c) ?? "?"} °C to ${n(ph.temp_max_c) ?? "?"} °C.`,
    acceptance_criteria: "Functional test passes at both limits after a soak (e.g. IEC 60068-2-1 cold and 60068-2-2 dry heat; method to confirm).", basis: "Environment: temperature" });
  if (ph.ip && ph.ip !== "none") add({ key: "ip", kind: "environmental", priority: "must", text: `The enclosure shall meet ${ph.ip} (IEC 60529).`,
    acceptance_criteria: `${ph.ip} test per IEC 60529 passed on production-intent units.`, basis: "Environment: ingress protection" });
  else if ((settings.includes("outdoor") || settings.includes("industrial")) && !ph.ip) add({ key: "ip", kind: "environmental", priority: "must",
    text: "The enclosure's ingress protection rating shall be set for outdoor or industrial use.", acceptance_criteria: "IP rating chosen and recorded (the wizard left it blank).",
    basis: "Product: outdoor or industrial setting" });
  if (n(ph.drop_m)) add({ key: "drop", kind: "mechanical", priority: "must", text: `The product shall survive a ${n(ph.drop_m)} m drop onto a hard floor without loss of function.`,
    acceptance_criteria: `Drops from ${n(ph.drop_m)} m on each face and corner (e.g. IEC 60068-2-31; count to confirm); functional test passes afterwards.`, basis: "Physical: drop" });
  if (has(ph.mounting)) add({ key: "mounting", kind: "mechanical", priority: "should", text: `The product shall be designed for ${ph.mounting!.replace(/_/g, " ")} use.`,
    acceptance_criteria: "Fit and handling checked on a prototype in that use.", basis: "Physical: mounting" });
  if (has(ph.finish)) add({ key: "finish", kind: "mechanical", priority: "may", text: `The enclosure finish shall be: ${sentence(ph.finish!)}`,
    acceptance_criteria: "Approved against a sample by the product owner.", basis: "Physical: colour and finish" });

  // Anything else
  for (const s of x.standards ?? []) add({ key: `std_${s.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`, kind: "regulatory", priority: "must",
    text: `The product shall comply with ${s}.`, acceptance_criteria: `Evidence of compliance with ${s} recorded on the Compliance page.`, basis: "Anything else: standards named" });
  (x.needs ?? "").split("\n").map((l) => l.trim()).filter(Boolean).forEach((l, i) => add({ key: `need_${i + 1}`, kind: "other", priority: "should",
    text: sentence(l), acceptance_criteria: "To be agreed with the team (written as given).", basis: "Anything else: other needs" }));
  return out;
}

/** The intake facts the answers give (for the feasibility check and compliance suggestions). */
export function wizardIntake(a: WizardAnswers): Record<string, unknown> {
  const p = a.product ?? {}, pw = a.power ?? {}, c = a.connectivity ?? {}, ph = a.physical ?? {};
  const dims = [ph.max_l_mm, ph.max_w_mm, ph.max_h_mm].map((d) => n(d));
  const power = pw.source ? [POWER_SOURCES[pw.source] ?? pw.source, n(pw.battery_hours) ? `${n(pw.battery_hours)} h per ${pw.source === "li_ion" ? "charge" : "set"}` : "",
                             pw.source === "li_ion" && pw.usb_c_charging ? "USB-C charging" : ""].filter(Boolean).join(", ") : "";
  return {
    intended_use: [p.purpose, p.users && `Users: ${p.users}`, (p.settings ?? []).length && `Setting: ${(p.settings ?? []).map((s) => SETTINGS[s] ?? s).join(", ")}`]
      .filter(Boolean).join(". "),
    regions: [...(a.markets?.regions ?? []), ...(a.markets?.other ? [a.markets.other] : [])],
    quantity: n(p.quantity) != null ? String(n(p.quantity)) : "", target_unit_cost: n(p.unit_cost) != null ? String(n(p.unit_cost)) : "", currency: p.currency || "USD",
    max_dimensions: dims.some((d) => d != null) ? `${dims.map((d) => d ?? "?").join(" × ")} mm` : "", power_source: power,
    radios: (c.radios ?? []).length ? c.radios : ["none"], target_standards: a.extras?.standards ?? [],
    notes: [n(ph.temp_min_c) != null || n(ph.temp_max_c) != null ? `Operating ${n(ph.temp_min_c) ?? "?"} to ${n(ph.temp_max_c) ?? "?"} °C` : "",
            ph.ip && ph.ip !== "none" ? ph.ip : "", n(ph.drop_m) ? `${n(ph.drop_m)} m drop` : ""].filter(Boolean).join("; "),
  };
}
