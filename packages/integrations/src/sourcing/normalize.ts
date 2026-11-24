/**
 * Part identity: the same part is written differently by different distributors. Normalization
 * folds case, spaces, dash variants and manufacturer aliases so results can be compared, and the
 * identity check says how sure the match is.
 */

export function normalizeMpn(mpn: string): string {
  return mpn.toUpperCase().replace(/[‐-―−]/g, "-").replace(/\s+/g, "");
}

/** Manufacturer aliases seen across distributors, folded to one key. Extend as discrepancies show up. */
const MFR_ALIASES: [RegExp, string][] = [
  [/^diodes( inc(orporated)?\.?)?$/i, "DIODES"],
  [/^texas instruments( inc(orporated)?\.?)?$|^ti$/i, "TEXAS INSTRUMENTS"],
  [/^stmicroelectronics|^st micro/i, "STMICROELECTRONICS"],
  [/^analog devices( inc\.?)?$|^adi$/i, "ANALOG DEVICES"],
  [/^microchip( technology)?( inc\.?)?$/i, "MICROCHIP"],
  [/^nxp( semiconductors)?( usa)?( inc\.?)?$/i, "NXP"],
  [/^on ?semi(conductor)?$|^onsemi$/i, "ONSEMI"],
  [/^murata( electronics| manufacturing)?( north america)?( co\.?,? ltd\.?)?$/i, "MURATA"],
  [/^samsung electro-?mechanics( america)?$/i, "SAMSUNG ELECTRO-MECHANICS"],
  [/^yageo( america)?$/i, "YAGEO"],
  [/^kemet( corporation)?$/i, "KEMET"],
  [/^tdk( corporation)?$/i, "TDK"],
  [/^vishay( dale| intertechnology| semiconductor.*)?$/i, "VISHAY"],
  [/^uniroyal( elec)?$|^uni-?royal/i, "UNI-ROYAL"],
  [/^espressif( systems)?$/i, "ESPRESSIF"],
  [/^nordic( semiconductor)?( asa)?$/i, "NORDIC"],
];

export function normalizeManufacturer(name: string | null | undefined): string {
  const n = (name ?? "").trim().replace(/\s+/g, " ").replace(/,?\s*(inc|llc|ltd|co|corp)\.?$/i, "");
  for (const [re, key] of MFR_ALIASES) if (re.test(n)) return key;
  return n.toUpperCase();
}

/**
 * Whether two manufacturer names are the same company as distributors write them: equal after normalizing, or one is
 * the other plus corporate words ("JST" / "JST Sales America Inc.", "Hirose" / "Hirose Electric Co Ltd",
 * "Nexperia" / "Nexperia USA Inc.", "Amphenol" / "Amphenol ICC (FCI)").
 */
export function sameManufacturer(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = normalizeManufacturer(a), y = normalizeManufacturer(b);
  if (!x || !y || x === y) return true;
  const core = (n: string) => n.replace(/\(.*?\)/g, " ").replace(/[.,]/g, " ")
    .replace(/\b(INC|LLC|LTD|CO|CORP|CORPORATION|COMPANY|LIMITED|GMBH|AG|SA|BV|PLC|KK|USA|AMERICA|AMERICAS|NORTH|EUROPE|ASIA|SALES|ELECTRIC|ELECTRONICS|ELECTRONIC|COMPONENTS|TECHNOLOGY|TECHNOLOGIES|SEMICONDUCTOR|SEMICONDUCTORS|INTERNATIONAL|GROUP|INDUSTRIES|MFG|MANUFACTURING|CONNECTIVITY|ICC|FCI|THE)\b/g, " ")
    .replace(/\s+/g, " ").trim();
  const cx = core(x), cy = core(y);
  if (!cx || !cy) return false;
  if (cx === cy) return true;
  const [short, long] = cx.length <= cy.length ? [cx, cy] : [cy, cx];
  return short.length >= 3 && (long === short || long.startsWith(`${short} `));
}

export type IdentityMatch = "exact" | "packaging_variant" | "different";

/**
 * Exact: same normalized MPN (and manufacturer, when both are known). Packaging variant: one MPN
 * extends the other with an ordering suffix (tape/reel, cut tape), e.g. AP2112K-3.3TRG1 vs AP2112K-3.3.
 */
export function matchIdentity(want: { mpn: string; manufacturer?: string | null },
                              got: { mpn: string; manufacturer?: string | null }): IdentityMatch {
  const a = normalizeMpn(want.mpn);
  const b = normalizeMpn(got.mpn);
  if (want.manufacturer && got.manufacturer && !sameManufacturer(want.manufacturer, got.manufacturer)) {
    return "different";
  }
  if (a === b) return "exact";
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  if (short.length >= 5 && long.startsWith(short) && /^[-/#]?(TR|T|R|CT|DKR|ND|G1|TRG1|-7|-13|PBF|E3|LF)?[A-Z0-9-/#]{0,6}$/.test(long.slice(short.length))) {
    return "packaging_variant";
  }
  return "different";
}

/** Package code from a KiCad footprint name, e.g. Capacitor_SMD:C_0603_1608Metric -> 0603. */
export function packageFromFootprint(footprint: string): string | null {
  const name = footprint.split(":").pop() ?? footprint;
  const chip = /^(?:C|R|L|LED|D|F)_(\d{4})_\d{4}Metric/.exec(name);
  if (chip) return chip[1]!;
  const known = /(SOT-23(?:-\d)?|SOT-223|SOT-89|SOD-123F?|SOD-323|SOIC-\d+|TSSOP-\d+|QFN-\d+|DFN-\d+|TO-252|TO-263|SC-70(?:-\d)?|MSOP-\d+)/i.exec(name);
  return known ? known[1]!.toUpperCase() : null;
}

/** Parses a passive value like 1uF, 100nF, 4k7, 1k, 0R, 10 Ω into base units. */
export function parseValue(value: string, unit: "F" | "Ω" | "H"): number | null {
  const v = value.trim().replace(/µ|μ/g, "u").replace(/\s+/g, "").replace(/ohms?|Ω|F$|H$/gi, "");
  const mult: Record<string, number> = { p: 1e-12, n: 1e-9, u: 1e-6, m: unit === "Ω" ? 1e-3 : 1e-3, k: 1e3, K: 1e3, M: 1e6, R: 1, r: 1, "": 1 };
  // RKM code: 4k7, 0R1, 2u2
  const rkm = /^(\d+)([pnumkKMRr])(\d+)$/.exec(v);
  if (rkm) return Number(`${rkm[1]}.${rkm[3]}`) * mult[rkm[2]!]!;
  const m = /^(\d+(?:\.\d+)?)([pnumkKMRr]?)$/.exec(v);
  if (!m) return null;
  if (unit !== "Ω" && m[2] === "M") return Number(m[1]) * 1e6;
  return Number(m[1]) * mult[m[2]!]!;
}

/** Finds capacitance/resistance/voltage values written in a distributor description. */
export function valuesInText(text: string): { farads: number[]; ohms: number[]; volts: number[] } {
  const t = text.replace(/µ|μ/g, "u");
  const farads = [...t.matchAll(/(\d+(?:\.\d+)?)\s*([pnum])F\b/gi)].map((m) => Number(m[1]) * { p: 1e-12, n: 1e-9, u: 1e-6, m: 1e-3 }[m[2]!.toLowerCase() as "p"]!);
  const ohms = [...t.matchAll(/(\d+(?:\.\d+)?)\s*([kKmM]?)\s*(?:Ohms?|Ω)/g)]
    .map((m) => Number(m[1]) * ({ k: 1e3, K: 1e3, M: 1e6, m: 1e-3, "": 1 } as Record<string, number>)[m[2]!]!);
  const volts = [...t.matchAll(/(\d+(?:\.\d+)?)\s*V\b/g)].map((m) => Number(m[1]));
  return { farads, ohms, volts };
}

export function sameValue(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.abs(b) * 0.001;
}
