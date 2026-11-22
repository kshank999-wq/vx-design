import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { identityFromRecord, type PartIdentity } from "@vx/planning";
import { matchIdentity, normalizeMpn, sourcingProvidersFromEnv, type SourcingProvider } from "@vx/integrations";

export interface LookedUp { identity: PartIdentity; source: string }

let providers: SourcingProvider[] | null = null;
const configured = () => (providers ??= sourcingProvidersFromEnv().filter((p) => p.configured() && p.id !== "fixture"));

/** Whether any distributor is set up on this server (else only the saved catalog is consulted). */
export const distributorsConfigured = () => configured().length > 0;

/**
 * A part from data, not AI: the saved parts catalog first (free), then the configured distributors in order (Nexar,
 * DigiKey, Mouser). Only an exact part-number match (or the same part in different packaging) is taken, and only a
 * record that says what the part is. Null when nothing matches; the caller then asks the model.
 */
export async function lookupPart(supabase: SupabaseClient, candidates: string[]): Promise<LookedUp | null> {
  for (const c of candidates.slice(0, 4)) {
    const { data } = await supabase.from("parts").select("mpn, manufacturer, description, package, lifecycle, specs, sources")
      .eq("normalized_mpn", normalizeMpn(c)).limit(1).maybeSingle();
    if (data && (data.description || Object.keys(data.specs ?? {}).length)) {
      return { identity: identityFromRecord(data as never), source: `the parts catalog (${(data.sources as string[]).join(", ") || "saved"})` };
    }
  }
  for (const c of candidates.slice(0, 3)) {
    for (const p of configured()) {
      try {
        const hits = await p.searchMpn(c);
        const hit = hits.find((r) => matchIdentity({ mpn: c }, r) !== "different" && (r.description || Object.keys(r.specs).length));
        if (hit) return { identity: identityFromRecord(hit), source: p.label };
      } catch (e) {
        console.error(`part lookup ${p.id} ${c}: ${(e as Error).message}`);
      }
    }
  }
  return null;
}
