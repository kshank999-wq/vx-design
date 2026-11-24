import Link from "next/link";
import { notFound } from "next/navigation";
import { Banner } from "@/components/Banner";
import { SubmitButton } from "@/components/SubmitButton";
import { requireUser } from "@/lib/auth";
import { money } from "@/lib/billing";
import { setAccountPlan } from "./actions";

interface Account { user_id: string; email: string; plan_id: string; plan_name: string; monthly_ai_usd: number | null; monthly_compute_usd: number | null;
  ai_usd: number; compute_usd: number; projects: number }

/**
 * VX Design administrators only: every account that owns projects, its plan, this month's AI and compute use
 * against the plan's allowance, and changing the plan. A run stops when its account's allowance is used up.
 */
export default async function AccountsPage({ searchParams }: { searchParams: Promise<{ notice?: string; error?: string }> }) {
  const { notice, error } = await searchParams;
  const { supabase } = await requireUser();
  const { data: admin } = await supabase.rpc("is_platform_admin");
  if (!admin) notFound();
  const [{ data }, { data: plans }] = await Promise.all([
    supabase.rpc("admin_accounts"),
    supabase.from("account_plans").select("id, name, monthly_ai_usd, monthly_compute_usd, billing").order("name"),
  ]);
  const rows = (data ?? []) as Account[];
  const allowance = (n: number | null) => (n == null ? "no limit" : money(n));
  return (
    <main>
      <p className="crumbs"><Link href="/admin/earnings">Admin</Link> /</p>
      <h1>Accounts and plans</h1>
      <p className="muted">Each account&apos;s plan sets its monthly AI and compute allowance. When an account uses its allowance, its runs stop
        until the 1st or until it moves to a bigger plan here. In-house accounts are best on <strong>Unlimited</strong>: each run&apos;s own budget is then the limit.</p>
      <Banner error={error} notice={notice} />
      <p><Link href="/admin/earnings">AI earnings →</Link></p>
      <table className="small" data-testid="accounts">
        <thead><tr><th>Account</th><th className="num">Projects</th><th>Plan</th><th className="num">AI this month</th><th className="num">Compute this month</th><th>Change plan</th></tr></thead>
        <tbody>{rows.map((a) => {
          const over = a.monthly_ai_usd != null && Number(a.ai_usd) >= Number(a.monthly_ai_usd);
          return (
            <tr key={a.user_id} data-testid="account-row">
              <td>{a.email}</td><td className="num">{a.projects}</td><td>{a.plan_name}</td>
              <td className="num">{money(a.ai_usd)} of {allowance(a.monthly_ai_usd)}{over && <> <span className="pill pill-failed">used up</span></>}</td>
              <td className="num">{money(a.compute_usd)} of {allowance(a.monthly_compute_usd)}</td>
              <td>
                <form className="row tight" action={setAccountPlan.bind(null, a.user_id)}>
                  <select name="plan" defaultValue={a.plan_id} aria-label={`Plan for ${a.email}`}>
                    {(plans ?? []).map((p) => <option key={p.id} value={p.id}>{p.name} ({p.monthly_ai_usd == null ? "no monthly AI limit" : `${money(p.monthly_ai_usd)} AI a month`}{p.billing === "prepaid" ? ", prepaid" : ""})</option>)}
                  </select>
                  <SubmitButton variant="secondary" pendingText="Saving…">Save</SubmitButton>
                </form>
              </td>
            </tr>);
        })}
        {!rows.length && <tr><td colSpan={6} className="muted">No accounts with projects yet.</td></tr>}</tbody>
      </table>
    </main>
  );
}
