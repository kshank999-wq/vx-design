import { partProposals } from "./parts.ts";
import { powerProposals } from "./power.ts";
import { DEFAULTS, type Excluded, type OptimizeInput, type OptimizeResult } from "./types.ts";

export * from "./types.ts";
export { partConstraints } from "./parts.ts";
export const OPTIMIZE_VERSION = "optimize-v1";

/** Ranked proposals: highest score first (benefit × confidence ÷ effort); ties by objective and fingerprint. */
export function optimize(input: OptimizeInput): OptimizeResult {
  const settings = { ...DEFAULTS, ...(input.settings ?? {}) };
  const excluded: Excluded[] = [];
  const proposals = [...partProposals(input, settings, excluded), ...powerProposals(input, settings, excluded)]
    .sort((a, b) => b.score - a.score || a.objective.localeCompare(b.objective) || a.fingerprint.localeCompare(b.fingerprint))
    .map((p, i) => ({ ...p, rank: i + 1 }));
  return { version: OPTIMIZE_VERSION, proposals, excluded, settings,
           inputs: { bom: !!input.bom, power: !!input.power, lookups: Object.keys(input.lookups).length } };
}
