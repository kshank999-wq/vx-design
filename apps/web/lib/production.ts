/** Shared labels for S7 compliance, releases and production lots. */

export const itemCode = (n: number) => `C-${String(n).padStart(3, "0")}`;
export const lotCode = (n: number) => `LOT-${String(n).padStart(3, "0")}`;

export const COMPLIANCE_STATUS: Record<string, [string, string]> = {
  identified: ["identified", ""], in_progress: ["in progress", "awaiting_approval"], at_lab: ["at the lab", "awaiting_approval"],
  passed: ["lab result: pass", "complete"], failed: ["lab result: fail", "failed"], not_applicable: ["not applicable", ""],
};
export const RELEASE_STATUS: Record<string, string> = { draft: "awaiting_approval", released: "complete", superseded: "", withdrawn: "failed" };
export const LOT_STATUS: Record<string, [string, string]> = {
  planned: ["planned", ""], in_build: ["in build", "awaiting_approval"], inspection: ["inspection", "awaiting_approval"],
  accepted: ["accepted", "complete"], rejected: ["rejected", "failed"], on_hold: ["on hold", "failed"],
};

export interface ReadinessItem { severity: "block" | "warn"; kind: string; text: string }
export interface ManifestFile { version_id: string; artifact: string; kind: string; version: number; path: string; sha256: string; size_bytes: number | null }
export interface LotSummary { units: number; scrapped: number; tested: number; first_pass: number; passing: number; failing: number }

/** Files a new release starts with: the latest committed version of each design output. */
export const RELEASE_KINDS = ["fab_package", "bom", "kicad_project", "pcb", "schematic", "step", "stl", "enclosure", "report"];
export const DEFAULT_RELEASE_KINDS = new Set(["fab_package", "bom", "step", "stl", "enclosure"]);

export const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : "—");
