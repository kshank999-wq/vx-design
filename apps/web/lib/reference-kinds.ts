/** Kinds of project files and statuses, shared by server pages and browser components. */
export const REFERENCE_KINDS: [string, string][] = [
  ["mockup", "Mock-up"], ["sketch", "Sketch"], ["render", "Render"], ["photo", "Photo"], ["drawing", "Drawing"],
  ["prior_design", "Prior design (other tool or engineer)"], ["datasheet", "Datasheet"], ["model_3d", "3D model (STEP or STL)"], ["other", "Other"],
];
/** What "Mock-ups and references" takes: pictures of how the product looks. */
export const VISUAL_KINDS = REFERENCE_KINDS.filter(([k]) => ["mockup", "sketch", "render", "photo", "drawing", "other"].includes(k));
/** Files attached to a chosen part. */
export const PART_FILE_KINDS = REFERENCE_KINDS.filter(([k]) => ["datasheet", "model_3d", "drawing", "other"].includes(k));
/** A part file's kind from its name: STEP is a 3D model, PDF a datasheet, an image or DXF a drawing. */
export function partFileKind(name: string): string {
  if (/\.(step|stp|stl)$/i.test(name)) return "model_3d";
  if (/\.pdf$/i.test(name)) return "datasheet";
  if (/\.(png|jpe?g|webp|gif|dxf)$/i.test(name)) return "drawing";
  return "other";
}
export const PART_STATUS: [string, string][] = [
  ["candidate", "Candidate"], ["selected", "Selected"], ["designed", "Designed in (schematic)"], ["laid_out", "Laid out (PCB)"],
  ["verified", "Verified (tested)"], ["rejected", "Rejected"],
];
export const ITEM_STATUS_LABEL: Record<string, string> = {
  considered: "Considered", selected: "Selected", designed: "Designed", laid_out: "Laid out", verified: "Verified", rejected: "Rejected", open: "Open question",
};
