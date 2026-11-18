/**
 * Optimization job (§14): reads the project's latest approved sourced BOM and power budget, looks up the alternates
 * and consolidation candidates at the configured distributors (fresh offers and specs, so prices and constraint
 * checks are current), runs @vx/optimize and stores the ranked proposals. No model is involved: every number is
 * computed, and anything assumed is labelled in the proposal.
 */
import { normalizeMpn, type BomResolution, type PartRecord, type SourcingProvider } from "@vx/integrations";
import { optimize, OPTIMIZE_VERSION } from "@vx/optimize";
import type { PowerReport, PowerTree } from "@vx/power";
import type { WorkerDb } from "./db.ts";

const MAX_LOOKUPS = 40;

export async function processOptimization(db: WorkerDb, providers: SourcingProvider[], workerId: string): Promise<number> {
  const run = await db.claimOptimization(workerId);
  if (!run) return 0;
  const tag = `[${workerId}] optimization ${run.id.slice(0, 8)} (#${run.run_no})`;
  const inputs: Record<string, unknown> = { version: OPTIMIZE_VERSION };
  try {
    const bomV = await db.latestCommitted(run.project_id, "sourced-bom");
    const powerV = await db.latestCommitted(run.project_id, "power-budget");
    inputs.bom = bomV && { artifact: bomV.name, version: bomV.versionId, sha256: bomV.sha256 };
    inputs.power = powerV && { artifact: powerV.name, version: powerV.versionId, sha256: powerV.sha256 };
    if (!bomV && !powerV) throw new Error("nothing to analyse yet: the project has no approved sourced BOM or power budget");
    const bom = bomV ? JSON.parse(await db.downloadText(bomV.storagePath)) as BomResolution : null;
    const power = powerV ? JSON.parse(await db.downloadText(powerV.storagePath)) as { tree: PowerTree; report: PowerReport } : null;
    const requirements = await db.projectRequirements(run.project_id);

    // Fresh records for every alternate and for the parts of generic passive lines (consolidation).
    const wanted = new Map<string, string>();
    for (const l of bom?.lines ?? []) {
      for (const a of l.alternates) wanted.set(normalizeMpn(a.mpn), a.mpn);
      if (l.selected && (l.class === "resistor" || l.class === "capacitor")) wanted.set(normalizeMpn(l.selected.mpn), l.selected.mpn);
    }
    const lookups: Record<string, PartRecord[]> = {};
    const usable = providers.filter((p) => p.configured());
    let looked = 0, failed = 0;
    for (const [key, mpn] of [...wanted].slice(0, MAX_LOOKUPS)) {
      const recs: PartRecord[] = [];
      for (const p of usable) {
        try { recs.push(...(await p.searchMpn(mpn)).filter((r) => normalizeMpn(r.mpn) === key)); } catch { failed++; }
      }
      if (recs.length) lookups[key] = recs;
      looked++;
    }
    inputs.lookups = { parts: wanted.size, looked_up: looked, found: Object.keys(lookups).length, provider_errors: failed,
                       providers: usable.map((p) => p.id), skipped: Math.max(0, wanted.size - MAX_LOOKUPS) };
    const result = optimize({ bom, power, requirements, lookups, settings: run.settings });
    const summary = {
      proposals: result.proposals.length, excluded: result.excluded.length,
      by_objective: result.proposals.reduce<Record<string, number>>((m, p) => ({ ...m, [p.objective]: (m[p.objective] ?? 0) + 1 }), {}),
      settings: result.settings, note: usable.length ? null : "no distributor configured: alternates could not be priced or checked",
      fixture: bom?.dataStatus === "fixture" || usable.some((p) => p.id === "fixture"),
    };
    await db.completeOptimization(run.id, workerId, inputs, { proposals: result.proposals, excluded: result.excluded, summary }, null);
    console.log(`${tag}: ${result.proposals.length} proposal(s), ${result.excluded.length} excluded`);
  } catch (e) {
    const msg = (e as Error).message;
    if (/lease_lost|not being run/.test(msg)) { console.error(`${tag}: lost the run (${msg})`); return 1; }
    console.error(`${tag} failed: ${msg}`);
    await db.completeOptimization(run.id, workerId, inputs, {}, msg.slice(0, 500))
      .catch((e2) => console.error(`${tag}: could not record the failure: ${(e2 as Error).message}`));
  }
  return 1;
}
