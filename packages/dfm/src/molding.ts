/**
 * Injection molding: design rules per production material, a geometry check of a part's STL against them (draft in
 * the pull direction, wall thickness, undercuts, projected area and clamp force, shot weight), and the mold maker's
 * spec sheet. Rule values are typical published design guidance for unfilled general-purpose grades; the material
 * supplier's datasheet and the mold maker's DFM review have the final say.
 */
import { optionByKey, parseStl, PRODUCTION_MATERIALS, prodMaterialLabel, statsOf, type RouteLike } from "./materials.ts";

export interface MoldingRule {
  material: string; wall_mm: [number, number]; min_draft_deg: number; shrink_pct: [number, number]; density: number;
  /** Cavity pressure factor for a clamp estimate, tonnes per cm² of projected area. */
  clamp_t_per_cm2: number; rib_ratio: number; note: string;
}
export const MOLDING_RULES: Record<string, MoldingRule> = {
  abs:     { material: "abs", wall_mm: [1.2, 3.5], min_draft_deg: 1, shrink_pct: [0.4, 0.7], density: 1.04, clamp_t_per_cm2: 0.4, rib_ratio: 0.6, note: "Good cosmetic surface; paintable." },
  pc:      { material: "pc", wall_mm: [1.0, 3.8], min_draft_deg: 1, shrink_pct: [0.5, 0.7], density: 1.2, clamp_t_per_cm2: 0.6, rib_ratio: 0.6, note: "Needs high melt and mold temperature; sensitive to notches and solvents." },
  pc_abs:  { material: "pc_abs", wall_mm: [1.2, 3.5], min_draft_deg: 1, shrink_pct: [0.5, 0.7], density: 1.15, clamp_t_per_cm2: 0.5, rib_ratio: 0.6, note: "Common for handheld housings; V-0 grades available." },
  asa:     { material: "asa", wall_mm: [1.2, 3.5], min_draft_deg: 1, shrink_pct: [0.4, 0.7], density: 1.07, clamp_t_per_cm2: 0.4, rib_ratio: 0.6, note: "UV-stable ABS alternative for outdoor parts." },
  pa66_gf: { material: "pa66_gf", wall_mm: [0.8, 3.0], min_draft_deg: 0.5, shrink_pct: [0.3, 0.8], density: 1.37, clamp_t_per_cm2: 0.6, rib_ratio: 0.5, note: "Shrink differs along and across the glass flow: expect some warp; keep walls even." },
  pp:      { material: "pp", wall_mm: [0.8, 3.8], min_draft_deg: 1, shrink_pct: [1.0, 2.5], density: 0.9, clamp_t_per_cm2: 0.35, rib_ratio: 0.75, note: "High shrink; living hinges 0.25 to 0.5 mm." },
  pom:     { material: "pom", wall_mm: [0.8, 3.0], min_draft_deg: 0.5, shrink_pct: [1.8, 2.5], density: 1.41, clamp_t_per_cm2: 0.6, rib_ratio: 0.5, note: "High shrink; thick sections void; good for snap features." },
  tpe:     { material: "tpe", wall_mm: [0.5, 3.0], min_draft_deg: 2, shrink_pct: [0.5, 2.0], density: 1.1, clamp_t_per_cm2: 0.3, rib_ratio: 0.75, note: "Soft parts release poorly: generous draft; often overmolded on a rigid part." },
  pmma:    { material: "pmma", wall_mm: [0.6, 3.8], min_draft_deg: 1, shrink_pct: [0.2, 0.8], density: 1.18, clamp_t_per_cm2: 0.5, rib_ratio: 0.6, note: "Brittle; polished surfaces need more draft and SPI A finish." },
};
export const moldable = (material: string | null | undefined) => !!material && material in MOLDING_RULES;

export const FINISHES: { key: string; label: string; extra_draft_deg: number }[] = [
  { key: "SPI-A2", label: "SPI A-2 (high gloss)", extra_draft_deg: 0.5 },
  { key: "SPI-B2", label: "SPI B-2 (semi-gloss)", extra_draft_deg: 0 },
  { key: "SPI-C1", label: "SPI C-1 (matte, stone)", extra_draft_deg: 0 },
  { key: "SPI-D2", label: "SPI D-2 (bead blast)", extra_draft_deg: 1 },
  { key: "MT-11010", label: "MT-11010 (light texture)", extra_draft_deg: 1.5 },
  { key: "MT-11020", label: "MT-11020 (medium texture)", extra_draft_deg: 2.5 },
  { key: "MT-11030", label: "MT-11030 (heavy texture)", extra_draft_deg: 3.5 },
];
export const PULLS = ["+z", "-z", "+y", "-y", "+x", "-x"] as const;

export interface MoldingSpec {
  pull?: string; finish?: string; cosmetic_faces?: string; tolerance?: string; critical_dims?: string; gates?: string;
  inserts?: string; grade?: string; flammability?: string; cavities?: number | null; notes?: string;
}

/** The draft a surface needs: the material's minimum plus what the texture needs. */
export function requiredDraft(material: string, finish?: string): number {
  return (MOLDING_RULES[material]?.min_draft_deg ?? 1) + (FINISHES.find((f) => f.key === finish)?.extra_draft_deg ?? 0);
}

// ----- geometry ---------------------------------------------------------------------------------------------------

type V = [number, number, number];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Möller–Trumbore: distance along the ray to the triangle, or null. */
function hit(o: V, d: V, a: V, b: V, c: V): number | null {
  const e1 = sub(b, a), e2 = sub(c, a), p = cross(d, e2), det = dot(e1, p);
  if (Math.abs(det) < 1e-12) return null;
  const inv = 1 / det, s = sub(o, a), u = dot(s, p) * inv;
  if (u < 0 || u > 1) return null;
  const q = cross(s, e1), v = dot(d, q) * inv;
  if (v < 0 || u + v > 1) return null;
  const t = dot(e2, q) * inv;
  return t > 1e-6 ? t : null;
}

/** A uniform grid over the triangles for fast ray casting (3D DDA). */
class Grid {
  readonly min: V; readonly size: number; readonly n: V; readonly cells = new Map<number, number[]>(); readonly tri: V[][];
  constructor(tri: V[][]) {
    this.tri = tri;
    const lo: V = [Infinity, Infinity, Infinity], hi: V = [-Infinity, -Infinity, -Infinity];
    for (const t of tri) for (const p of t) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k]!, p[k]!); hi[k] = Math.max(hi[k]!, p[k]!); }
    const ext = sub(hi, lo).map((x) => Math.max(x, 1e-3)) as V;
    this.size = Math.max(Math.cbrt((ext[0] * ext[1] * ext[2]) / Math.max(1, tri.length / 2)), Math.max(...ext) / 200);
    this.min = [lo[0] - 1e-3, lo[1] - 1e-3, lo[2] - 1e-3];
    this.n = ext.map((x) => Math.max(1, Math.ceil((x + 2e-3) / this.size))) as V;
    tri.forEach((t, i) => {
      const a = [0, 1, 2].map((k) => this.cell(Math.min(t[0]![k]!, t[1]![k]!, t[2]![k]!), k));
      const b = [0, 1, 2].map((k) => this.cell(Math.max(t[0]![k]!, t[1]![k]!, t[2]![k]!), k));
      for (let x = a[0]!; x <= b[0]!; x++) for (let y = a[1]!; y <= b[1]!; y++) for (let z = a[2]!; z <= b[2]!; z++) {
        const key = (x * this.n[1] + y) * this.n[2] + z;
        const l = this.cells.get(key); if (l) l.push(i); else this.cells.set(key, [i]);
      }
    });
  }
  private cell(v: number, k: number) { return Math.min(this.n[k]! - 1, Math.max(0, Math.floor((v - this.min[k]!) / this.size))); }
  /** Nearest hit along the ray, skipping one triangle (the one the ray starts on). */
  cast(o: V, d: V, skip: number): number | null {
    const c = [0, 1, 2].map((k) => this.cell(o[k]!, k));
    const step = d.map((x) => (x > 0 ? 1 : x < 0 ? -1 : 0));
    const tMax = [0, 1, 2].map((k) => d[k] === 0 ? Infinity : ((this.min[k]! + (c[k]! + (step[k]! > 0 ? 1 : 0)) * this.size) - o[k]!) / d[k]!);
    const tDelta = [0, 1, 2].map((k) => d[k] === 0 ? Infinity : this.size / Math.abs(d[k]!));
    const seen = new Set<number>();
    for (let guard = 0; guard < 4000; guard++) {
      let best: number | null = null;
      for (const i of this.cells.get((c[0]! * this.n[1] + c[1]!) * this.n[2] + c[2]!) ?? []) {
        if (i === skip || seen.has(i)) continue;
        seen.add(i);
        const t = this.tri[i]!, h = hit(o, d, t[0]!, t[1]!, t[2]!);
        if (h != null && (best == null || h < best)) best = h;
      }
      const k = tMax[0]! < tMax[1]! ? (tMax[0]! < tMax[2]! ? 0 : 2) : (tMax[1]! < tMax[2]! ? 1 : 2);
      if (best != null && best <= tMax[k]! + 1e-9) return best;
      c[k]! += step[k]!; tMax[k]! += tDelta[k]!;
      if (c[k]! < 0 || c[k]! >= this.n[k]!) return best;
    }
    return null;
  }
}

export interface MoldingAnalysis {
  triangles: number; size_mm: [number, number, number]; volume_cm3: number;
  pull: string; required_draft_deg: number;
  /** Side-wall area (surfaces nearly parallel to the pull) with less draft than required, as a share of all surface. */
  low_draft_pct: number; zero_draft_pct: number;
  /** Area facing the pull or against it that a straight pull cannot release (needs a side action or lifter). */
  undercut_pct: number;
  wall: { nominal_mm: number; p05_mm: number; p95_mm: number; thin_pct: number; thick_pct: number; ratio: number } | null;
  projected_cm2: number; shot_g: number; clamp_t: number;
  findings: { level: "error" | "warning" | "info"; text: string }[];
}

/**
 * Checks an STL for molding: draft in the pull direction, undercuts, wall thickness (rays from the surface inward),
 * projected area, clamp force and shot weight. Large meshes are sampled for the ray checks.
 */
export function analyzeMolding(tris: number[][], material: string, spec: MoldingSpec = {}, maxRays = 6000): MoldingAnalysis {
  const rule = MOLDING_RULES[material] ?? MOLDING_RULES.abs!;
  const pull = (PULLS as readonly string[]).includes(spec.pull ?? "") ? spec.pull! : "+z";
  const axis = "xyz".indexOf(pull[1]!), sign = pull[0] === "-" ? -1 : 1;
  const d: V = [0, 0, 0]; d[axis] = sign;
  const need = requiredDraft(material, spec.finish);
  const sinNeed = Math.sin((need * Math.PI) / 180);
  const T: V[][] = tris.map((t) => [[t[0]!, t[1]!, t[2]!], [t[3]!, t[4]!, t[5]!], [t[6]!, t[7]!, t[8]!]]);
  const area: number[] = [], normal: V[] = [], cen: V[] = [];
  let total = 0, low = 0, zero = 0, proj = 0;
  for (const t of T) {
    const c = cross(sub(t[1]!, t[0]!), sub(t[2]!, t[0]!));
    const len = Math.hypot(...c) || 1;
    const a = len / 2, n = c.map((x) => x / len) as V, nd = dot(n, d);
    area.push(a); normal.push(n); cen.push([(t[0]![0] + t[1]![0] + t[2]![0]) / 3, (t[0]![1] + t[1]![1] + t[2]![1]) / 3, (t[0]![2] + t[1]![2] + t[2]![2]) / 3]);
    total += a;
    if (Math.abs(nd) < sinNeed) { low += a; if (Math.abs(nd) < 0.0087) zero += a; }   // 0.0087 ≈ sin 0.5°
    if (nd > 0) proj += a * nd;
  }
  const grid = new Grid(T);
  const stride = Math.max(1, Math.ceil(T.length / maxRays));
  let under = 0, sampledArea = 0;
  const walls: { t: number; a: number }[] = [];
  for (let i = 0; i < T.length; i += stride) {
    const n = normal[i]!, a = area[i]! * stride, nd = dot(n, d);
    sampledArea += a;
    const o = (eps: number, dir: V): V => [cen[i]![0] + dir[0] * eps, cen[i]![1] + dir[1] * eps, cen[i]![2] + dir[2] * eps];
    if (Math.abs(nd) >= sinNeed) {
      const dir: V = nd > 0 ? d : [-d[0], -d[1], -d[2]];
      if (grid.cast(o(1e-4, dir), dir, i) != null) under += a;
    }
    const inward: V = [-n[0], -n[1], -n[2]];
    const th = grid.cast(o(1e-4, inward), inward, i);
    if (th != null) walls.push({ t: th, a });
  }
  const pct = (x: number, of: number) => Math.round((1000 * x) / Math.max(of, 1e-9)) / 10;
  let wall: MoldingAnalysis["wall"] = null;
  if (walls.length) {
    walls.sort((x, y) => x.t - y.t);
    const tot = walls.reduce((s, w) => s + w.a, 0);
    const at = (q: number) => { let acc = 0; for (const w of walls) { acc += w.a; if (acc >= q * tot) return w.t; } return walls.at(-1)!.t; };
    const nominal = at(0.5), r2 = (x: number) => Math.round(x * 100) / 100;
    wall = { nominal_mm: r2(nominal), p05_mm: r2(at(0.05)), p95_mm: r2(at(0.95)),
             thin_pct: pct(walls.filter((w) => w.t < rule.wall_mm[0]).reduce((s, w) => s + w.a, 0), tot),
             thick_pct: pct(walls.filter((w) => w.t > rule.wall_mm[1]).reduce((s, w) => s + w.a, 0), tot),
             ratio: r2(at(0.95) / Math.max(nominal, 1e-6)) };
  }
  const st = statsOf(tris);
  const projected_cm2 = Math.round(proj) / 100;
  const cavities = spec.cavities && spec.cavities > 0 ? spec.cavities : 1;
  const clamp_t = Math.round(projected_cm2 * rule.clamp_t_per_cm2 * cavities * 1.2 * 10) / 10;
  const shot_g = Math.round(st.volume_cm3 * rule.density * 10) / 10;
  const a: MoldingAnalysis = { triangles: tris.length, size_mm: st.size_mm, volume_cm3: st.volume_cm3, pull, required_draft_deg: need,
    low_draft_pct: pct(low, total), zero_draft_pct: pct(zero, total), undercut_pct: pct(under, sampledArea), wall, projected_cm2, shot_g, clamp_t, findings: [] };
  const F = a.findings, M = prodMaterialLabel(material);
  if (a.zero_draft_pct > 1) F.push({ level: "error", text: `${a.zero_draft_pct}% of the surface is parallel to the pull with no draft: add at least ${need}° (${M}${spec.finish ? `, ${spec.finish}` : ""}) or the part sticks and drags on ejection.` });
  else if (a.low_draft_pct > 1) F.push({ level: "warning", text: `${a.low_draft_pct}% of the surface has less than ${need}° of draft.` });
  if (a.undercut_pct > 0.5) F.push({ level: "warning", text: `${a.undercut_pct}% of the surface cannot be released by a straight ${pull} pull (undercuts): each needs a side action or lifter (adds tool cost), or redesign (pass-through cores, bump-offs).` });
  if (wall) {
    if (wall.thin_pct > 2) F.push({ level: "warning", text: `${wall.thin_pct}% of the walls are thinner than ${rule.wall_mm[0]} mm: ${M} may not fill them.` });
    // Rays from the ends of walls (rims, edges) run along the wall, so a few percent of 'thick' readings are normal.
    if (wall.thick_pct > 5) F.push({ level: "error", text: `${wall.thick_pct}% of the walls are thicker than ${rule.wall_mm[1]} mm: sink marks, voids and long cycles. Core out thick areas and keep walls near ${wall.nominal_mm} mm.` });
    if (wall.ratio > 1.5) F.push({ level: "warning", text: `Walls vary from ${wall.nominal_mm} mm to ${wall.p95_mm} mm (×${wall.ratio}): keep changes under ×1.5 and blend them gradually to avoid sink and warp.` });
    const base = Math.min(Math.max(wall.nominal_mm, rule.wall_mm[0]), rule.wall_mm[1]);
    F.push({ level: "info", text: `Ribs ${Math.round(rule.rib_ratio * base * 100) / 100} mm thick at most (${Math.round(rule.rib_ratio * 100)}% of a ${base} mm wall), no taller than 3× the wall; bosses' outer wall about 60% of the nominal wall, tied to walls with ribs.` });
  } else F.push({ level: "warning", text: "Wall thickness could not be measured (the model is not a closed solid)." });
  F.push({ level: "info", text: `Shrink ${rule.shrink_pct[0]} to ${rule.shrink_pct[1]}%: the mold maker scales the cavity for the chosen grade. ${rule.note}` });
  return a;
}

export function analyzeStl(bytes: Uint8Array, material: string, spec: MoldingSpec = {}) {
  return analyzeMolding(parseStl(bytes), material, spec);
}

/** Tool class (SPI-SPE) and cavity count suggested from the yearly volume over a 3-year life. */
export function toolSuggestion(volume: number | null | undefined): { tool: string; cavities: string; life: number } {
  const life = (volume ?? 0) * 3;
  const tool = life > 1_000_000 ? "SPI Class 101 (hardened steel, over 1 million cycles)" : life > 500_000 ? "SPI Class 102 (up to 1 million cycles)"
    : life > 100_000 ? "SPI Class 103 (up to 500,000 cycles)" : life > 5_000 ? "SPI Class 104 (up to 100,000 cycles; aluminium or P20)"
    : "SPI Class 105 or an aluminium prototype tool (a few thousand parts)";
  const cavities = (volume ?? 0) >= 100_000 ? "2 to 4 cavities" : (volume ?? 0) >= 20_000 ? "1 or 2 cavities" : "1 cavity (or a family tool with the mating part)";
  return { tool, cavities, life };
}

/** The mold maker's spec sheet (Markdown) for one part. */
export function moldingSheet(project: string, date: string, route: RouteLike, spec: MoldingSpec, a: MoldingAnalysis | null, files: string[]): string {
  const m = route.production_material ?? "";
  const rule = MOLDING_RULES[m];
  const t = toolSuggestion(route.production_volume);
  const proto = optionByKey(route.prototype_option);
  const L = [`# ${route.name}: injection molding package`, "", `${project} · ${date} · files: ${files.join(", ") || "none"}`, "",
    "## Part and material", "",
    `- **Material:** ${prodMaterialLabel(m)}${spec.grade ? `, ${spec.grade}` : " (grade to be agreed)"}${spec.flammability ? `, ${spec.flammability}` : ""}`,
    `- **Colour and finish:** ${route.finish ?? "to be agreed"}; mold finish ${FINISHES.find((f) => f.key === spec.finish)?.label ?? "to be agreed"}`,
    `- **Cosmetic (A) surfaces:** ${spec.cosmetic_faces || "to be agreed"}. No gate, ejector or parting marks on A surfaces.`,
    `- **Gates and ejectors:** ${spec.gates || "mold maker to propose; gate and ejector locations to be approved before steel is cut"}`,
    `- **Pull direction:** ${a?.pull ?? spec.pull ?? "+z"} (model coordinates)`,
    `- **Tolerances:** ${spec.tolerance || "ISO 20457 TG6 general; tighter only where listed"}`,
    `- **Critical dimensions:** ${spec.critical_dims || "none listed"}`,
    `- **Inserts and secondary operations:** ${spec.inserts || "none"}`,
    `- **Volume:** about ${route.production_volume ? route.production_volume.toLocaleString("en-US") : "?"} a year`,
    `- **Suggested tool:** ${t.tool}; ${spec.cavities ? `${spec.cavities} cavit${spec.cavities === 1 ? "y" : "ies"} requested` : t.cavities}`,
  ];
  if (rule) L.push(`- **Design rules used:** walls ${rule.wall_mm[0]} to ${rule.wall_mm[1]} mm, draft at least ${requiredDraft(m, spec.finish)}°, shrink ${rule.shrink_pct[0]} to ${rule.shrink_pct[1]}%`);
  if (proto) L.push(`- **Prototypes so far:** ${proto.material} (${proto.process.replace("_", "/")}); they confirm fit, not molded behaviour.`);
  if (spec.notes) L.push("", `**Notes:** ${spec.notes}`);
  L.push("", "## Design check (from the model)", "");
  if (a) {
    L.push(`- Size ${a.size_mm.join(" × ")} mm; volume ${a.volume_cm3} cm³; shot about ${a.shot_g} g per part (runner not included)`,
      `- Projected area about ${a.projected_cm2} cm²; clamp about ${a.clamp_t} t (with 20% margin${spec.cavities && spec.cavities > 1 ? `, ${spec.cavities} cavities` : ""})`,
      `- Draft: ${a.low_draft_pct}% of the surface below ${a.required_draft_deg}° (${a.zero_draft_pct}% with none)`,
      `- Undercuts for a ${a.pull} pull: ${a.undercut_pct}% of the surface`,
      a.wall ? `- Walls: nominal ${a.wall.nominal_mm} mm (5% ${a.wall.p05_mm} mm, 95% ${a.wall.p95_mm} mm); ${a.wall.thin_pct}% thinner and ${a.wall.thick_pct}% thicker than the material's range` : "- Walls: not measured",
      "", ...a.findings.map((f) => `- **${f.level === "error" ? "Fix" : f.level === "warning" ? "Check" : "Note"}:** ${f.text}`));
  } else L.push("- No STL to check: the mold maker's DFM review is the only check.");
  L.push("", "## Please quote", "", "- Tool: steel, class, cavities, hot or cold runner, lead time to first shots (T1)",
    "- Part price at the yearly volume, and at 2× and 0.5×", "- Your DFM report with proposed gate, ejector and parting line, before steel is cut",
    "- T1 samples with a dimensional report against the critical dimensions; changes between T1 and T2 included or quoted",
    "- Tool ownership, maintenance and storage terms");
  return L.join("\n") + "\n";
}

export const MOLDING_MATERIALS = PRODUCTION_MATERIALS.filter((m) => moldable(m.key));
