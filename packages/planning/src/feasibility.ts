/**
 * S0 feasibility check: deterministic rules over a project's intake facts and requirements. Each finding is a risk
 * with the requirement text it was based on, a starting score (likelihood × impact, 1–5 each) and a suggested
 * mitigation; findings beyond what VX Design automates are filed as platform risks. No model is involved, so the
 * check runs without an API key and gives the same answer for the same inputs.
 */

export type Stage = "S0" | "S1" | "S2" | "S3" | "S4" | "S5" | "S6" | "S7" | "S8";
export type RiskCategory = "technical" | "safety" | "regulatory" | "supply" | "cost" | "schedule" | "requirements" | "platform";

export interface IntakeFacts {
  intended_use?: string | null;
  regions?: string[] | null;
  quantity?: number | null;
  target_unit_cost?: number | null;
  currency?: string | null;
  max_dimensions?: string | null;
  power_source?: string | null;
  radios?: string[] | null;
  target_standards?: string[] | null;
  notes?: string | null;
}

export interface FeasibilityRequirement {
  ref_code: string;
  kind?: string | null;
  text: string;
  acceptance_criteria?: string | null;
  status?: string | null;
}

export interface Evidence { ref: string; excerpt: string }

export interface Finding {
  rule_key: string;
  title: string;
  description: string;
  category: RiskCategory;
  stage: Stage;
  likelihood: number;
  impact: number;
  mitigation: string;
  requirement_refs: string[];
  evidence: Evidence[];
}

export interface FeasibilityResult { findings: Finding[]; gaps: string[] }

interface Rule {
  key: string;
  pattern: RegExp;
  /** Also look in these intake fields. */
  intake?: (i: IntakeFacts) => string[];
  title: string;
  description: string;
  category: RiskCategory;
  stage: Stage;
  likelihood: number;
  impact: number;
  mitigation: string;
}

const list = (xs?: string[] | null) => (xs ?? []).filter(Boolean);

const RULES: Rule[] = [
  {
    key: "battery-lithium", category: "safety", stage: "S2", likelihood: 3, impact: 4,
    pattern: /\b(li[- ]?ion|lithium|li[- ]?po(ly(mer)?)?|lipo|18650|21700|rechargeable batter(y|ies))\b/i,
    intake: (i) => [i.power_source ?? ""],
    title: "Lithium battery: cell safety and shipping rules",
    description: "Lithium cells need protection against overcharge, short circuit and heat, and the product needs UN 38.3 test summaries to ship (IEC 62133-2 for the cells or pack).",
    mitigation: "Use cells or packs that already have UN 38.3 and IEC 62133-2 reports; include a protection circuit and charge temperature limits; plan shipping as UN3481.",
  },
  {
    key: "radio-intentional", category: "regulatory", stage: "S2", likelihood: 4, impact: 4,
    pattern: /\b(bluetooth|\bble\b|wi-?fi|802\.11|zigbee|thread|lora(wan)?|lte|cellular|4g|5g|nb-?iot|nfc|uwb|wireless|radio|rf link|2\.4 ?ghz|sub-?ghz)\b/i,
    intake: (i) => list(i.radios),
    title: "Radio transmitter: certification required",
    description: "A product that transmits needs radio certification in each market (e.g. FCC Part 15 subpart C in the US, the Radio Equipment Directive in the EU), and the antenna and layout decide whether it passes.",
    mitigation: "Use a pre-certified radio module with its reference antenna and layout; budget for intentional-radiator testing at a lab; keep the module's grant conditions.",
  },
  {
    key: "wireless-video", category: "platform", stage: "S3", likelihood: 4, impact: 4,
    pattern: /\b(wireless (video|hdmi|sdi)|video (transmitter|link)|transmit(s|ting)? video)\b/i,
    title: "Wireless video: beyond what VX Design automates",
    description: "RF design for a wireless video link (antennas, matching, coexistence) is not automated by VX Design; generated layouts are not RF-verified.",
    mitigation: "Use a complete wireless video module, or plan RF design and review by a specialist; treat generated RF layouts as drafts.",
  },
  {
    key: "high-speed", category: "platform", stage: "S3", likelihood: 3, impact: 4,
    pattern: /\b(hdmi|3g-?sdi|12g-?sdi|\bsdi\b|ddr[2-5]?|lpddr|pcie|usb ?3(\.\d)?|usb ?c (video|alt)|mipi|lvds|displayport|serdes|gigabit ethernet|1000base|impedance[- ]controlled|controlled impedance)\b/i,
    title: "High-speed interfaces: routing needs review",
    description: "Impedance-controlled and high-speed routing (length matching, stackup, return paths) is not guaranteed by VX Design's autorouting.",
    mitigation: "Fix the stackup with the fab early; route these nets by hand or review them with a signal-integrity check before ordering.",
  },
  {
    key: "mains-voltage", category: "safety", stage: "S2", likelihood: 3, impact: 5,
    pattern: /\b(mains|(100|110|115|120|220|230|240)\s?v ?(ac)?\b|\bac input|line voltage|wall power \(ac\))/i,
    intake: (i) => [i.power_source ?? ""],
    title: "Mains voltage inside the product: electrical safety",
    description: "Circuits connected to mains need safety isolation, creepage and clearance distances and safety certification (IEC 62368-1 or the equivalent for the product type).",
    mitigation: "Use an external certified power supply where possible; otherwise use a certified internal module and have the isolation reviewed.",
  },
  {
    key: "regulated-domain", category: "regulatory", stage: "S0", likelihood: 4, impact: 5,
    pattern: /\b(medical|patient|diagnos(is|tic)|implant|automotive|vehicle|aec-?q\d+|iso ?26262|aerospace|avionics|do-?160|explosive atmosphere|atex|intrinsically safe)\b/i,
    intake: (i) => [i.intended_use ?? ""],
    title: "Regulated domain: quality system and certification",
    description: "Medical, automotive, aerospace or hazardous-area products need a quality system and domain certification (e.g. ISO 13485 / IEC 60601, AEC-Q / ISO 26262, DO-160, ATEX) that VX Design does not provide.",
    mitigation: "Confirm the regulatory pathway with a specialist before design; plan for qualified components and documented design controls.",
  },
  {
    key: "ingress-protection", category: "technical", stage: "S3", likelihood: 3, impact: 3,
    pattern: /\b(ip[5-6][0-9x]|ip6[5-9]|waterproof|water[- ]resistant|dust[- ]?tight|submersible|rain)\b/i,
    title: "Sealed enclosure: gasket and test",
    description: "An ingress rating needs a sealing design (gaskets, sealed connectors and buttons) and a test; VX Design's enclosure tool does not design gaskets yet.",
    mitigation: "Choose sealed connectors and buttons early; design the gasket with the enclosure supplier; test the first articles to the rating.",
  },
  {
    key: "temperature-range", category: "technical", stage: "S2", likelihood: 3, impact: 3,
    pattern: /(-\s?(2[1-9]|[3-9]\d)\s?°?\s?c\b|\b([7-9]\d|1\d\d)\s?°?\s?c\b|industrial temperature|extended temperature|outdoor)/i,
    title: "Wide temperature range: component grades",
    description: "Operating outside 0–70 °C needs industrial or extended-grade parts, and batteries and displays are often the limiting parts.",
    mitigation: "Check every part's rated range during component selection (especially battery, display and crystal); plan a temperature test.",
  },
  {
    key: "display-oem", category: "supply", stage: "S2", likelihood: 3, impact: 3,
    pattern: /\b(touch ?screen|touch ?panel|lcd|oled|e-?ink|tft|display module)\b/i,
    title: "Display: single-source OEM part",
    description: "Displays and touch panels are usually custom or single-source, with long lead times, minimum orders and interface documents under NDA.",
    mitigation: "Get the display maker's drawings, interface specs and lifecycle commitment before layout; qualify a second option early.",
  },
  {
    key: "battery-life", category: "technical", stage: "S2", likelihood: 3, impact: 3,
    pattern: /\b(battery life|runtime|run time|standby (time|current)|\d+\s?(hours?|h|days?)\b[^.]{0,40}\b(battery|charge))\b/i,
    title: "Battery life target: power budget needed early",
    description: "A runtime or standby target depends on the power architecture, quiescent currents and duty cycle; it is easy to miss late.",
    mitigation: "Build the power budget (power calculator) in S2 and keep it updated as parts are chosen.",
  },
];

function excerpt(text: string, m: RegExpExecArray): string {
  const start = Math.max(0, m.index - 60);
  const end = Math.min(text.length, m.index + m[0].length + 60);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
}

/** Runs every rule over the intake facts and the requirements that are not rejected. */
export function checkFeasibility(intake: IntakeFacts | null, requirements: FeasibilityRequirement[]): FeasibilityResult {
  const i = intake ?? {};
  const reqs = requirements.filter((r) => r.status !== "rejected");
  const findings: Finding[] = [];
  for (const rule of RULES) {
    const evidence: Evidence[] = [];
    for (const r of reqs) {
      const text = [r.text, r.acceptance_criteria].filter(Boolean).join(" ");
      const m = new RegExp(rule.pattern.source, rule.pattern.flags).exec(text);
      if (m) evidence.push({ ref: r.ref_code, excerpt: excerpt(text, m) });
    }
    for (const t of rule.intake?.(i) ?? []) {
      const m = t ? new RegExp(rule.pattern.source, rule.pattern.flags).exec(t) : null;
      if (m) evidence.push({ ref: "intake", excerpt: excerpt(t, m) });
    }
    if (!evidence.length) continue;
    findings.push({
      rule_key: rule.key, title: rule.title, description: rule.description, category: rule.category, stage: rule.stage,
      likelihood: rule.likelihood, impact: rule.impact, mitigation: rule.mitigation,
      requirement_refs: [...new Set(evidence.map((e) => e.ref).filter((r) => r !== "intake"))], evidence,
    });
  }

  // Requirements still unreviewed or ambiguous.
  const unclear = requirements.filter((r) => r.status === "ambiguous");
  if (unclear.length) {
    findings.push({
      rule_key: "requirements-ambiguous", category: "requirements", stage: "S0",
      likelihood: Math.min(5, 2 + unclear.length), impact: 3,
      title: `${unclear.length} ambiguous requirement(s)`,
      description: "Ambiguous requirements lead to designs that pass their own checks but miss what was meant.",
      mitigation: "Rewrite each with a measurable acceptance criterion, or reject it.",
      requirement_refs: unclear.map((r) => r.ref_code), evidence: unclear.map((r) => ({ ref: r.ref_code, excerpt: r.text })),
    });
  }
  const untestable = reqs.filter((r) => r.status === "confirmed" && !r.acceptance_criteria && !/\d/.test(r.text));
  if (untestable.length) {
    findings.push({
      rule_key: "requirements-untestable", category: "requirements", stage: "S0", likelihood: 3, impact: 2,
      title: `${untestable.length} requirement(s) with nothing to measure`,
      description: "Confirmed requirements with no number and no acceptance criterion cannot be verified by test (S6).",
      mitigation: "Add an acceptance criterion or a measurable limit to each.",
      requirement_refs: untestable.map((r) => r.ref_code), evidence: untestable.map((r) => ({ ref: r.ref_code, excerpt: r.text })),
    });
  }

  // Intake gaps, and the risks they leave open.
  const gaps: string[] = [];
  if (!i.intended_use?.trim()) gaps.push("intended use");
  if (!list(i.regions).length) gaps.push("target markets (regions)");
  if (!i.quantity) gaps.push("first production quantity");
  if (i.target_unit_cost == null) gaps.push("target unit cost");
  if (!i.max_dimensions?.trim()) gaps.push("maximum dimensions");
  if (!i.power_source?.trim()) gaps.push("power source");
  if (!list(i.target_standards).length) gaps.push("target standards");
  if (!list(i.regions).length) {
    findings.push({
      rule_key: "markets-unknown", category: "regulatory", stage: "S0", likelihood: 4, impact: 3,
      title: "Target markets not set: certifications unknown",
      description: "Which certifications apply (e.g. FCC, CE/UKCA, ISED, RCM) depends on where the product is sold.",
      mitigation: "Record the target markets in the intake, then rerun the check.", requirement_refs: [], evidence: [],
    });
  }
  if (i.target_unit_cost == null || !i.quantity) {
    findings.push({
      rule_key: "cost-target-unknown", category: "cost", stage: "S0", likelihood: 3, impact: 3,
      title: "No unit cost target at a quantity",
      description: "Without a target cost at a stated quantity, part choices and the build method cannot be judged.",
      mitigation: "Record the first production quantity and the target unit cost in the intake.", requirement_refs: [], evidence: [],
    });
  }
  return { findings, gaps };
}
