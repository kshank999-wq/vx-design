/**
 * Manufacturing routes: how each physical part is made now (prototype) and later (production), with ranked
 * prototype suggestions. Ratings are qualitative (1 poor … 5 excellent) and heat figures approximate: they choose
 * between options, they do not replace the supplier's datasheet for the exact grade.
 */

export type ProtoProcess = "fdm" | "sla" | "sls_mjf" | "urethane_cast" | "cnc";
export type ProdProcess = "injection_molding" | "cnc" | "sheet_metal" | "die_casting" | "urethane_cast" | "same_as_prototype";

export const PROTO_PROCESSES: { key: ProtoProcess; label: string }[] = [
  { key: "fdm", label: "3D printing, FDM (filament)" },
  { key: "sla", label: "3D printing, SLA (resin)" },
  { key: "sls_mjf", label: "3D printing, SLS or MJF (nylon powder)" },
  { key: "urethane_cast", label: "Urethane casting (silicone mould, 10 to 50 parts)" },
  { key: "cnc", label: "CNC machining" },
];
export const PROD_PROCESSES: { key: ProdProcess; label: string }[] = [
  { key: "injection_molding", label: "Injection molding" },
  { key: "cnc", label: "CNC machining" },
  { key: "sheet_metal", label: "Sheet metal" },
  { key: "die_casting", label: "Die casting" },
  { key: "urethane_cast", label: "Urethane casting (low volume)" },
  { key: "same_as_prototype", label: "Same as the prototype (low volume)" },
];

export interface ProductionMaterial { key: string; label: string; processes: ProdProcess[]; note: string }
export const PRODUCTION_MATERIALS: ProductionMaterial[] = [
  { key: "pc_abs", label: "PC/ABS", processes: ["injection_molding"], note: "Common for handheld electronics housings: tough, good finish, UL94 V-0 grades." },
  { key: "abs", label: "ABS", processes: ["injection_molding", "cnc"], note: "Low cost, good finish; not UV stable without a coating." },
  { key: "pc", label: "Polycarbonate (PC)", processes: ["injection_molding", "cnc"], note: "Very impact resistant, clear grades; prone to stress cracking near solvents." },
  { key: "asa", label: "ASA", processes: ["injection_molding"], note: "Like ABS but UV stable: outdoor housings." },
  { key: "pa66_gf", label: "Nylon PA66, glass filled", processes: ["injection_molding"], note: "Stiff and strong for frames and brackets; absorbs moisture." },
  { key: "pp", label: "Polypropylene (PP)", processes: ["injection_molding"], note: "Living hinges, chemical resistance; hard to paint or glue." },
  { key: "pom", label: "Acetal (POM)", processes: ["injection_molding", "cnc"], note: "Low friction: gears, latches, sliding parts." },
  { key: "tpe", label: "TPE / TPU (rubber-like)", processes: ["injection_molding"], note: "Grips, bumpers, seals; often overmolded on a rigid part." },
  { key: "pmma", label: "Acrylic (PMMA)", processes: ["injection_molding", "cnc"], note: "Clear windows and light pipes; brittle." },
  { key: "al6061", label: "Aluminium 6061", processes: ["cnc", "sheet_metal"], note: "Machined or bent housings, heat spreading; anodised." },
  { key: "al_adc12", label: "Aluminium ADC12", processes: ["die_casting"], note: "Die-cast housings at volume; machined after casting where precise." },
  { key: "steel", label: "Steel (cold rolled or stainless)", processes: ["sheet_metal"], note: "Brackets and frames; plated or powder coated." },
];

type Rating = 1 | 2 | 3 | 4 | 5;
export interface PrototypeOption {
  key: string; process: ProtoProcess; material: string;
  /** Approximate heat deflection temperature at 0.45 MPa, °C. */
  heat_c: number;
  strength: Rating; impact: Rating; uv: Rating; flex: Rating; finish: Rating; cost: Rating; speed: Rating;
  clear?: boolean; rubber?: boolean;
  /** Production materials this is a fair stand-in for. */
  stands_in_for: string[];
  good_for: string; watch_out: string;
}

export const PROTOTYPE_OPTIONS: PrototypeOption[] = [
  { key: "fdm_pla", process: "fdm", material: "PLA", heat_c: 55, strength: 3, impact: 2, uv: 2, flex: 1, finish: 3, cost: 5, speed: 4, stands_in_for: [],
    good_for: "Quick fit and size checks on the bench.", watch_out: "Softens in a hot car or in sun on a set (about 55 °C); brittle. Not for anything that gets handled." },
  { key: "fdm_petg", process: "fdm", material: "PETG", heat_c: 70, strength: 3, impact: 3, uv: 3, flex: 2, finish: 3, cost: 5, speed: 4, stands_in_for: ["abs", "pc_abs"],
    good_for: "Cheap functional prototypes you can handle and drop lightly; easy to print.", watch_out: "Softens about 70 °C; strings; layers are the weak direction." },
  { key: "fdm_asa", process: "fdm", material: "ASA", heat_c: 95, strength: 3, impact: 3, uv: 5, flex: 2, finish: 3, cost: 4, speed: 4, stands_in_for: ["asa", "abs", "pc_abs"],
    good_for: "Outdoor and sunlit use; closest filament to a molded ABS/ASA housing.", watch_out: "Needs an enclosed printer; warps on large flat parts." },
  { key: "fdm_pc", process: "fdm", material: "Polycarbonate (PC)", heat_c: 115, strength: 4, impact: 4, uv: 3, flex: 2, finish: 3, cost: 3, speed: 3, stands_in_for: ["pc", "pc_abs"],
    good_for: "Tough, heat-resistant functional parts.", watch_out: "Hard to print (hot nozzle, enclosure, dry filament); warps." },
  { key: "fdm_pacf", process: "fdm", material: "Nylon, carbon filled (PA-CF)", heat_c: 150, strength: 5, impact: 3, uv: 4, flex: 1, finish: 3, cost: 3, speed: 3, stands_in_for: ["pa66_gf"],
    good_for: "Stiff brackets, frames and mounts.", watch_out: "Must be dried; hardened nozzle; matte, not a cosmetic surface." },
  { key: "fdm_tpu", process: "fdm", material: "TPU 95A", heat_c: 60, strength: 2, impact: 5, uv: 3, flex: 5, finish: 2, cost: 4, speed: 2, rubber: true, stands_in_for: ["tpe"],
    good_for: "Bumpers, grips, feet and simple gaskets.", watch_out: "Prints slowly; softer grades (85A) need a direct-drive printer." },
  { key: "sla_standard", process: "sla", material: "Standard resin", heat_c: 50, strength: 3, impact: 1, uv: 1, flex: 1, finish: 5, cost: 4, speed: 4, stands_in_for: [],
    good_for: "Looks-like models, photos and client reviews: fine detail, smooth surface.", watch_out: "Brittle; yellows and weakens in sunlight. Not for snap fits or drops." },
  { key: "sla_tough", process: "sla", material: "Tough resin (ABS-like)", heat_c: 60, strength: 3, impact: 3, uv: 2, flex: 2, finish: 5, cost: 3, speed: 4, stands_in_for: ["abs", "pc_abs"],
    good_for: "Fine-detail housings that also get handled; small snap fits and screw bosses.", watch_out: "Heat and UV limited; strength depends on full post-curing." },
  { key: "sla_durable", process: "sla", material: "Durable resin (PP-like)", heat_c: 45, strength: 2, impact: 4, uv: 2, flex: 4, finish: 4, cost: 3, speed: 4, stands_in_for: ["pp"],
    good_for: "Snap fits, clips and bending parts.", watch_out: "Soft and low heat resistance; not stiff enough for a whole housing." },
  { key: "sla_hightemp", process: "sla", material: "High-temperature resin", heat_c: 230, strength: 3, impact: 1, uv: 2, flex: 1, finish: 5, cost: 2, speed: 4, stands_in_for: [],
    good_for: "Parts next to heat (regulators, lamps), test fixtures.", watch_out: "Very brittle." },
  { key: "sla_clear", process: "sla", material: "Clear resin", heat_c: 70, strength: 3, impact: 2, uv: 1, flex: 1, finish: 4, cost: 3, speed: 4, clear: true, stands_in_for: ["pmma", "pc"],
    good_for: "Windows, light pipes, LED lenses (polish or clear-coat for full transparency).", watch_out: "Yellows over time and in sun." },
  { key: "sla_elastic", process: "sla", material: "Flexible or elastic resin (50A to 80A)", heat_c: 40, strength: 1, impact: 4, uv: 2, flex: 5, finish: 4, cost: 2, speed: 4, rubber: true, stands_in_for: ["tpe"],
    good_for: "Soft-touch buttons, keypads, seals in fine detail.", watch_out: "Tears more easily than molded silicone or TPE." },
  { key: "mjf_pa12", process: "sls_mjf", material: "Nylon PA12", heat_c: 175, strength: 4, impact: 4, uv: 4, flex: 3, finish: 3, cost: 3, speed: 3, stands_in_for: ["pa66_gf", "abs", "pc_abs", "pp"],
    good_for: "Functional housings that behave much like molded plastic: snap fits, drops, heat. No support marks, good for 5 to 100 parts.", watch_out: "Slightly grainy grey surface (dye black or vapour smooth); ordered from a service, not printed at the desk." },
  { key: "mjf_pa11", process: "sls_mjf", material: "Nylon PA11", heat_c: 180, strength: 4, impact: 5, uv: 4, flex: 4, finish: 3, cost: 3, speed: 3, stands_in_for: ["pc", "pc_abs", "pp"],
    good_for: "Parts that must survive drops and repeated flexing.", watch_out: "Ordered from a service; a little more flexible than PA12." },
  { key: "sls_tpu", process: "sls_mjf", material: "TPU (powder)", heat_c: 60, strength: 2, impact: 5, uv: 3, flex: 5, finish: 3, cost: 3, speed: 3, rubber: true, stands_in_for: ["tpe"],
    good_for: "Bumpers and grips with complex shapes.", watch_out: "Ordered from a service." },
  { key: "cast_abs", process: "urethane_cast", material: "ABS-like polyurethane, colour matched", heat_c: 80, strength: 4, impact: 4, uv: 3, flex: 2, finish: 5, cost: 2, speed: 2, stands_in_for: ["abs", "pc_abs", "asa"],
    good_for: "A pilot batch (10 to 50) that looks and feels like the molded product, in the production colour and texture, before paying for tooling.", watch_out: "Needs a master part (usually SLA); each silicone mould makes about 20 parts; 2 to 3 weeks." },
  { key: "cast_pc", process: "urethane_cast", material: "PC-like clear polyurethane", heat_c: 90, strength: 4, impact: 4, uv: 3, flex: 2, finish: 5, cost: 2, speed: 2, clear: true, stands_in_for: ["pc", "pmma"],
    good_for: "Clear windows and lenses in a pilot batch.", watch_out: "As for cast ABS-like." },
  { key: "cast_tpe", process: "urethane_cast", material: "Rubber-like polyurethane (Shore 40A to 90A)", heat_c: 60, strength: 2, impact: 5, uv: 3, flex: 5, finish: 5, cost: 2, speed: 2, rubber: true, stands_in_for: ["tpe"],
    good_for: "Grips and overmold stand-ins in the right hardness and colour.", watch_out: "As for cast ABS-like." },
  { key: "cnc_pom", process: "cnc", material: "Acetal (POM), machined", heat_c: 110, strength: 4, impact: 3, uv: 2, flex: 3, finish: 4, cost: 2, speed: 3, stands_in_for: ["pom"],
    good_for: "Precise sliding parts, latches, gears.", watch_out: "Machining cannot make the ribs, draft and thin bosses of a molded part." },
  { key: "cnc_abs", process: "cnc", material: "ABS or PC, machined", heat_c: 95, strength: 4, impact: 4, uv: 2, flex: 2, finish: 4, cost: 1, speed: 3, stands_in_for: ["abs", "pc", "pc_abs"],
    good_for: "Exactly the production plastic, for testing material behaviour.", watch_out: "Expensive; the geometry is a machined version of the molded part." },
  { key: "cnc_al", process: "cnc", material: "Aluminium 6061, machined", heat_c: 400, strength: 5, impact: 5, uv: 5, flex: 1, finish: 4, cost: 1, speed: 3, stands_in_for: ["al6061", "al_adc12"],
    good_for: "Metal housings and heat spreaders; the production part itself at low volume.", watch_out: "Blocks radio: plan antenna windows." },
];

/** What the part has to survive. Derived from the requirements where possible; the owner corrects it. */
export interface PartNeeds {
  outdoor?: boolean;        // sun on a set, outdoor use
  max_temp_c?: number | null;
  impact?: boolean;         // dropped, knocked
  snap_fits?: boolean;      // clips, flexing features
  flexible?: boolean;       // the part itself is rubber-like
  clear?: boolean;          // window, lens, light pipe
  cosmetic?: boolean;       // seen by clients: photos, reviews
  precise?: boolean;        // tight fits, sliding parts
  quantity?: number | null; // prototypes needed
}

export interface Suggestion { option: PrototypeOption; score: number; reasons: string[]; cautions: string[] }

/**
 * Ranks prototype options for a part. Hard limits rule an option out (a rigid material for a rubber part, heat below
 * the part's maximum temperature, an opaque material for a window); the rest are scored on what the part needs,
 * on how well each stands in for the production material, and on cost and speed for the quantity.
 */
export function suggestPrototypes(needs: PartNeeds, production: { process?: string | null; material?: string | null } = {}, limit = 4): Suggestion[] {
  const out: Suggestion[] = [];
  const qty = needs.quantity ?? 1;
  for (const o of PROTOTYPE_OPTIONS) {
    if (needs.flexible ? !o.rubber : o.rubber) continue;
    if (needs.clear && !o.clear) continue;
    if (needs.max_temp_c != null && o.heat_c < needs.max_temp_c + 10) continue;
    if (production.process === "sheet_metal" || production.process === "die_casting") { if (o.process !== "cnc" && o.process !== "fdm" && o.process !== "sla") continue; }
    const reasons: string[] = [], cautions: string[] = [];
    let score = 0;
    if (needs.max_temp_c != null) { score += 1; reasons.push(`handles ${needs.max_temp_c} °C (about ${o.heat_c} °C before softening)`); }
    if (needs.outdoor) { score += (o.uv - 3) * 2; (o.uv >= 4 ? reasons : cautions).push(o.uv >= 4 ? "UV stable for outdoor use" : "degrades in sunlight: fine for indoor testing only"); }
    if (needs.impact) { score += (o.impact - 3) * 2; (o.impact >= 4 ? reasons : o.impact <= 2 ? cautions : reasons).push(o.impact >= 4 ? "survives drops" : o.impact <= 2 ? "cracks if dropped" : "takes light knocks"); }
    if (needs.snap_fits) { score += (Math.min(o.flex, 4) - 2) * 2; (o.flex >= 3 ? reasons : cautions).push(o.flex >= 3 ? "snap fits flex without breaking" : "snap fits may crack: test a few cycles"); }
    if (needs.cosmetic) { score += (o.finish - 3) * 2; (o.finish >= 4 ? reasons : cautions).push(o.finish >= 4 ? "smooth surface for photos and reviews" : "visible layer lines or grain: sand, paint or smooth for reviews"); }
    if (needs.precise) { score += o.process === "cnc" || o.process === "sla" ? 2 : o.process === "fdm" ? -2 : 0; if (o.process === "fdm") cautions.push("FDM tolerances are about ±0.2 to 0.3 mm"); }
    if (!needs.cosmetic && !needs.impact && !needs.outdoor && !needs.snap_fits && !needs.flexible && !needs.clear) score += (o.cost - 3) + (o.speed - 3);
    if (production.material) {
      if (o.stands_in_for.includes(production.material)) { score += 3; reasons.push(`a fair stand-in for production ${label(production.material)}`); }
      else if (production.process === "injection_molding") cautions.push(`behaves differently from production ${label(production.material)}: do not sign off strength or drop tests on it`);
    }
    if (qty >= 10) {
      if (o.process === "urethane_cast" || o.process === "sls_mjf") { score += 2; reasons.push(`economical for ${qty} parts`); }
      else if (o.process === "cnc") { score -= 2; cautions.push(`expensive at ${qty} parts`); }
    } else if (o.process === "urethane_cast") { score -= 3; cautions.push("casting only pays off from about 10 parts"); }
    score += (o.cost - 3) * 0.5;
    out.push({ option: o, score, reasons, cautions });
  }
  return out.sort((a, b) => b.score - a.score || b.option.cost - a.option.cost).slice(0, limit);
}

const label = (k: string) => PRODUCTION_MATERIALS.find((m) => m.key === k)?.label ?? k;
export const optionByKey = (k: string | null | undefined) => PROTOTYPE_OPTIONS.find((o) => o.key === k) ?? null;

/** Reads needs from requirement text: a starting point the owner confirms. */
export function needsFromRequirements(texts: string[]): PartNeeds {
  const t = texts.join("\n").toLowerCase();
  const temps = [...t.matchAll(/(?:up to|to|maximum|max\.?|≤|<=)\s*\+?(\d{2,3})\s*°?\s*c\b/g)].map((m) => Number(m[1])).filter((n) => n >= 35 && n <= 200);
  return {
    outdoor: /outdoor|sunlight|direct sun|\buv\b|weather/.test(t) || undefined,
    max_temp_c: temps.length ? Math.max(...temps) : null,
    impact: /\bdrop|impact|rugged|shock/.test(t) || undefined,
    snap_fits: /snap[- ]?fit|clip/.test(t) || undefined,
    cosmetic: /cosmetic|appearance|finish|premium/.test(t) || undefined,
  };
}

export interface PrintSettings { lines: string[] }
/** Starting settings to give a printer operator or a print service. */
export function printSettings(o: PrototypeOption): PrintSettings {
  const L: string[] = [];
  if (o.process === "fdm") {
    L.push("Layer height 0.2 mm (0.12 mm for show models); 0.4 mm nozzle.",
      "At least 4 perimeters (1.6 mm) so screw bosses and walls are solid; 25 to 40 % gyroid infill.",
      "Orient so the outer show faces are vertical or on the bed; put screw bosses upright (layer lines across a boss split it).",
      "Heat-set brass inserts: press at the insert maker's temperature, square to the boss.");
    if (/ASA|ABS|PC|Nylon/.test(o.material)) L.push("Enclosed printer, no drafts; brim on large flat parts against warping.");
    if (/PETG|PC|Nylon|TPU/.test(o.material)) L.push("Dry the filament before printing.");
    if (/TPU/.test(o.material)) L.push("Print slowly (about 20 to 30 mm/s); direct-drive extruder.");
  } else if (o.process === "sla") {
    L.push("Layer height 0.05 to 0.1 mm; tilt flat faces 15 to 30° so supports land off the show faces.",
      "Add drain holes to closed hollows; wash and fully post-cure (strength depends on it).",
      "Walls at least 1 mm; screw bosses get heat-set or press-fit inserts, not threads in resin.");
  } else if (o.process === "sls_mjf") {
    L.push("No supports needed; walls at least 1 mm, gaps between moving parts at least 0.5 mm.",
      "Ask for dyed black or vapour-smoothed finish for show parts.",
      "Escape holes (2 mm or more) for powder in closed hollows.");
  } else if (o.process === "urethane_cast") {
    L.push("Send an SLA master or ask the caster to print one; give the colour (Pantone or RAL), texture and Shore hardness.",
      "Draft of 1 to 2° helps the silicone mould release; undercuts are possible.");
  } else {
    L.push("Send STEP with a 2D drawing for tolerances, threads and finish; internal corners need a tool radius.");
  }
  return { lines: L };
}

/** Typical build volumes (mm) to check a part fits before sending it. */
export const BUILD_VOLUMES: { process: ProtoProcess; label: string; mm: [number, number, number] }[] = [
  { process: "fdm", label: "desktop FDM printer (about 250 × 210 × 210 mm)", mm: [250, 210, 210] },
  { process: "sla", label: "desktop SLA printer (about 200 × 125 × 210 mm)", mm: [200, 125, 210] },
  { process: "sls_mjf", label: "MJF service machine (about 380 × 284 × 380 mm)", mm: [380, 284, 380] },
];
const DENSITY: Record<string, number> = { PLA: 1.24, PETG: 1.27, ASA: 1.07, "Polycarbonate (PC)": 1.2, "Nylon, carbon filled (PA-CF)": 1.15, "TPU 95A": 1.21,
  "Nylon PA12": 1.01, "Nylon PA11": 1.03, "TPU (powder)": 1.2 };

export interface StlStats { triangles: number; size_mm: [number, number, number]; volume_cm3: number }

/** Size and enclosed volume of an STL (binary or ASCII). */
export function stlStats(bytes: Uint8Array): StlStats {
  const tris: number[][] = [];
  const head = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 512))).trimStart();
  const binaryCount = bytes.length >= 84 ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(80, true) : -1;
  if (binaryCount >= 0 && 84 + binaryCount * 50 === bytes.length) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < binaryCount; i++) {
      const o = 84 + i * 50 + 12;
      tris.push(Array.from({ length: 9 }, (_, k) => dv.getFloat32(o + k * 4, true)));
    }
  } else if (head.startsWith("solid")) {
    const v = [...new TextDecoder().decode(bytes).matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g)].map((m) => [Number(m[1]), Number(m[2]), Number(m[3])]);
    for (let i = 0; i + 2 < v.length; i += 3) tris.push([...v[i]!, ...v[i + 1]!, ...v[i + 2]!]);
  } else throw new Error("not an STL file");
  if (!tris.length) throw new Error("the STL has no triangles");
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  let vol = 0;
  for (const t of tris) {
    for (let k = 0; k < 9; k++) { const a = k % 3; min[a] = Math.min(min[a]!, t[k]!); max[a] = Math.max(max[a]!, t[k]!); }
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = t as [number, number, number, number, number, number, number, number, number];
    vol += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  const r = (n: number) => Math.round(n * 10) / 10;
  return { triangles: tris.length, size_mm: [r(max[0]! - min[0]!), r(max[1]! - min[1]!), r(max[2]! - min[2]!)], volume_cm3: Math.round(Math.abs(vol) / 10) / 100 };
}

/** Which build volumes a part fits, in any orientation that keeps it axis-aligned. */
export function fitsBuildVolumes(size: [number, number, number]) {
  const s = [...size].sort((a, b) => b - a);
  return BUILD_VOLUMES.map((b) => { const m = [...b.mm].sort((x, y) => y - x); return { ...b, fits: s.every((v, i) => v <= m[i]!) }; });
}

/** Material use estimate in grams: a range for FDM (shell and infill), solid for resin and powder. */
export function massEstimate(o: PrototypeOption, volume_cm3: number): [number, number] | null {
  const d = DENSITY[o.material] ?? (o.process === "sla" ? 1.15 : o.process === "urethane_cast" ? 1.1 : null);
  if (d == null || o.process === "cnc") return null;
  const solid = volume_cm3 * d;
  return o.process === "fdm" ? [Math.round(solid * 0.6), Math.round(solid * 0.9)] : [Math.round(solid), Math.round(solid)];
}

export const prodProcessLabel = (k: string | null) => PROD_PROCESSES.find((p) => p.key === k)?.label ?? k ?? "not decided";
export const prodMaterialLabel = (k: string | null) => PRODUCTION_MATERIALS.find((p) => p.key === k)?.label ?? k ?? "not decided";

export interface RouteLike {
  name: string; prototype_option: string | null; prototype_qty: number | null; production_process: string | null;
  production_material: string | null; production_volume: number | null; finish: string | null; notes: string | null;
}
/** One line per route, for the planner and the enclosure designer. */
export function routeLine(r: RouteLike): string {
  const o = optionByKey(r.prototype_option);
  const proto = o ? `${o.material} (${o.process.replace("_", "/")})${r.prototype_qty ? ` × ${r.prototype_qty}` : ""}` : "not decided";
  const prod = r.production_process ? `${prodProcessLabel(r.production_process)}${r.production_material ? `, ${prodMaterialLabel(r.production_material)}` : ""}` +
    `${r.production_volume ? `, about ${r.production_volume.toLocaleString("en-US")} a year` : ""}` : "not decided";
  return `${r.name}: prototype ${proto}; production ${prod}${r.finish ? `; finish ${r.finish}` : ""}${r.notes ? `. ${r.notes}` : ""}`;
}

export interface PrintPart {
  folder: string; route: RouteLike; files: string[]; stats: StlStats | null;
}

/** The sheet that goes with a 3D-print export: per part, what to print it in, how, how many, and what it stands in for. */
export function printSheet(project: string, date: string, parts: PrintPart[]): { markdown: string; csv: string } {
  const L = [`# ${project}: 3D printing pack`, "", `Exported ${date}. One folder per part with its print file (STL) and CAD (STEP) where available.`,
    "Settings are starting points: the printer operator or print service has the final say for their machine.", ""];
  const rows = [["part", "files", "process", "material", "quantity", "finish", "size_mm", "volume_cm3", "est_mass_g_each"]];
  for (const p of parts) {
    const o = optionByKey(p.route.prototype_option);
    L.push(`## ${p.route.name}`, "", `Folder: \`${p.folder}/\` (${p.files.join(", ") || "no model file yet"})`, "");
    L.push(`- **Print in:** ${o ? `${o.material}, ${PROTO_PROCESSES.find((x) => x.key === o.process)?.label}` : "not chosen yet: see the suggestions on the Manufacturing page"}`);
    L.push(`- **Quantity:** ${p.route.prototype_qty ?? 1}`);
    if (p.route.finish) L.push(`- **Colour and finish:** ${p.route.finish}`);
    let mass: [number, number] | null = null;
    if (p.stats) {
      L.push(`- **Size:** ${p.stats.size_mm.join(" × ")} mm; volume ${p.stats.volume_cm3} cm³`);
      if (o) {
        mass = massEstimate(o, p.stats.volume_cm3);
        if (mass) L.push(`- **Material per part (estimate):** ${mass[0] === mass[1] ? `${mass[0]} g` : `${mass[0]} to ${mass[1]} g`}`);
        const fit = fitsBuildVolumes(p.stats.size_mm).find((b) => b.process === o.process);
        if (fit && !fit.fits) L.push(`- **Too big for a ${fit.label}:** split the part or use a larger machine or a print service.`);
      }
    }
    if (p.route.production_process && p.route.production_process !== "same_as_prototype") {
      const prod = `${prodProcessLabel(p.route.production_process)}${p.route.production_material ? ` in ${prodMaterialLabel(p.route.production_material)}` : ""}`;
      const fair = o && p.route.production_material && o.stands_in_for.includes(p.route.production_material);
      L.push(`- **Production:** ${prod}. ${fair ? "This print is a fair stand-in for fit, feel and light functional tests."
        : "This print is for fit, form and handling: strength, drop and heat results will not carry over to the production part."}`);
    }
    if (o) L.push("", `**Why this material:** ${o.good_for}`, "", `**Watch out:** ${o.watch_out}`, "", "**Settings:**", ...printSettings(o).lines.map((x) => `- ${x}`));
    if (p.route.notes) L.push("", `**Notes:** ${p.route.notes}`);
    L.push("");
    rows.push([p.route.name, p.files.join(" "), o ? o.process : "", o ? o.material : "", String(p.route.prototype_qty ?? 1), p.route.finish ?? "",
      p.stats ? p.stats.size_mm.join("x") : "", p.stats ? String(p.stats.volume_cm3) : "", mass ? (mass[0] === mass[1] ? String(mass[0]) : `${mass[0]}-${mass[1]}`) : ""]);
  }
  const csv = rows.map((r) => r.map((c) => /[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c).join(",")).join("\n") + "\n";
  return { markdown: L.join("\n"), csv };
}
