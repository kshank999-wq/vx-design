import Link from "next/link";
import { Banner } from "@/components/Banner";
import { requireUser } from "@/lib/auth";
import { getCheckout, money, MAX_TOP_UP, MIN_TOP_UP, recordPaidCheckout, settleOpenCheckouts, stripeConfigured, TOP_UPS } from "@/lib/billing";
import { addCredit, choosePlan } from "./actions";
import { PRICES } from "@vx/planning";

interface Plan {
  id: string; name: string; description: string | null; billing: "internal" | "prepaid"; monthly_fee_usd: number;
  included_ai_usd: number; ai_markup_pct?: number; price_rate: number; locked: boolean; max_projects: number | null; max_concurrent_tasks: number | null;
}
interface Billing { plan: Plan; admin?: boolean; balance: number; month_cost: number | null; month_charged: number; month_fees: number; offers: Plan[]; months: string[] }

/** A plan's terms as customers read them: the fee and the AI price per million tokens, not how the price is made up. */
const OPUS = PRICES["claude-opus-5-5"]!;
const perM = (v: number) => `$${v.toFixed(v < 1 ? 3 : 2)}`;
const terms = (p: Plan, admin = false) => [
  Number(p.monthly_fee_usd) ? `${money(p.monthly_fee_usd)} a month` : "No monthly fee",
  Number(p.included_ai_usd) ? `includes ${money(p.included_ai_usd)} of usage` : null,
  `design AI ${perM(OPUS.input * p.price_rate)} per million tokens read, ${perM(OPUS.output * p.price_rate)} per million written`,
  admin ? `(admin: markup ${Number(p.ai_markup_pct ?? 0)}%)` : null,
].filter(Boolean).join(" · ");

/** Prepaid balance, plan, card top-ups and monthly statements for the signed-in account. */
export default async function BillingPage({ searchParams }: { searchParams: Promise<{ error?: string; notice?: string; session_id?: string }> }) {
  const sp = await searchParams;
  let { error, notice } = sp;
  const { supabase, userId } = await requireUser();
  if (sp.session_id && stripeConfigured()) {
    try {
      const r = await recordPaidCheckout(supabase, userId, await getCheckout(sp.session_id));
      notice = r ? "Payment received; your balance is updated." : "Stripe has not confirmed the payment yet; it is added the next time you open this page after it does.";
    } catch (e) { error = (e as Error).message; }
  }
  const settled = await settleOpenCheckouts(supabase, userId);
  if (settled && !notice) notice = `${settled} earlier payment(s) confirmed by Stripe and added to your balance.`;
  const { data, error: e } = await supabase.rpc("my_billing");
  const b = data as Billing | null;
  const now = new Date().toISOString().slice(0, 7);
  const months = [...new Set([now, ...(b?.months ?? [])])].sort().reverse();
  const billed = b?.plan.billing === "prepaid";

  return (
    <main>
      <p className="crumbs"><Link href="/projects">Projects</Link> / <Link href="/account">Account</Link> /</p>
      <h1>Billing</h1>
      <Banner error={error ?? e?.message} notice={notice} />
      {b && (
        <>
          <section className="card" data-testid="balance">
            <div className="row spread">
              <div><p className="small muted">Prepaid balance</p><p className="big-number" data-testid="balance-amount">{money(b.balance)}</p></div>
              <div><p className="small muted">Plan</p><p data-testid="current-plan"><strong>{b.plan.name}</strong></p>
                <p className="small">{billed ? terms(b.plan, b.admin) : "Not billed (internal use); monthly allowances apply."}</p></div>
            </div>
            {billed && <p className="small" data-testid="month-summary">This month: usage {money(b.month_charged)}{b.admin && b.month_cost != null ? ` (admin: our cost ${money(b.month_cost)})` : ""}
              {Number(b.month_fees) > 0 && <> plus {money(b.month_fees)} in plan fees</>}.</p>}
            {billed && Number(b.balance) <= 0 && <p className="banner banner-error" role="alert">The balance is used up: AI work is paused until credit is added. Nothing is lost.</p>}
          </section>

          <section className="card" data-testid="plans">
            <h2>Plans</h2>
            <p className="small muted">Every AI call and worker job is charged as it happens, at the token prices on your statement. Plan fees are charged for the
              calendar month when you choose the plan and on the 1st after that; moving to a dearer plan mid-month charges the difference.</p>
            {b.plan.locked && <p className="small" data-testid="plan-locked">Your account is on the {b.plan.name} plan, set by staff. Ask us to change it.</p>}
            <div className="grid3">
              {b.offers.map((p) => (
                <div key={p.id} className={`option-card${p.id === b.plan.id ? " selected" : ""}`} data-testid={`offer-${p.id}`}>
                  <h3>{p.name}</h3>
                  <p className="small">{terms(p, b.admin)}</p>
                  <p className="small muted">{p.description}</p>
                  <p className="small muted">{p.max_projects ?? "Unlimited"} projects · {p.max_concurrent_tasks ?? "unlimited"} tasks at once</p>
                  {p.id === b.plan.id ? <p className="small"><strong>Current plan</strong></p> : !b.plan.locked && (
                    <form action={choosePlan}><input type="hidden" name="plan" value={p.id} />
                      <button type="submit">Choose {p.name}</button></form>
                  )}
                </div>
              ))}
            </div>
          </section>

          <section className="card" data-testid="add-credit">
            <h2>Add credit</h2>
            {stripeConfigured() ? (
              <form action={addCredit} className="row">
                {TOP_UPS.map((a, i) => <label key={a} className="inline"><input type="radio" name="amount" value={a} defaultChecked={i === 1} /> {money(a, 0)}</label>)}
                <label className="inline">or <input name="custom" type="number" min={MIN_TOP_UP} max={MAX_TOP_UP} step={1} placeholder="Other" style={{ width: "7em" }} /></label>
                <button type="submit">Pay by card</button>
                <span className="small muted">Paid through Stripe; the credit shows here as soon as Stripe confirms it.</span>
              </form>
            ) : <p className="small muted" data-testid="no-stripe">Card payments are not set up yet (STRIPE_SECRET_KEY on the web server). Staff can add credit meanwhile.</p>}
          </section>

          <section className="card" data-testid="statements">
            <h2>Statements</h2>
            <p className="small muted">Each statement lists every charge with the AI call behind it: project, activity, model, tokens and what you were charged.</p>
            <ul>{months.map((m) => <li key={m}><Link href={`/account/billing/statement/${m}`}>{new Date(`${m}-01T00:00:00Z`).toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" })}</Link>
              {" "}· <a href={`/account/billing/statement/${m}/csv`}>CSV</a></li>)}</ul>
          </section>
        </>
      )}
    </main>
  );
}
