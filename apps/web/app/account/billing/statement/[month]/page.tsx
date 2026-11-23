import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { money } from "@/lib/billing";
import { KIND_LABEL, loadStatement } from "@/lib/statement";
import { tokens } from "@/lib/ai-usage";

/** One month's statement: opening balance, every charge and credit with the AI call behind it, closing balance. */
export default async function StatementPage({ params }: { params: Promise<{ month: string }> }) {
  const { month } = await params;
  const { supabase, email } = await requireUser();
  const s = await loadStatement(supabase, month);
  return (
    <main>
      <p className="crumbs no-print"><Link href="/projects">Projects</Link> / <Link href="/account">Account</Link> / <Link href="/account/billing">Billing</Link> /</p>
      <h1>Statement: {s.label}</h1>
      <p className="small muted">{email} · all times UTC · <a className="no-print" href={`/account/billing/statement/${month}/csv`}>Download CSV</a></p>
      <section className="card" data-testid="statement-summary">
        <table className="small statement"><tbody>
          <tr><td>Opening balance</td><td className="num">{money(s.opening)}</td></tr>
          <tr><td>Credit added</td><td className="num">{money(s.totals.credit)}</td></tr>
          {s.totals.fees > 0 && <tr><td>Plan fees</td><td className="num">{money(-s.totals.fees)}</td></tr>}
          <tr><td>Usage: {s.totals.calls} charge(s){s.admin ? ` (admin: our cost ${money(s.totals.cost, 4)})` : ""}</td><td className="num">{money(-s.totals.usage, 4)}</td></tr>
          {s.totals.adjustments !== 0 && <tr><td>Adjustments</td><td className="num">{money(s.totals.adjustments)}</td></tr>}
          <tr><td><strong>Closing balance</strong></td><td className="num" data-testid="closing"><strong>{money(s.closing)}</strong></td></tr>
        </tbody></table>
      </section>
      <section className="card">
        <table className="small statement" data-testid="statement-lines">
          <thead><tr><th>When</th><th>Item</th><th>Project</th><th>Activity</th><th className="num">Tokens in / out</th>{s.admin && <th className="num">Our cost</th>}<th className="num">Amount</th></tr></thead>
          <tbody>
            {s.lines.map((l, i) => (
              <tr key={i}>
                <td>{new Date(l.at).toISOString().slice(0, 16).replace("T", " ")}</td>
                <td>{KIND_LABEL[l.kind]}: {l.description}</td>
                <td>{l.project ?? ""}</td>
                <td>{l.activity ?? ""}</td>
                <td className="num">{l.input_tokens != null ? `${tokens(Number(l.input_tokens) + Number(l.cache_read_tokens ?? 0) + Number(l.cache_write_tokens ?? 0))} / ${tokens(Number(l.output_tokens ?? 0))}` : ""}</td>
                {s.admin && <td className="num">{l.cost_usd != null ? money(l.cost_usd, 4) : ""}</td>}
                <td className="num">{money(l.amount_usd, l.kind === "usage" ? 4 : 2)}</td>
              </tr>
            ))}
            {!s.lines.length && <tr><td colSpan={s.admin ? 7 : 6} className="muted">Nothing this month.</td></tr>}
          </tbody>
        </table>
      </section>
    </main>
  );
}
