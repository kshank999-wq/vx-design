/**
 * Manufacturer process rules and design-for-manufacture checks. Each manufacturer states its limits per process
 * (bare PCB, PCB assembly, enclosure processes); a design's measured facts (from the committed fab package's check
 * file and the enclosure fit report) are compared with them. Every check is pass, fail or unknown, with the design's
 * value and the limit side by side, so "unknown" (a fact or a limit not recorded) is never mistaken for a pass.
 */

export type Process = "pcb_fab" | "pcb_assembly" | "fdm" | "sla" | "sls" | "cnc" | "sheet_metal" | "injection_molding";
export const PROCESSES: { key: Process; label: string; category: string }[] = [
  { key: "pcb_fab", label: "Bare PCB fabrication", category: "bare_pcb" },
  { key: "pcb_assembly", label: "PCB assembly (SMT/THT)", category: "pcba" },
  { key: "fdm", label: "3D printing, FDM", category: "printing_casting" },
  { key: "sla", label: "3D printing, SLA (resin)", category: "printing_casting" },
  { key: "sls", label: "3D printing, SLS/MJF (powder)", category: "printing_casting" },
  { key: "cnc", label: "CNC machining", category: "cnc" },
  { key: "sheet_metal", label: "Sheet metal", category: "sheet_metal" },
  { key: "injection_molding", label: "Injection molding", category: "injection_molding" },
];

/** The fields each process's rules may hold (all optional: an absent limit makes its check "unknown"). */
export interface PcbFabRules {
  layer_counts?: number[]; min_track_mm?: number; min_clearance_mm?: number; min_drill_mm?: number;
  min_board_mm?: number; max_board_mm?: [number, number]; thicknesses_mm?: number[]; finishes?: string[];
}
export interface AssemblyRules {
  smallest_passive?: "01005" | "0201" | "0402" | "0603" | "0805"; fine_pitch_mm?: number; bga?: boolean;
  double_sided?: boolean; through_hole?: boolean; min_board_mm?: number; max_board_mm?: [number, number];
}
export interface EnclosureRules { min_wall_mm?: number; max_part_mm?: [number, number, number]; tolerance_mm?: number; materials?: string[] }
export type Rules = PcbFabRules & AssemblyRules & EnclosureRules;

export const RULE_FIELDS: Record<Process, { key: string; label: string; kind: "number" | "numbers" | "dims2" | "dims3" | "bool" | "text" | "texts" | "passive"; unit?: string }[]> = {
  pcb_fab: [
    { key: "layer_counts", label: "Layer counts", kind: "numbers" }, { key: "min_track_mm", label: "Minimum track width", kind: "number", unit: "mm" },
    { key: "min_clearance_mm", label: "Minimum clearance", kind: "number", unit: "mm" }, { key: "min_drill_mm", label: "Minimum drill", kind: "number", unit: "mm" },
    { key: "min_board_mm", label: "Smallest board side", kind: "number", unit: "mm" }, { key: "max_board_mm", label: "Largest board", kind: "dims2", unit: "mm" },
    { key: "thicknesses_mm", label: "Board thicknesses", kind: "numbers", unit: "mm" }, { key: "finishes", label: "Surface finishes", kind: "texts" },
  ],
  pcb_assembly: [
    { key: "smallest_passive", label: "Smallest passive", kind: "passive" }, { key: "fine_pitch_mm", label: "Finest pitch", kind: "number", unit: "mm" },
    { key: "bga", label: "BGA", kind: "bool" }, { key: "double_sided", label: "Parts on both sides", kind: "bool" },
    { key: "through_hole", label: "Through-hole parts", kind: "bool" },
    { key: "min_board_mm", label: "Smallest board side", kind: "number", unit: "mm" }, { key: "max_board_mm", label: "Largest board", kind: "dims2", unit: "mm" },
  ],
  fdm: [], sla: [], sls: [], cnc: [], sheet_metal: [], injection_molding: [],
};
for (const p of ["fdm", "sla", "sls", "cnc", "sheet_metal", "injection_molding"] as const) {
  RULE_FIELDS[p] = [
    { key: "min_wall_mm", label: "Minimum wall", kind: "number", unit: "mm" }, { key: "max_part_mm", label: "Largest part", kind: "dims3", unit: "mm" },
    { key: "tolerance_mm", label: "Typical tolerance (±)", kind: "number", unit: "mm" }, { key: "materials", label: "Materials", kind: "texts" },
  ];
}

/** Published starting points to copy from; always re-check against the fab's current capability page. */
export const TEMPLATES: { key: string; label: string; process: Process; rules: Rules; source: string }[] = [
  { key: "jlcpcb-2l", label: "JLCPCB standard 1–2 layer", process: "pcb_fab", source: "https://jlcpcb.com/capabilities/pcb-capabilities",
    rules: { layer_counts: [1, 2], min_track_mm: 0.127, min_clearance_mm: 0.127, min_drill_mm: 0.3, min_board_mm: 10, max_board_mm: [400, 500],
             thicknesses_mm: [0.6, 0.8, 1.0, 1.2, 1.6, 2.0], finishes: ["HASL", "lead-free HASL", "ENIG"] } },
  { key: "jlcpcb-smt", label: "JLCPCB SMT assembly (economic)", process: "pcb_assembly", source: "https://jlcpcb.com/capabilities/pcb-assembly-capabilities",
    rules: { smallest_passive: "0402", fine_pitch_mm: 0.4, bga: true, double_sided: false, through_hole: true, min_board_mm: 10, max_board_mm: [250, 250] } },
  { key: "oshpark-2l", label: "OSH Park 2-layer", process: "pcb_fab", source: "https://docs.oshpark.com/services/two-layer/",
    rules: { layer_counts: [2], min_track_mm: 0.1524, min_clearance_mm: 0.1524, min_drill_mm: 0.254, min_board_mm: 6.35, thicknesses_mm: [1.6, 0.8], finishes: ["ENIG"] } },
  { key: "generic-fdm", label: "Typical FDM service", process: "fdm", source: "typical published values",
    rules: { min_wall_mm: 1.2, max_part_mm: [250, 250, 250], tolerance_mm: 0.3, materials: ["PLA", "PETG", "ABS", "ASA"] } },
  { key: "generic-sla", label: "Typical SLA service", process: "sla", source: "typical published values",
    rules: { min_wall_mm: 0.8, max_part_mm: [145, 145, 175], tolerance_mm: 0.15 } },
  { key: "generic-cnc", label: "Typical CNC (aluminium)", process: "cnc", source: "typical published values",
    rules: { min_wall_mm: 0.8, max_part_mm: [400, 250, 150], tolerance_mm: 0.05, materials: ["6061", "7075"] } },
];

/** What is known about the design (null where not measured). */
export interface BoardFacts {
  width_mm: number | null; height_mm: number | null; copper_layers: number | null; min_track_mm: number | null;
  min_clearance_mm: number | null; min_drill_mm: number | null; thickness_mm: number | null; finish: string | null;
  bottom_parts: boolean | null; through_hole: boolean | null; bga: boolean | null; smallest_passive: string | null;
}
export interface EnclosureFacts { process: string | null; wall_mm: number | null; dimensions_mm: [number, number, number] | null; material: string | null }

export type Status = "pass" | "fail" | "unknown";
export interface CheckItem { check: string; status: Status; design: string; limit: string; note?: string }
export interface CheckResult { process: Process; verdict: "fits" | "does_not_fit" | "incomplete"; items: CheckItem[] }

const PASSIVES = ["01005", "0201", "0402", "0603", "0805", "1206"];
const f = (n: number | null | undefined, u = "mm") => (n == null ? "not measured" : `${n} ${u}`.trim());
const none = "not stated";

/** Reads board facts from a fab package check file (vx_eng fab-check.json) and the fab profile it was built with. */
export function boardFactsFromFabCheck(check: {
  board?: { width_mm?: number; height_mm?: number; copper_layers?: number; min_track_mm?: number | null; min_drill_mm?: number | null; holes?: unknown };
  gerbers?: { min_drill_mm?: number | null };
  parts?: { footprint?: string; side?: string; smd?: boolean }[];
}, profile?: { clearance_mm?: number; thickness_mm?: number; finish?: string }): BoardFacts {
  const parts = check.parts ?? [];
  const fps = parts.map((p) => (p.footprint ?? "").toUpperCase());
  const sizes = fps.map((fp) => PASSIVES.find((s) => new RegExp(`(^|[^0-9])${s}(_|$|[^0-9])`).test(fp.replace(/.*:/, "")) && /^(R|C|L|LED|D)_/.test(fp.replace(/.*:/, "")))).filter(Boolean) as string[];
  return {
    width_mm: check.board?.width_mm ?? null, height_mm: check.board?.height_mm ?? null, copper_layers: check.board?.copper_layers ?? null,
    min_track_mm: check.board?.min_track_mm ?? null, min_clearance_mm: profile?.clearance_mm ?? null,
    min_drill_mm: check.gerbers?.min_drill_mm ?? check.board?.min_drill_mm ?? null,
    thickness_mm: profile?.thickness_mm ?? null, finish: profile?.finish ?? null,
    bottom_parts: parts.length ? parts.some((p) => p.side === "bottom") : null,
    through_hole: parts.length ? parts.some((p) => p.smd === false) : null,
    bga: parts.length ? fps.some((fp) => /BGA/.test(fp)) : null,
    smallest_passive: sizes.length ? sizes.sort((a, b) => PASSIVES.indexOf(a) - PASSIVES.indexOf(b))[0]! : null,
  };
}

function atLeast(check: string, design: number | null, limit: number | undefined, unit = "mm"): CheckItem {
  if (design == null || limit == null) return { check, status: "unknown", design: f(design, unit), limit: limit == null ? none : `≥ ${limit} ${unit}` };
  return { check, status: design + 1e-9 >= limit ? "pass" : "fail", design: f(design, unit), limit: `≥ ${limit} ${unit}` };
}
function fitsIn(check: string, dims: number[] | null, max: number[] | undefined): CheckItem {
  if (!dims || !max) return { check, status: "unknown", design: dims ? dims.join(" × ") + " mm" : "not measured", limit: max ? `≤ ${max.join(" × ")} mm` : none };
  // Any orientation: compare sorted sizes.
  const a = [...dims].sort((x, y) => y - x), b = [...max].sort((x, y) => y - x);
  return { check, status: a.every((v, i) => v <= (b[i] ?? 0) + 1e-9) ? "pass" : "fail", design: dims.join(" × ") + " mm", limit: `≤ ${max.join(" × ")} mm` };
}
function allowed(check: string, needed: boolean | null, offered: boolean | undefined, what: string): CheckItem {
  if (needed === false) return { check, status: "pass", design: `no ${what}`, limit: offered == null ? none : offered ? "offered" : "not offered" };
  if (needed == null || offered == null) return { check, status: "unknown", design: needed == null ? "not measured" : `has ${what}`, limit: offered == null ? none : offered ? "offered" : "not offered" };
  return { check, status: offered ? "pass" : "fail", design: `has ${what}`, limit: offered ? "offered" : "not offered" };
}
function verdict(items: CheckItem[]): CheckResult["verdict"] {
  return items.some((i) => i.status === "fail") ? "does_not_fit" : items.some((i) => i.status === "unknown") ? "incomplete" : "fits";
}

export function checkBoard(process: "pcb_fab" | "pcb_assembly", rules: Rules, b: BoardFacts): CheckResult {
  const dims = b.width_mm != null && b.height_mm != null ? [b.width_mm, b.height_mm] : null;
  const minSide = dims ? Math.min(...dims) : null;
  const items: CheckItem[] = [];
  if (process === "pcb_fab") {
    items.push(b.copper_layers == null || !rules.layer_counts?.length
      ? { check: "Layer count", status: "unknown", design: b.copper_layers == null ? "not measured" : `${b.copper_layers}`, limit: rules.layer_counts?.join(", ") ?? none }
      : { check: "Layer count", status: rules.layer_counts.includes(b.copper_layers) ? "pass" : "fail", design: `${b.copper_layers}`, limit: rules.layer_counts.join(", ") });
    items.push(atLeast("Track width", b.min_track_mm, rules.min_track_mm));
    items.push({ ...atLeast("Clearance", b.min_clearance_mm, rules.min_clearance_mm), note: "the routing rule the board was built with" });
    items.push(atLeast("Smallest drill", b.min_drill_mm, rules.min_drill_mm));
    items.push(atLeast("Smallest side", minSide, rules.min_board_mm));
    items.push(fitsIn("Board size", dims, rules.max_board_mm));
    if (rules.thicknesses_mm?.length || b.thickness_mm != null) {
      items.push(b.thickness_mm == null || !rules.thicknesses_mm?.length
        ? { check: "Thickness", status: "unknown", design: f(b.thickness_mm), limit: rules.thicknesses_mm?.join(", ") ?? none }
        : { check: "Thickness", status: rules.thicknesses_mm.some((t) => Math.abs(t - b.thickness_mm!) < 0.01) ? "pass" : "fail",
            design: f(b.thickness_mm), limit: rules.thicknesses_mm.map((t) => `${t}`).join(", ") + " mm" });
    }
    if (rules.finishes?.length && b.finish) {
      const ok = rules.finishes.some((x) => b.finish!.toLowerCase().includes(x.toLowerCase()) || x.toLowerCase().includes(b.finish!.toLowerCase().replace(/\s*\(.*\)/, "")));
      items.push({ check: "Surface finish", status: ok ? "pass" : "fail", design: b.finish, limit: rules.finishes.join(", ") });
    }
  } else {
    items.push(b.smallest_passive == null || !rules.smallest_passive
      ? { check: "Smallest passive", status: b.smallest_passive == null && rules.smallest_passive ? "pass" : "unknown",
          design: b.smallest_passive ?? "no chip passives found", limit: rules.smallest_passive ?? none }
      : { check: "Smallest passive", status: PASSIVES.indexOf(b.smallest_passive) >= PASSIVES.indexOf(rules.smallest_passive) ? "pass" : "fail",
          design: b.smallest_passive, limit: `${rules.smallest_passive} or larger` });
    items.push(allowed("Parts on both sides", b.bottom_parts, rules.double_sided, "bottom-side parts"));
    items.push(allowed("Through-hole parts", b.through_hole, rules.through_hole, "through-hole parts"));
    items.push(allowed("BGA", b.bga, rules.bga, "BGA packages"));
    items.push(atLeast("Smallest side", minSide, rules.min_board_mm));
    items.push(fitsIn("Board size", dims, rules.max_board_mm));
  }
  return { process, verdict: verdict(items), items };
}

export function checkEnclosure(process: Process, rules: Rules, e: EnclosureFacts): CheckResult {
  const items: CheckItem[] = [];
  if (e.process && e.process !== process) {
    items.push({ check: "Process", status: "fail", design: `designed for ${e.process}`, limit: process,
                 note: "the enclosure was designed for another process; redesign it for this one" });
  }
  items.push(atLeast("Wall thickness", e.wall_mm, rules.min_wall_mm));
  items.push(fitsIn("Part size", e.dimensions_mm, rules.max_part_mm));
  if (rules.materials?.length && e.material) {
    items.push({ check: "Material", status: rules.materials.some((m) => e.material!.toLowerCase().includes(m.toLowerCase())) ? "pass" : "fail",
                 design: e.material, limit: rules.materials.join(", ") });
  }
  return { process, verdict: verdict(items), items };
}

/** Parses a rules form ({key: string}) into typed rules for a process; returns the problems found. */
export function parseRules(process: Process, input: Record<string, string>): { rules: Rules; problems: string[] } {
  const rules: Record<string, unknown> = {};
  const problems: string[] = [];
  const num = (s: string) => (/^\d+(\.\d+)?$/.test(s) ? Number(s) : NaN);
  for (const field of RULE_FIELDS[process]) {
    const raw = (input[field.key] ?? "").trim();
    if (!raw) continue;
    const parts = raw.split(/[,;×x]+/i).map((x) => x.trim()).filter(Boolean);
    switch (field.kind) {
      case "number": { const n = num(raw); if (Number.isNaN(n)) problems.push(`${field.label}: "${raw}" is not a number`); else rules[field.key] = n; break; }
      case "numbers": { const ns = parts.map(num); if (ns.some(Number.isNaN)) problems.push(`${field.label}: use numbers separated by commas`); else rules[field.key] = ns; break; }
      case "dims2": case "dims3": {
        const n = field.kind === "dims2" ? 2 : 3; const ns = parts.map(num);
        if (ns.length !== n || ns.some(Number.isNaN)) problems.push(`${field.label}: give ${n} sizes, e.g. ${n === 2 ? "400 × 500" : "250 × 250 × 250"}`);
        else rules[field.key] = ns; break;
      }
      case "bool": rules[field.key] = /^(yes|true|on|1)$/i.test(raw); break;
      case "texts": rules[field.key] = raw.split(/[,;]/).map((x) => x.trim()).filter(Boolean); break;
      case "passive": if (!PASSIVES.includes(raw)) problems.push(`${field.label}: one of ${PASSIVES.join(", ")}`); else rules[field.key] = raw; break;
      case "text": rules[field.key] = raw; break;
    }
  }
  return { rules: rules as Rules, problems };
}

export const describeRule = (v: unknown, kind?: string): string =>
  Array.isArray(v) ? v.join(kind === "dims2" || kind === "dims3" ? " × " : ", ") : typeof v === "boolean" ? (v ? "yes" : "no") : String(v);

/**
 * Routing rules of the fab profiles VX Design builds boards with (mirrors services/engineering/vx_eng/fab.py), so a
 * fab package's clearance, thickness and finish are known from its profile name.
 */
export const FAB_PROFILE_FACTS: Record<string, { clearance_mm: number; thickness_mm: number; finish: string }> = {
  "jlcpcb-2layer-standard": { clearance_mm: 0.2, thickness_mm: 1.6, finish: "HASL (lead-free)" },
  "oshpark-2layer": { clearance_mm: 0.2032, thickness_mm: 1.6, finish: "ENIG" },
};

/** Reads enclosure facts from an enclosure fit report (vx_eng fit-report.json). */
export function enclosureFactsFromFitReport(r: {
  process?: { name?: string }; material?: string; dimensions_mm?: { x?: number; y?: number; z?: number }; spec?: { wall_mm?: number };
}): EnclosureFacts {
  const d = r.dimensions_mm;
  return {
    process: r.process?.name ?? null, material: r.material || null, wall_mm: r.spec?.wall_mm ?? null,
    dimensions_mm: d && d.x != null && d.y != null && d.z != null ? [d.x, d.y, d.z] : null,
  };
}
