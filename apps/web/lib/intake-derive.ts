import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * What the project already says about its intake (markets, radios, power, size, use, standards), read from the owner's
 * answers to questions, the requirements, the design freeze and the description. Used to pre-fill an empty Intake so
 * it reflects the project; every value says where it came from and nothing is saved until the owner saves.
 */
export interface DerivedIntake {
  regions: string[]; radios: string[]; power: string[]; standards: string[];
  max_dimensions: string | null; intended_use: string | null;
  sources: Record<string, string>;
}

const MARKET_RULES: [RegExp, string][] = [
  [/\b(US|U\.S\.|USA|United States|FCC)\b/, "US"], [/\b(EU|EEA|Europe(an)?|CE RED)\b/, "EU"], [/\b(UK|United Kingdom|UKCA|Britain)\b/, "UK"],
  [/\b(Canada|Canadian|ISED)\b/, "Canada"], [/\b(Japan|TELEC)\b/, "Japan"], [/\b(Australia|RCM)\b/, "Australia"], [/\b(China|SRRC)\b/, "China"],
];
const RADIO_RULES: [RegExp, string][] = [
  [/\bWi-?Fi\b|802\.11/i, "Wi-Fi"], [/\bBluetooth\b|\bBLE\b/i, "Bluetooth LE"], [/\bLoRa\b/i, "LoRa"], [/\b(LTE|cellular|4G|5G|NB-IoT)\b/i, "Cellular"],
  [/\bNFC\b/i, "NFC"], [/\b(GPS|GNSS)\b/i, "GPS"],
];
const POWER_RULES: [RegExp, string][] = [
  [/\b(Li-?ion|Li-?Po|lithium|battery|2S|1S)\b/i, "Rechargeable Li-ion"], [/\bUSB-?C\b/i, "USB-C"], [/\b(AA|AAA) (cells?|batter)/i, "AA / AAA cells"],
  [/\b(mains|AC adapter|100-240 ?V)\b/i, "Mains (AC)"], [/\bPoE\b/, "PoE"], [/\b12 ?V DC\b/i, "12 V DC"],
];
const STANDARD_RULES: [RegExp, string][] = [
  [/\bFCC\b/, "FCC Part 15"], [/\b(CE|RED)\b/, "CE RED"], [/\bUKCA\b/, "UKCA"], [/\bISED\b/, "ISED"], [/62368/, "UL 62368-1"],
  [/\bIP54\b/, "IP54"], [/\bIP67\b/, "IP67"], [/\bRoHS\b/i, "RoHS"], [/\bREACH\b/, "REACH"],
];
const hits = (rules: [RegExp, string][], text: string) => [...new Set(rules.filter(([re]) => re.test(text)).map(([, v]) => v))];

export async function deriveIntake(supabase: SupabaseClient, projectId: string): Promise<DerivedIntake> {
  const [{ data: project }, { data: answers }, { data: reqs }, { data: freeze }] = await Promise.all([
    supabase.from("projects").select("description").eq("id", projectId).maybeSingle(),
    supabase.from("project_questions").select("question, answer").eq("project_id", projectId).eq("status", "answered"),
    supabase.from("requirements").select("kind, text").eq("project_id", projectId).neq("status", "rejected").limit(2000),
    supabase.from("current_design_freeze").select("envelope").eq("project_id", projectId).maybeSingle(),
  ]);
  const sources: Record<string, string> = {};
  // Markets: the owner's answers about markets first, then the requirements.
  const marketAnswers = (answers ?? []).filter((a) => /market|countr|launch|sell|region/i.test(a.question)).map((a) => a.answer ?? "").join(" \n ");
  let regions = hits(MARKET_RULES, marketAnswers);
  if (regions.length) sources.regions = "your answers on the Questions page";
  else { regions = hits(MARKET_RULES, (reqs ?? []).filter((r) => /regulat|compliance|certif|market/i.test(`${r.kind} ${r.text}`)).map((r) => r.text).join(" \n ")); if (regions.length) sources.regions = "the requirements"; }
  const allReq = (reqs ?? []).map((r) => r.text).join(" \n ");
  const radios = hits(RADIO_RULES, `${allReq} \n ${(answers ?? []).map((a) => a.answer ?? "").join(" \n ")}`);
  if (radios.length) sources.radios = "the requirements and your answers";
  const power = hits(POWER_RULES, (reqs ?? []).filter((r) => r.kind === "power" || /batter|power|charg/i.test(r.text)).map((r) => r.text).join(" \n "));
  if (power.length) sources.power = "the power requirements";
  const standards = hits(STANDARD_RULES, allReq);
  if (standards.length) sources.standards = "the requirements";
  const e = freeze?.envelope as { length_mm?: number; width_mm?: number; height_mm?: number } | null;
  const max_dimensions = e?.length_mm ? `${e.length_mm} × ${e.width_mm} × ${e.height_mm} mm` : null;
  if (max_dimensions) sources.max_dimensions = "the design freeze";
  const intended_use = project?.description?.split("\n")[0]?.trim() || null;
  if (intended_use) sources.intended_use = "the project description";
  return { regions, radios, power, standards, max_dimensions, intended_use, sources };
}
