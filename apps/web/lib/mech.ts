import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { TEMPLATES } from "@vx/dfm";
import type { ProcessTolerance } from "@vx/mech";

export const MECH_VERSION = "mech-v1";
export const KIND_LABEL: Record<string, string> = { tolerance_stack: "Tolerance stack", gasket: "Gasket compression", thermal: "Thermal estimate" };
export const VERDICT: Record<string, [string, string]> = {
  pass: ["pass (worst case)", "complete"], pass_statistical: ["pass statistically only", "awaiting_approval"],
  fail: ["fail", "failed"], no_limit: ["no limit set", ""],
};
export const mechCode = (n: number) => `MA-${String(n).padStart(3, "0")}`;

/** The newest committed artifact whose name ends with `/<suffix>`, parsed as JSON. */
export async function latestJson(supabase: SupabaseClient, projectId: string, suffix: string) {
  const { data } = await supabase.from("artifact_versions").select("storage_path, version, committed_at, artifacts!inner(name)")
    .eq("project_id", projectId).eq("status", "committed").like("artifacts.name", `%/${suffix}`)
    .order("committed_at", { ascending: false }).limit(1).maybeSingle();
  if (!data?.storage_path) return null;
  const { data: blob } = await supabase.storage.from("project-files").download(data.storage_path);
  if (!blob) return null;
  try { return { json: JSON.parse(await blob.text()), name: (data.artifacts as unknown as { name: string }).name, version: data.version as number }; }
  catch { return null; }
}

/**
 * The tolerance to use for the enclosure process: the loosest that any supplier's recorded process rules state
 * (conservative), named with the supplier and date; otherwise the typical template figure, marked as an assumption.
 */
export async function processTolerance(supabase: SupabaseClient, process: string): Promise<ProcessTolerance> {
  const { data } = await supabase.from("process_rules").select("rules, checked_on, verified_at, manufacturers(display_name)").eq("process", process);
  const rows = (data ?? []).map((r) => ({ t: Number((r.rules as { tolerance_mm?: number }).tolerance_mm), r }))
    .filter((x) => Number.isFinite(x.t) && x.t > 0).sort((a, b) => b.t - a.t);
  if (rows.length) {
    const { t, r } = rows[0]!;
    const who = (r.manufacturers as unknown as { display_name: string } | null)?.display_name ?? "a supplier";
    return { tolerance_mm: t, assumed: false,
             basis: `${who}'s ${process.toUpperCase()} process rules (±${t} mm${r.checked_on ? `, read ${r.checked_on}` : ""}${r.verified_at ? ", verified" : ", not yet verified"}); loosest of ${rows.length} supplier(s)` };
  }
  const tpl = TEMPLATES.find((x) => x.process === process && (x.rules as { tolerance_mm?: number }).tolerance_mm != null);
  const t = (tpl?.rules as { tolerance_mm?: number } | undefined)?.tolerance_mm ?? 0.3;
  return { tolerance_mm: t, assumed: true, basis: `typical ${process.toUpperCase()} tolerance (±${t} mm, ${tpl ? tpl.label : "assumed"}); no supplier's rules recorded for this process` };
}

const num = (v: FormDataEntryValue | null) => { const s = String(v ?? "").trim(); return s === "" ? NaN : Number(s); };
export const formNum = (f: FormData, k: string) => num(f.get(k));
export const formOpt = (f: FormData, k: string) => { const n = num(f.get(k)); return Number.isFinite(n) ? n : null; };
export const tol = (f: FormData, k: string) => ({ nominal: formNum(f, `${k}_nominal`), plus: formNum(f, `${k}_plus`) || 0, minus: formNum(f, `${k}_minus`) || 0 });
