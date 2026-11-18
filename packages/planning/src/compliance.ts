/**
 * S7 compliance suggestions: which regulatory regimes probably apply, from the intake facts (markets, radios, power
 * source, intended use). Deterministic, no model. A starting list for a person to confirm with a test lab, never a
 * statement that a product complies or that the list is complete. Each suggestion says which intake fact triggered
 * it, so a wrong fact shows up as a wrong suggestion.
 */
import type { IntakeFacts } from "./feasibility.ts";

export interface ComplianceSuggestion {
  key: string;
  title: string;
  market: string;
  standards: string[];
  basis: string;
  note?: string;
}

export interface ComplianceSuggestions { suggestions: ComplianceSuggestion[]; gaps: string[] }

const MARKETS: [string, RegExp][] = [
  ["US", /^(us|usa|united states( of america)?|america|north america)$/i],
  ["CA", /^(ca|can|canada|north america)$/i],
  ["EU", /^(eu|europe|european union|eea)$/i],
  ["UK", /^(uk|gb|great britain|united kingdom|england)$/i],
  ["AU/NZ", /^(au|aus|australia|nz|new zealand|anz|au\/nz)$/i],
  ["JP", /^(jp|japan)$/i],
];

export function normaliseMarkets(regions: string[] | null | undefined): { markets: string[]; unknown: string[] } {
  const markets = new Set<string>(); const unknown: string[] = [];
  for (const raw of regions ?? []) {
    const r = raw.trim();
    if (!r) continue;
    if (/^(global|worldwide|world)$/i.test(r)) { for (const [m] of MARKETS) markets.add(m); continue; }
    const hits = MARKETS.filter(([, re]) => re.test(r)).map(([m]) => m);
    if (hits.length) hits.forEach((m) => markets.add(m)); else unknown.push(r);
  }
  return { markets: MARKETS.map(([m]) => m).filter((m) => markets.has(m)), unknown };
}

interface RadioFacts { any: boolean; names: string[]; ghz24: boolean; ghz5: boolean; subGhz: boolean; cellular: boolean; nfc: boolean; gnssOnly: boolean }

function radioFacts(radios: string[] | null | undefined): RadioFacts {
  const names = (radios ?? []).map((r) => r.trim()).filter((r) => r && !/^(none|no|n\/a)$/i.test(r));
  const t = names.join(" | ");
  const gnss = /gps|gnss|glonass|galileo/i;
  const transmitters = names.filter((n) => !gnss.test(n));
  return {
    any: transmitters.length > 0, names,
    ghz24: /bluetooth|\bble\b|wi-?fi|802\.11|zigbee|thread|matter|2\.4\s*ghz|esb|ant\+?/i.test(t),
    ghz5: /5\s*ghz|wi-?fi\s*(5|6|ac|ax)|802\.11(a|ac|ax)/i.test(t),
    subGhz: /lora|sigfox|sub-?ghz|868|915|433|z-?wave/i.test(t),
    cellular: /lte|cat-?m|nb-?iot|cellular|4g|5g\b|gsm|3g/i.test(t),
    nfc: /nfc|rfid/i.test(t),
    gnssOnly: names.length > 0 && transmitters.length === 0,
  };
}

const lithium = (p: string) => /li-?ion|li-?po|lipo|lithium|li-?fe|lifepo|18650|21700|\b\d+s\b.*(cell|pack|battery)/i.test(p);
const anyBattery = (p: string) => lithium(p) || /batter|cell|\baa\b|\baaa\b|coin|cr20\d\d|nimh|alkaline/i.test(p);
const mains = (p: string) => /mains|\bac\b(?!\s*adapter)|wall power|hard-?wired|1[012]0\s*v|2[234]0\s*v|line voltage|iec\s*c1[34]/i.test(p) && !/usb|external (adapter|supply|psu)/i.test(p);

export function suggestCompliance(intake: IntakeFacts): ComplianceSuggestions {
  const { markets, unknown } = normaliseMarkets(intake.regions);
  const radio = radioFacts(intake.radios);
  const power = (intake.power_source ?? "").trim();
  const use = `${intake.intended_use ?? ""} ${intake.notes ?? ""}`;
  const out: ComplianceSuggestion[] = [];
  const gaps: string[] = [];
  const add = (s: ComplianceSuggestion) => out.push(s);
  const radioBasis = `radios: ${radio.names.join(", ")}`;
  const powerBasis = `power source: ${power}`;

  if (!markets.length) gaps.push("target markets (regions): record them to get market-specific suggestions");
  if (unknown.length) gaps.push(`markets not recognised: ${unknown.join(", ")} (add their regimes by hand)`);
  if (!power) gaps.push("power source: battery and mains regimes depend on it");
  if (!(intake.radios ?? []).length) gaps.push("radios: record them, or \"none\", so radio regimes can be ruled in or out");

  // Radio standards by band, for markets that list harmonised standards per band.
  const euRadio = [...(radio.ghz24 ? ["ETSI EN 300 328"] : []), ...(radio.ghz5 ? ["ETSI EN 301 893"] : []), ...(radio.subGhz ? ["ETSI EN 300 220"] : []),
                   ...(radio.nfc ? ["ETSI EN 300 330"] : []), ...(radio.cellular ? ["ETSI EN 301 908-1"] : [])];

  if (markets.includes("US")) {
    add({ key: "us_fcc_15b", title: "FCC Part 15 Subpart B (unintentional radiator)", market: "US",
          standards: ["47 CFR Part 15 Subpart B", "ANSI C63.4"], basis: "digital electronics sold in the US",
          note: "Class B for consumer products; usually shown by Supplier's Declaration of Conformity with an accredited lab's test report." });
    if (radio.any) add({ key: "us_fcc_15c", title: "FCC radio authorisation (intentional radiator, Part 15C or the band's rule part)", market: "US",
          standards: ["47 CFR Part 15 Subpart C", "ANSI C63.10", "47 CFR 1.1310 / 2.1093 (RF exposure)"], basis: radioBasis,
          note: "A pre-certified module's grant can cover the transmitter if its integration instructions are followed (antenna, label, RF exposure); the host still needs Part 15B." });
  }
  if (markets.includes("CA")) {
    add({ key: "ca_ices003", title: "ISED ICES-003 (digital apparatus)", market: "CA", standards: ["ICES-003"], basis: "digital electronics sold in Canada" });
    if (radio.any) add({ key: "ca_rss", title: "ISED radio certification (RSS-Gen and the band's RSS)", market: "CA",
          standards: ["RSS-Gen", ...(radio.ghz24 || radio.ghz5 || radio.subGhz ? ["RSS-247"] : []), "RSS-102 (RF exposure)"], basis: radioBasis,
          note: "A certified module's ISED number can carry over under the same conditions as its FCC grant." });
  }
  if (markets.includes("EU")) {
    if (radio.any) add({ key: "eu_red", title: "EU Radio Equipment Directive 2014/53/EU", market: "EU",
          standards: [...euRadio, "ETSI EN 301 489-1", ...(radio.ghz24 || radio.ghz5 ? ["ETSI EN 301 489-17"] : []), "EN 62368-1", "EN 62311 or EN 62479"],
          basis: radioBasis, note: "Covers EMC and electrical safety for radio equipment, so the EMC and Low Voltage directives are not applied separately." });
    else add({ key: "eu_emc", title: "EU EMC Directive 2014/30/EU", market: "EU", standards: ["EN 55032", "EN 55035"], basis: "electronics sold in the EU" });
    if (!radio.any && mains(power)) add({ key: "eu_lvd", title: "EU Low Voltage Directive 2014/35/EU", market: "EU", standards: ["EN 62368-1"], basis: powerBasis });
    add({ key: "eu_rohs", title: "EU RoHS 2011/65/EU (with 2015/863)", market: "EU", standards: ["EN IEC 63000"], basis: "electrical and electronic equipment sold in the EU",
          note: "Usually shown from supplier material declarations, not a lab test." });
    add({ key: "eu_weee", title: "EU WEEE 2012/19/EU (producer registration, bin marking)", market: "EU", standards: ["EN 50419"], basis: "electrical and electronic equipment sold in the EU" });
    add({ key: "eu_reach", title: "EU REACH SVHC disclosure (Regulation 1907/2006, Article 33)", market: "EU", standards: [], basis: "articles sold in the EU" });
    if (anyBattery(power)) add({ key: "eu_battery", title: "EU Battery Regulation (EU) 2023/1542", market: "EU", standards: [], basis: powerBasis,
          note: "Labelling, removability and producer registration duties, depending on the battery type." });
  }
  if (markets.includes("UK")) {
    add({ key: "uk_marking", title: radio.any ? "UK Radio Equipment Regulations 2017 (UKCA, or CE where accepted)" : "UK EMC Regulations 2016 (UKCA, or CE where accepted)",
          market: "UK", standards: radio.any ? [...euRadio, "ETSI EN 301 489-1"] : ["EN 55032", "EN 55035"], basis: radio.any ? radioBasis : "electronics sold in Great Britain" });
    add({ key: "uk_rohs", title: "UK RoHS Regulations 2012", market: "UK", standards: ["EN IEC 63000"], basis: "electrical and electronic equipment sold in Great Britain" });
  }
  if (markets.includes("AU/NZ")) {
    add({ key: "au_rcm", title: "RCM marking (ACMA EMC and radiocommunications)", market: "AU/NZ",
          standards: ["AS/NZS CISPR 32", ...(radio.any ? ["AS/NZS 4268"] : [])], basis: radio.any ? radioBasis : "electronics sold in Australia or New Zealand" });
  }
  if (markets.includes("JP") && radio.any) {
    add({ key: "jp_radio", title: "Japan Radio Law technical conformity (MIC / \"Giteki\")", market: "JP", standards: ["MIC Article 2 Paragraph 1 Item 19 (2.4 GHz)"],
          basis: radioBasis, note: "Pre-certified modules with a Japanese certification number are common; the mark must be visible on the product or its display." });
  }
  if (radio.cellular) add({ key: "cellular_carrier", title: "Cellular certification (PTCRB / GCF and carrier approval)", market: markets.join(", ") || "global",
          standards: ["PTCRB", "GCF"], basis: radioBasis, note: "Carrier approval is per network; plan for it early." });
  if (lithium(power)) {
    add({ key: "un38_3", title: "UN 38.3 lithium battery transport tests", market: "global", standards: ["UN Manual of Tests and Criteria, 38.3"], basis: powerBasis,
          note: "Needed to ship the battery by air, sea or road; a cell supplier's test summary covers the cells, not necessarily your pack." });
    add({ key: "iec62133", title: "Battery safety (IEC 62133-2 for lithium cells and packs)", market: "global", standards: ["IEC 62133-2"], basis: powerBasis });
  }
  if (mains(power) && markets.includes("US")) add({ key: "us_safety", title: "Product safety listing (UL/CSA 62368-1 via a recognised test lab)", market: "US",
          standards: ["UL 62368-1"], basis: powerBasis, note: "Not a federal requirement for most products, but retailers, insurers and workplaces commonly require a listing." });
  if (/child|kid|toy|infant|baby/i.test(use)) add({ key: "children", title: "Toy and children's product safety (CPSIA / ASTM F963, EN 71)", market: markets.join(", ") || "global",
          standards: ["ASTM F963", "EN 71"], basis: `intended use: ${intake.intended_use ?? ""}`.trim(), note: "Children's products have mandatory third-party testing in the US." });
  if (/medical|patient|clinical|diagnos|therap/i.test(use)) add({ key: "medical", title: "Medical device regulation (FDA, EU MDR): needs a regulatory specialist", market: markets.join(", ") || "global",
          standards: ["IEC 60601-1", "ISO 13485", "ISO 14971"], basis: `intended use: ${intake.intended_use ?? ""}`.trim(),
          note: "VX Design does not cover medical device regulation; treat this as a project risk." });
  return { suggestions: out, gaps };
}
