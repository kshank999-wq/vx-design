/**
 * Inspection plans (S5): what to check on bare boards, assembled boards and enclosures, drafted from the committed
 * fab package and enclosure fit report. Deterministic: every item comes from a fact in those files (a hole count,
 * a fine-pitch footprint, an opening) or from the workmanship standard it cites, and states its method, stage,
 * sample and acceptance. Tolerances that are typical rather than taken from a supplier are marked to confirm.
 */

export type InspectionStage = "incoming" | "in_process" | "final";
export interface InspectionItem {
  key: string; stage: InspectionStage; characteristic: string; method: string; sample: "100%" | "sample" | "first article";
  acceptance: string; reference: string; critical: boolean;
}
export type PlanKind = "bare_pcb" | "pcba" | "enclosure";

export interface FabCheckFacts {
  profile?: string;
  board: { width_mm: number; height_mm: number; copper_layers: number; holes: { plated: number; nonplated: number; vias: number };
           min_drill_mm: number | null; min_track_mm?: number | null; thickness_mm?: number };
  parts: { ref: string; value: string; footprint: string; side: string; smd: boolean }[];
}

const r1 = (x: number) => Math.round(x * 100) / 100;

/** Footprints whose terminals are hidden under the body: joints need X-ray. */
export const isBottomTerminated = (fp: string) => /BGA|QFN|DFN|LGA|SON|WSON|VQFN|UQFN|Module/i.test(fp) && !/SOIC|SOT|SOD/i.test(fp);
/** Pitch from KiCad footprint names ("P0.5mm", "_0.4mm"), when stated. */
export function pitchMm(fp: string): number | null {
  const m = /P(\d+(?:\.\d+)?)mm/i.exec(fp) ?? /[_-](\d\.\d+)mm/.exec(fp);
  return m ? Number(m[1]) : null;
}
/** Parts that can be placed the wrong way round. */
export const isPolarized = (p: { ref: string; footprint: string }) =>
  /^(D|U|Q|LED|BT|IC)\d/i.test(p.ref) || /CP_|Polarized|LED|Diode|Tantalum|SOT|SOIC|QFN|QFP|DFN|BGA|TSSOP|MSOP/i.test(p.footprint);

export function pcbaPlan(f: FabCheckFacts, opts: { assembled: boolean; productionTest?: { code: string; version: number; title: string } | null } = { assembled: true }): InspectionItem[] {
  const b = f.board, parts = f.parts.filter((p) => !/^(H|MH|FID|TP)\d/i.test(p.ref));
  const items: InspectionItem[] = [];
  const add = (i: InspectionItem) => items.push(i);
  add({ key: "outline", stage: "incoming", characteristic: `Board outline ${r1(b.width_mm)} × ${r1(b.height_mm)} mm`, method: "Calliper",
        sample: "sample", acceptance: `${r1(b.width_mm)} × ${r1(b.height_mm)} mm ± 0.2 mm (typical routing tolerance; confirm with the fab)`,
        reference: "Fab drawing / outline in the fab package", critical: false });
  const t = b.thickness_mm ?? 1.6;
  add({ key: "thickness", stage: "incoming", characteristic: `Board thickness ${t} mm`, method: "Micrometer, away from copper features",
        sample: "sample", acceptance: `${t} mm ± 10% (typical; confirm with the fab)`, reference: "Fab notes (stackup)", critical: false });
  add({ key: "layers", stage: "incoming", characteristic: `${b.copper_layers} copper layers`, method: "Fab certificate of conformance; cross-section on first article if more than 2 layers",
        sample: b.copper_layers > 2 ? "first article" : "sample", acceptance: `${b.copper_layers} layers as in the fab package`, reference: "Gerbers / IPC-2581", critical: true });
  add({ key: "holes", stage: "incoming", characteristic: `Holes: ${b.holes.plated} plated, ${b.holes.nonplated} non-plated, ${b.holes.vias} vias${b.min_drill_mm ? `; smallest ${b.min_drill_mm} mm` : ""}`,
        method: "Count against the drill map; pin gauge on the smallest and the mounting holes", sample: "sample",
        acceptance: "All holes present and open; sizes within the fab's stated drill tolerance", reference: "Drill map, Excellon files", critical: false });
  add({ key: "bare_board_workmanship", stage: "incoming", characteristic: "Bare-board workmanship: solder mask registration, exposed copper, legend, plating",
        method: "Visual, 3–10× magnification", sample: "sample", acceptance: "IPC-A-600 Class 2", reference: "IPC-A-600", critical: false });
  add({ key: "electrical_test", stage: "incoming", characteristic: "Opens and shorts on every net", method: "Fab's flying-probe or fixture test against the IPC-D-356 netlist",
        sample: "100%", acceptance: "Test certificate shows 100% tested, no failures", reference: "IPC-D-356 netlist in the fab package", critical: true });
  if (!opts.assembled) return items;

  const polar = parts.filter(isPolarized).map((p) => p.ref);
  add({ key: "placement", stage: "in_process", characteristic: `${parts.length} components present, correct part and value`, method: "AOI, or visual against the assembly drawing and BOM",
        sample: "100%", acceptance: "Every BOM position populated with the right part; no parts where the BOM says do not fit", reference: "Assembly BOM, assembly drawing", critical: true });
  if (polar.length) add({ key: "polarity", stage: "in_process", characteristic: `Orientation of polarized parts: ${polar.join(", ")}`,
        method: "AOI, or visual against the assembly drawing's polarity marks", sample: "100%", acceptance: "Pin 1 / cathode as marked on the assembly drawing",
        reference: "Assembly drawing", critical: true });
  add({ key: "solder_joints", stage: "in_process", characteristic: "Solder joints", method: "Visual, 3–10× magnification (AOI where available)", sample: "sample",
        acceptance: "IPC-A-610 Class 2", reference: "IPC-A-610", critical: false });
  const fine = parts.filter((p) => { const pt = pitchMm(p.footprint); return pt != null && pt <= 0.5; });
  if (fine.length) add({ key: "fine_pitch", stage: "in_process", characteristic: `Bridges on fine-pitch parts (≤ 0.5 mm): ${fine.map((p) => p.ref).join(", ")}`,
        method: "Visual at 10× or more", sample: "100%", acceptance: "No solder bridges between leads (IPC-A-610 Class 2)", reference: "IPC-A-610", critical: true });
  const hidden = parts.filter((p) => isBottomTerminated(p.footprint));
  if (hidden.length) add({ key: "xray", stage: "in_process", characteristic: `Hidden joints under ${hidden.map((p) => p.ref).join(", ")}`,
        method: "X-ray", sample: "first article", acceptance: "No bridges or opens; voiding within IPC-A-610 Class 2 limits; then sample per lot",
        reference: "IPC-A-610, IPC-7095 (BGA) / IPC-7093 (bottom-terminated)", critical: true });
  const th = parts.filter((p) => !p.smd);
  if (th.length) add({ key: "through_hole", stage: "in_process", characteristic: `Through-hole joints: ${th.map((p) => p.ref).join(", ")}`,
        method: "Visual both sides", sample: "sample", acceptance: "Barrel fill at least 75% (IPC-A-610 Class 2)", reference: "IPC-A-610", critical: false });
  const bottom = parts.filter((p) => p.side === "bottom");
  if (bottom.length) add({ key: "bottom_side", stage: "in_process", characteristic: `Bottom-side parts after second reflow: ${bottom.map((p) => p.ref).join(", ")}`,
        method: "Visual", sample: "sample", acceptance: "All bottom-side parts present and seated", reference: "Assembly drawing (bottom)", critical: false });
  add({ key: "functional", stage: "final", characteristic: "Functional (production) test",
        method: opts.productionTest ? `${opts.productionTest.code} v${opts.productionTest.version} ${opts.productionTest.title}` : "Production test procedure (to be approved under Validation)",
        sample: "100%", acceptance: opts.productionTest ? `Pass on every measurement of ${opts.productionTest.code}` : "Pass; procedure to be approved", reference: "Validation: test procedures", critical: true });
  add({ key: "traceability", stage: "final", characteristic: "Serial number label and record", method: "Visual; serial registered on the lot", sample: "100%",
        acceptance: "Label legible; serial matches the lot record", reference: "Production: lot units", critical: false });
  return items;
}

export interface FitReportFacts {
  process?: { name?: string; label?: string }; material?: string;
  dimensions_mm?: { x: number; y: number; z: number };
  spec?: { wall_mm?: number; openings?: { ref: string; kind: string }[] };
  mounting?: Record<string, { hole_mm: number; boss_od_mm: number }>;
  openings?: { ref: string; kind: string; side?: string; width_mm?: number; height_mm?: number; diameter_mm?: number; depth_mm?: number; error?: string }[];
}

export function enclosurePlan(f: FitReportFacts, tolerance: { mm: number; basis: string }): InspectionItem[] {
  const items: InspectionItem[] = [];
  const tol = `± ${tolerance.mm} mm (${tolerance.basis})`;
  const d = f.dimensions_mm;
  if (d) items.push({ key: "overall", stage: "incoming", characteristic: `Overall size ${r1(d.x)} × ${r1(d.y)} × ${r1(d.z)} mm`, method: "Calliper",
                      sample: "first article", acceptance: `Each dimension ${tol}`, reference: "Enclosure drawing (fit report)", critical: false });
  if (f.spec?.wall_mm) items.push({ key: "wall", stage: "incoming", characteristic: `Wall thickness ${f.spec.wall_mm} mm`, method: "Calliper at the opening edges",
                      sample: "first article", acceptance: `${f.spec.wall_mm} mm ${tol}`, reference: "Enclosure spec", critical: false });
  for (const [ref, h] of Object.entries(f.mounting ?? {})) items.push({ key: `boss_${ref.toLowerCase()}`, stage: "incoming",
    characteristic: `Mounting boss for ${ref}: hole ${h.hole_mm} mm, boss ${h.boss_od_mm} mm`, method: "Pin gauge in the hole; screw or insert test",
    sample: "sample", acceptance: `Hole ${h.hole_mm} mm ${tol}; screw or insert seats fully`, reference: "Enclosure drawing", critical: true });
  for (const o of (f.openings ?? []).filter((x) => !x.error)) {
    const size = o.diameter_mm ? `⌀${o.diameter_mm} mm` : `${o.width_mm ?? "?"} × ${o.height_mm ?? o.depth_mm ?? "?"} mm`;
    items.push({ key: `opening_${o.ref.toLowerCase()}`, stage: "incoming", characteristic: `Opening for ${o.ref} (${o.kind}${o.side ? `, ${o.side}` : ""}): ${size}`,
      method: "Calliper; mate the connector or control with the board fitted", sample: "sample", acceptance: `Size ${tol}; ${o.ref} usable with the lid closed`,
      reference: "Enclosure drawing", critical: true });
  }
  items.push({ key: "material", stage: "incoming", characteristic: `Material${f.material ? `: ${f.material}` : ""}${f.process?.label ? `, ${f.process.label}` : ""}`,
               method: "Supplier certificate of conformance", sample: "first article", acceptance: "Material and process as specified", reference: "Enclosure spec", critical: false });
  items.push({ key: "finish", stage: "incoming", characteristic: "Colour and surface finish", method: "Visual against the approved sample", sample: "sample",
               acceptance: "Matches the approved sample; no cracks, warping, sink marks or layer defects visible at arm's length", reference: "Approved sample", critical: false });
  items.push({ key: "fit", stage: "final", characteristic: "Board fits; lid closes; screws engage", method: "Assemble with a production board", sample: "100%",
               acceptance: "No force needed; no rattle; all openings line up", reference: "Fit report", critical: true });
  return items;
}

/** The plan as CSV for a supplier. */
export function inspectionCsv(items: InspectionItem[]): string {
  const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
  return ["Stage,Characteristic,Method,Sample,Acceptance,Reference,Critical",
          ...items.map((i) => [i.stage.replace("_", "-"), i.characteristic, i.method, i.sample, i.acceptance, i.reference, i.critical ? "yes" : "no"].map(q).join(","))]
    .join("\r\n") + "\r\n";
}
