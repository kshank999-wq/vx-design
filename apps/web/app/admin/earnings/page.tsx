import { notFound } from "next/navigation";
import { Banner } from "@/components/Banner";
import { SubmitButton } from "@/components/SubmitButton";
import { requireUser } from "@/lib/auth";
import { money } from "@/lib/billing";
import { setReferenceMarkup } from "./actions";

interface Row { section: "customers" | "in_house"; account: string; plan: string | null; calls: number; cost_usd: number; charged_usd: number; markup_usd: number }

/**
 * VX Design administrators only: what the AI markup earned from customers this month, and what in-house projects
 * (not billed) would have earned at the reference markup. Customers never see our cost or the markup.
 */
export default async function EarningsPage({ searchParams }: { searchParams: Promise<{ month?: string; notice?: string; error?: string }> }) {
  const { month: m, notice, error } = await searchParams;
  const { supabase } = await requireUser();
  const { data: admin } = await supabase.rpc("is_platform_admin");
  if (!admin) notFound();
  const month = m && /^\d{4}-(0[1-9]|1[0-2])$/.test(m) ? m : new Date().toISOString().slice(0, 7);
  const [{ data, error: e }, { data: ref }] = await Promise.all([
    supabase.rpc("admin_earnings", { p_month: month }),
    supabase.rpc("admin_reference_markup"),
  ]);
  const rows = (data ?? []) as Row[];
  const of = (s: Row["section"]) => rows.filter((r) => r.section === s);
  const sum = (rs: Row[], k: "cost_usd" | "charged_usd" | "markup_usd") => rs.reduce((n, r) => n + Number(r[k]), 0);
  const months = Array.from({ length: 6 }, (_, i) => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - i); return d.toISOString().slice(0, 7); });
  const table = (rs: Row[], charged: string, testid: string) => (
    <table className="small" data-testid={testid}>
      <thead><tr><th>Account</th><th>Plan</th><th className="num">AI calls</th><th className="num">Our cost</th><th className="num">{charged}</th><th className="num">Markup</th></tr></thead>
      <tbody>
        {rs.map((r) => <tr key={r.account}><td>{r.account}</td><td>{r.plan ?? ""}</td><td className="num">{r.calls}</td><td className="num">{money(r.cost_usd)}</td>
          <td className="num">{money(r.charged_usd)}</td><td className="num"><strong>{money(r.markup_usd)}</strong></td></tr>)}
        {!rs.length && <tr><td colSpan={6} className="muted">Nothing this month.</td></tr>}
        {rs.length > 1 && <tr><td colSpan={3}><strong>Total</strong></td><td className="num">{money(sum(rs, "cost_usd"))}</td><td className="num">{money(sum(rs, "charged_usd"))}</td>
          <td className="num"><strong>{money(sum(rs, "markup_usd"))}</strong></td></tr>}
      </tbody>
    </table>
  );
  return (
    <main>
      <h1>Earnings <span className="muted small">administrators only</span></h1>
      <p><a href="/admin/accounts">Accounts and plans →</a></p>
      <Banner error={error ?? e?.message} notice={notice} />
      <form className="row tight" method="get">
        <label className="inline">Month <select name="month" defaultValue={month}>{months.map((x) => <option key={x}>{x}</option>)}</select></label>
        <button className="btn btn-secondary" type="submit">Show</button>
      </form>
      <div className="tiles overview-tiles" data-testid="earnings-tiles">
        <div className="tile"><strong>{money(sum(of("customers"), "markup_usd"))}</strong> markup earned from customers<span className="muted small">on {money(sum(of("customers"), "cost_usd"))} of AI cost</span></div>
        <div className="tile"><strong>{money(sum(of("in_house"), "markup_usd"))}</strong> in-house: would have earned<span className="muted small">at {Number(ref ?? 0)}% on {money(sum(of("in_house"), "cost_usd"))} of AI cost</span></div>
      </div>
      <section className="card">
        <h2>Customers</h2>
        <p className="small muted">What each customer was charged for AI against what it cost us. Customers see only the charge.</p>
        {table(of("customers"), "Charged", "earnings-customers")}
      </section>
      <section className="card">
        <h2>In-house projects</h2>
        <p className="small muted">Accounts that are not billed (our own projects). The markup is what they would have earned at the reference markup.</p>
        {table(of("in_house"), "Would charge", "earnings-in-house")}
        <form className="row tight" action={setReferenceMarkup} style={{ marginTop: 10 }}>
          <label className="inline small">Reference markup % <input name="pct" type="number" min={0} max={500} step="any" defaultValue={Number(ref ?? 25)} style={{ width: "6em" }} /></label>
          <SubmitButton variant="secondary" pendingText="Saving…">Save</SubmitButton>
        </form>
      </section>
    </main>
  );
}
