import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { activityOf } from "@/lib/ai-usage";

export interface StatementLine {
  at: string; kind: "credit" | "usage" | "plan_fee" | "adjustment"; description: string; project: string | null; activity: string | null;
  model: string | null; input_tokens: number | null; output_tokens: number | null; cache_read_tokens: number | null;
  cache_write_tokens: number | null; cost_usd: number | null; amount_usd: number; opening_balance: number;
}
export interface Statement { month: string; label: string; lines: StatementLine[]; opening: number; closing: number;
  totals: { credit: number; usage: number; cost: number; fees: number; adjustments: number; calls: number } }

export async function loadStatement(supabase: SupabaseClient, month: string): Promise<Statement> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error("month must be YYYY-MM");
  const { data, error } = await supabase.rpc("my_statement", { p_month: month });
  if (error) throw new Error(error.message);
  const lines = ((data ?? []) as StatementLine[]).map((l) => ({ ...l, activity: l.kind === "usage" ? activityOf(l.activity) : null }));
  let opening = Number(lines[0]?.opening_balance ?? NaN);
  if (Number.isNaN(opening)) {
    // No lines this month: the opening balance is the balance before it.
    const { data: before } = await supabase.from("billing_ledger").select("amount_usd").lt("created_at", `${month}-01T00:00:00Z`);
    opening = (before ?? []).reduce((n, r) => n + Number(r.amount_usd), 0);
  }
  const sum = (k: StatementLine["kind"]) => lines.filter((l) => l.kind === k).reduce((n, l) => n + Number(l.amount_usd), 0);
  const totals = {
    credit: sum("credit"), usage: -sum("usage"), fees: -sum("plan_fee"), adjustments: sum("adjustment"),
    cost: lines.filter((l) => l.kind === "usage").reduce((n, l) => n + Number(l.cost_usd ?? 0), 0),
    calls: lines.filter((l) => l.kind === "usage").length,
  };
  const label = new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  return { month, label, lines, opening, closing: opening + lines.reduce((n, l) => n + Number(l.amount_usd), 0), totals };
}

export const KIND_LABEL: Record<StatementLine["kind"], string> = { credit: "Credit", usage: "Usage", plan_fee: "Plan fee", adjustment: "Adjustment" };
