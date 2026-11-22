import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/** What each AI call purpose is, in the words of the product (repair rounds count with their task). */
export const ACTIVITY: [RegExp, string][] = [
  [/^(generate_plan|repair_plan)$/, "Planning: full plan"],
  [/^(revise_plan|repair_revise_plan)$/, "Planning: plan update"],
  [/^extract_requirements/, "Reading specifications"],
  [/^part_identify/, "Reading part datasheets"],
  [/^prior_work/, "Earlier-work register"],
  [/^flux_history/, "Flux import history"],
  [/^workspace_chat/, "Workspace chat"],
  [/^design_brief/, "Task briefs"],
  [/^(circuit_design|board_layout|power_tree|enclosure_design)/, "Design generation"],
  [/^concept_brief/, "Concept briefs"],
  [/^assembly_instructions/, "Assembly instructions"],
];
export const activityOf = (purpose: string | null) => ACTIVITY.find(([re]) => re.test(purpose ?? ""))?.[1] ?? (purpose ? purpose.replace(/_/g, " ") : "Before tracking (unpriced)");

export interface AiCall {
  id: string; project_id: string; purpose: string | null; resource: string | null; cost_usd: number; created_at: string;
  input_tokens: number | null; output_tokens: number | null; cache_read_tokens: number | null; cache_write_tokens: number | null;
  duration_ms: number | null; failed: boolean; user_id: string | null; quantity: number; execution_id: string | null;
}
export interface Totals { calls: number; usd: number; input: number; output: number; cacheRead: number; minutes: number; timedUsd: number }
const zero = (): Totals => ({ calls: 0, usd: 0, input: 0, output: 0, cacheRead: 0, minutes: 0, timedUsd: 0 });
export function add(t: Totals, c: AiCall) {
  t.calls++; t.usd += Number(c.cost_usd); t.input += Number(c.input_tokens ?? 0); t.output += Number(c.output_tokens ?? 0); t.cacheRead += Number(c.cache_read_tokens ?? 0);
  if (c.duration_ms) { t.minutes += c.duration_ms / 60000; t.timedUsd += Number(c.cost_usd); }
}
export const perMinute = (t: Totals) => (t.minutes > 0 ? t.timedUsd / t.minutes : null);

export async function loadAiCalls(supabase: SupabaseClient, projectIds: string[], since?: string): Promise<AiCall[]> {
  if (!projectIds.length) return [];
  let q = supabase.from("cost_events").select("id, project_id, purpose, resource, cost_usd, created_at, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, duration_ms, failed, user_id, quantity, execution_id")
    .eq("kind", "ai_tokens").in("project_id", projectIds).order("created_at", { ascending: false }).limit(5000);
  if (since) q = q.gte("created_at", since);
  const { data } = await q;
  return (data ?? []) as AiCall[];
}

export function summarize(calls: AiCall[]) {
  const total = zero();
  const by = new Map<string, Totals>();
  for (const c of calls) {
    add(total, c);
    const k = activityOf(c.purpose);
    if (!by.has(k)) by.set(k, zero());
    add(by.get(k)!, c);
  }
  return { total, byActivity: [...by.entries()].sort((a, b) => b[1].usd - a[1].usd) };
}

export const usd = (n: number) => (n >= 100 ? `$${n.toFixed(0)}` : n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(n === 0 ? 2 : 3)}`);
export const tokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : `${n}`);
