export const MODULE_KINDS: Record<string, string> = {
  radio_module: "Radio module", som: "System on module", dev_board: "Development board", sensor_module: "Sensor module",
  power_module: "Power module", display: "Display", other: "Other",
};

export interface ModuleRow {
  id: string; kind: string; name: string; manufacturer: string; mpn: string; description: string | null; interfaces: string[]; radios: string[];
  supply: { v_min?: number; v_max?: number; i_typ_ma?: number; i_max_ma?: number; sleep_ua?: number };
  dimensions_mm: { x?: number; y?: number; z?: number }; performance: Record<string, string>;
  certifications: { regime: string; id: string; holder?: string; source_url?: string; note?: string }[];
  cad: { kind: string; url: string }[]; lifecycle: string; source_url: string | null; source_note: string | null; checked_on: string | null;
  status: string; verified_at: string | null; part_id: string | null; updated_at: string;
}

/** "a, b; c" → ["a", "b", "c"] */
export const list = (s: string) => s.split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);

/** Module form text areas: "label: value" lines, "regime | id | link or note" lines, "kind | url" lines. */
export function parseModuleText(perf: string, certs: string, cad: string) {
  const performance = Object.fromEntries(perf.split("\n").map((l) => l.split(/:(.+)/)).filter((p) => p[0]?.trim() && p[1]?.trim())
    .map(([k, v]) => [k!.trim(), v!.trim()]));
  const certifications = certs.split("\n").map((l) => l.split("|").map((x) => x.trim())).filter((p) => p[0]).map(([regime, id, where, holder]) => ({
    regime: regime!, id: id ?? "", ...(where && /^https:\/\//.test(where) ? { source_url: where } : where ? { note: where } : {}), ...(holder ? { holder } : {}),
  }));
  const cadLinks = cad.split("\n").map((l) => l.split("|").map((x) => x.trim())).filter((p) => p[0] && p[1]).map(([kind, url]) => ({ kind: kind!, url: url! }));
  return { performance, certifications, cad: cadLinks };
}

export const certText = (m: Pick<ModuleRow, "certifications">) =>
  m.certifications.map((c) => [c.regime, c.id, c.source_url ?? c.note ?? "", c.holder ?? ""].filter((x, i) => i < 3 || x).join(" | ")).join("\n");
