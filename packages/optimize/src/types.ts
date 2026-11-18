/**
 * Optimization proposals (spec §14). Every number in a proposal is computed: from distributor offers with the same
 * pricing rules as the sourced BOM, or by re-running the power calculator on a changed power tree. Where a value is
 * assumed (a switcher's efficiency, an assembly fee) the proposal says so and its confidence drops.
 */
import type { BomResolution, PartRecord } from "@vx/integrations";
import type { PowerReport, PowerTree } from "@vx/power";

export type Objective = "cost" | "availability" | "lifecycle" | "supply" | "consolidation" | "power" | "standby" | "thermal";
export type Confidence = "high" | "medium" | "low";
export type Effort = "S" | "M" | "L";

export interface Impact {
  metric: string;              // e.g. "BOM cost per board", "battery runtime"
  at?: string;                 // e.g. "100 boards", "standby mode"
  before: number | string | null;
  after: number | string | null;
  unit: string;
  better: "lower" | "higher" | "n/a";
}

export interface ConstraintCheck {
  id: string;                  // what was checked: "value", "package", "voltage", REQ-..., "input range"
  status: "met" | "violated" | "needs_review";
  detail: string;
}

export interface Proposal {
  fingerprint: string;         // stable id of the change (same change → same fingerprint across runs)
  objective: Objective;
  title: string;
  subject: string;             // BOM line refs or converter id
  change: { kind: "swap_part" | "second_source" | "replace_part" | "consolidate" | "replace_converter" | "lower_iq" | "thermal_relief";
            from: string; to: string; details?: Record<string, unknown> };
  targets: string[];           // requirement refs the change serves or touches
  impact: Impact[];
  basis: { method: string; inputs: string[]; assumptions: string[] };
  confidence: Confidence;
  confidence_reason: string;
  effort: Effort;
  cost_note: string;           // NRE / redesign / requalification needed
  affects: { interfaces: string[]; manufacturability: string[]; standards: string[] };
  constraints: ConstraintCheck[];
  score: number;
  rank?: number;
}

export interface Excluded { title: string; reason: string }

export interface OptimizeInput {
  bom: BomResolution | null;
  power: { tree: PowerTree; report: PowerReport } | null;
  requirements: { ref_code: string; kind: string; priority: string; text: string }[];
  /** Fresh provider records for alternates and consolidation targets, keyed by normalized MPN. */
  lookups: Record<string, PartRecord[]>;
  settings?: Partial<OptimizeSettings>;
}

export interface OptimizeSettings {
  focusBoards: number;                       // the quantity cost proposals are ranked at
  minSavingPct: number;                      // below this a swap is not worth proposing
  assemblyFeePerUniquePart: number | null;   // e.g. a board house's per-part setup fee; null = not modelled
  assemblyFeeSource: string;
  switcherEfficiency: number;                // assumed for an LDO → switcher proposal
  switcherIqA: number;
  lowIqA: number;                            // assumed for a low-Iq replacement
  thetaJaReduction: number;                  // fraction, for the copper/package thermal proposal
}

export const DEFAULTS: OptimizeSettings = {
  focusBoards: 100, minSavingPct: 5, assemblyFeePerUniquePart: null, assemblyFeeSource: "not set",
  switcherEfficiency: 0.88, switcherIqA: 40e-6, lowIqA: 1e-6, thetaJaReduction: 0.3,
};

export interface OptimizeResult {
  version: string;
  proposals: Proposal[];
  excluded: Excluded[];
  inputs: { bom: boolean; power: boolean; lookups: number };
  settings: OptimizeSettings;
}
