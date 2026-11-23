import { requireUser } from "@/lib/auth";
import { KIND_LABEL, loadStatement } from "@/lib/statement";

const cell = (v: unknown) => {
  if (typeof v === "number" || (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v))) return String(v);
  const s = v == null ? "" : String(v);
  // Text that a spreadsheet would run as a formula is prefixed with a quote.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** The month's statement as CSV, one row per ledger line. */
export async function GET(_req: Request, { params }: { params: Promise<{ month: string }> }) {
  const { month } = await params;
  const { supabase } = await requireUser();
  const s = await loadStatement(supabase, month);
  const rows = [
    ["time_utc", "kind", "description", "project", "activity", "model", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", ...(s.admin ? ["our_cost_usd"] : []), "amount_usd"],
    ...s.lines.map((l) => [l.at, KIND_LABEL[l.kind], l.description, l.project, l.activity, l.model, l.input_tokens, l.output_tokens,
      l.cache_read_tokens, l.cache_write_tokens, ...(s.admin ? [l.cost_usd] : []), l.amount_usd]),
    [], ["opening_balance", s.opening.toFixed(2)], ["closing_balance", s.closing.toFixed(2)],
  ];
  return new Response(rows.map((r) => r.map(cell).join(",")).join("\n") + "\n", {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="vx-statement-${month}.csv"` },
  });
}
