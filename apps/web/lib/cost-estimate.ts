import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { PRICES, ruleExtract, usageCost, type ParsedDocument, type Usage } from "@vx/planning";

/**
 * What an AI action is likely to cost, before it runs: from this project's own recorded calls when it has some, else
 * from the account's other projects, else a typical figure. Shown next to the button that starts the action, with the
 * basis ("from your last 4", "typical"), so nobody is surprised by a charge.
 */
export interface Estimate { usd: number; basis: string; upTo?: boolean }

interface Family { first: RegExp; all: RegExp }
const FAMILIES = {
  planUpdate: { first: /^revise_plan$/, all: /^(revise_plan|repair_revise_plan)$/ },
  planFull: { first: /^generate_plan$/, all: /^(generate_plan|repair_plan)$/ },
  partRead: { first: /^part_identify$/, all: /^part_identify$/ },
  chat: { first: /^workspace_chat$/, all: /^workspace_chat$/ },
} satisfies Record<string, Family>;
type Kind = keyof typeof FAMILIES;

/** Typical costs at Claude Opus 5.5 prices, from the first measured plan builds (Nov 2026). */
const TYPICAL: Record<Kind, number> = { planUpdate: 0.75, planFull: 2.6, partRead: 0.08, chat: 0.06 };
/** Typical cost of reading one block of a specification with AI, at Opus 5.5 prices. */
const TYPICAL_PER_AI_BLOCK = 0.004;

export interface CostHistory { project: Map<Kind, { ops: number; usd: number }>; account: Map<Kind, { ops: number; usd: number }>; perAiBlock: { usd: number; blocks: number } }

/** Per operation (first call plus its repair rounds), from recorded AI calls. */
function tally(rows: { purpose: string | null; cost_usd: number }[]) {
  const m = new Map<Kind, { ops: number; usd: number }>();
  for (const [k, f] of Object.entries(FAMILIES) as [Kind, Family][]) {
    const mine = rows.filter((r) => r.purpose && f.all.test(r.purpose));
    const ops = mine.filter((r) => f.first.test(r.purpose!)).length;
    if (ops) m.set(k, { ops, usd: mine.reduce((n, r) => n + Number(r.cost_usd), 0) });
  }
  return m;
}

export async function costHistory(supabase: SupabaseClient, projectId: string): Promise<CostHistory> {
  const since = new Date(Date.now() - 90 * 86400e3).toISOString();
  const [{ data: rows }, { data: docs }] = await Promise.all([
    supabase.from("cost_events").select("project_id, purpose, cost_usd").eq("kind", "ai_tokens").gt("cost_usd", 0).gte("created_at", since).limit(5000),
    supabase.from("documents").select("extraction_report").eq("project_id", projectId).eq("extraction_status", "done"),
  ]);
  const all = (rows ?? []) as { project_id: string; purpose: string | null; cost_usd: number }[];
  let usd = 0, blocks = 0;
  for (const d of docs ?? []) {
    const r = d.extraction_report as { usage?: Usage[]; sources?: { aiBlocks: number } | null } | null;
    if (!r?.sources?.aiBlocks || !r.usage?.length) continue;
    usd += r.usage.reduce((n, u) => n + usageCost(u), 0);
    blocks += r.sources.aiBlocks;
  }
  return { project: tally(all.filter((r) => r.project_id === projectId)), account: tally(all), perAiBlock: { usd, blocks } };
}

const round = (n: number) => (n < 0.1 ? Math.round(n * 100) / 100 : n < 1 ? Math.round(n * 20) / 20 : Math.round(n * 10) / 10);

export function estimate(h: CostHistory, kind: Kind, opts: { scale?: number } = {}): Estimate {
  const p = h.project.get(kind), a = h.account.get(kind);
  if (p && p.ops >= 1) return { usd: round(p.usd / p.ops), basis: `from this project's last ${p.ops}` };
  if (a && a.ops >= 1) return { usd: round(a.usd / a.ops), basis: `from your other projects (${a.ops})` };
  return { usd: round(TYPICAL[kind] * (opts.scale ?? 1)), basis: "typical" };
}

/** Cost of reading these specifications: the blocks rules cannot take go to the model. */
export function extractionEstimate(h: CostHistory, docs: ParsedDocument[], model?: string | null): Estimate {
  const blocks = docs.reduce((n, d) => n + ruleExtract(d).aiBlocks.length, 0);
  if (!blocks) return { usd: 0, basis: "the rules can read it all" };
  const ratio = modelRatio(model);
  if (h.perAiBlock.blocks >= 20) return { usd: round((h.perAiBlock.usd / h.perAiBlock.blocks) * blocks * ratio), basis: `${blocks} block(s) for AI, at this project's rate` };
  return { usd: round(TYPICAL_PER_AI_BLOCK * blocks * ratio), basis: `${blocks} block(s) for AI, typical rate` };
}

/** How a model's price compares with Opus 5.5 (output tokens dominate the cost of reading). */
export function modelRatio(model?: string | null): number {
  const base = PRICES["claude-opus-5-5"]!, m = model ? PRICES[model] : null;
  return m ? m.output / base.output : 1;
}

export const fmtEstimate = (e: Estimate) => (e.usd === 0 ? "no AI cost" : `${e.upTo ? "up to " : "about "}${e.usd < 0.01 ? "under $0.01" : `$${e.usd.toFixed(2)}`}`);
