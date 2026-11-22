import Link from "next/link";
import { Banner } from "@/components/Banner";
import { requireUser } from "@/lib/auth";
import { loadAiCalls, perMinute, summarize, tokens, usd as money } from "@/lib/ai-usage";

interface Plan {
  id: string; name: string; description: string | null; max_projects: number | null; max_active_runs: number | null;
  max_concurrent_tasks: number | null; monthly_ai_usd: number | null; monthly_compute_usd: number | null;
  monthly_concept_rounds: number | null; queue_weight: number;
}
interface Usage {
  projects: number; active_runs: number; running_tasks: number; ai_usd: number; compute_usd: number;
  concept_rounds: number; month_start: string;
}

const usd = (n: number) => `$${Number(n).toFixed(2)}`;

function Meter({ label, used, limit, fmt = String, testId }: {
  label: string; used: number; limit: number | null; fmt?: (n: number) => string; testId: string;
}) {
  const share = limit ? Math.min(1, Number(used) / Number(limit)) : 0;
  return (
    <div className="meter" data-testid={testId}>
      <div className="row spread small"><span>{label}</span>
        <span>{fmt(used)} {limit === null ? <span className="muted">(no limit)</span> : <>of {fmt(limit)}</>}</span></div>
      {limit !== null && <div className="meter-track" role="progressbar" aria-label={label} aria-valuenow={Math.round(share * 100)}
        aria-valuemin={0} aria-valuemax={100}><div className="meter-fill" style={{ width: `${share * 100}%`, background: share >= 1 ? "var(--danger, #b42318)" : undefined }} /></div>}
    </div>
  );
}

/** The signed-in account's plan, its limits and this month's use across every project the account created. */
export default async function AccountPage({ searchParams }: { searchParams: Promise<{ error?: string; notice?: string }> }) {
  const { error, notice } = await searchParams;
  const { supabase, userId } = await requireUser();
  const { data, error: e } = await supabase.rpc("my_account");
  // AI spend across the projects this account created: by month, project and activity.
  const { data: owned } = await supabase.from("projects").select("id, name").eq("created_by", userId);
  const calls = await loadAiCalls(supabase, (owned ?? []).map((p) => p.id));
  const all = summarize(calls);
  const months = [...new Set(calls.map((c) => c.created_at.slice(0, 7)))].sort().reverse().slice(0, 6)
    .map((m) => [m, summarize(calls.filter((c) => c.created_at.startsWith(m))).total] as const);
  const byProject = (owned ?? []).map((p) => [p, summarize(calls.filter((c) => c.project_id === p.id)).total] as const).filter(([, t]) => t.calls).sort((a, b) => b[1].usd - a[1].usd);
  const { plan, usage } = (data ?? {}) as { plan?: Plan; usage?: Usage };
  const month = usage ? new Date(usage.month_start).toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" }) : "";

  return (
    <main>
      <p className="crumbs"><Link href="/projects">Projects</Link> /</p>
      <h1>Account</h1>
      <Banner error={error ?? e?.message} notice={notice} />
      <p data-testid="billing-link"><Link href="/account/billing">Billing</Link>: balance, plan, add credit and monthly statements.</p>
      {plan && usage && (
        <>
          <p data-testid="plan"><strong>{plan.name} plan.</strong> {plan.description}</p>
          <p className="small muted">Limits cover every project you created, whoever on the project starts the work. Monthly allowances
            renew on the 1st (UTC). When an allowance is used up, running work stops at its next checkpoint and new runs wait for the
            next month; nothing is lost.</p>

          <section className="card">
            <h2>This month ({month})</h2>
            <Meter testId="usage-ai" label="AI spend" used={usage.ai_usd} limit={plan.monthly_ai_usd} fmt={usd} />
            <Meter testId="usage-compute" label="Worker compute" used={usage.compute_usd} limit={plan.monthly_compute_usd} fmt={usd} />
            <Meter testId="usage-concepts" label="Concept rounds" used={usage.concept_rounds} limit={plan.monthly_concept_rounds} />
          </section>

          <section className="card">
            <h2>Right now</h2>
            <Meter testId="usage-projects" label="Projects" used={usage.projects} limit={plan.max_projects} />
            <Meter testId="usage-runs" label="Active runs (running or paused)" used={usage.active_runs} limit={plan.max_active_runs} />
            <Meter testId="usage-tasks" label="Tasks running at once" used={usage.running_tasks} limit={plan.max_concurrent_tasks} />
            <p className="small muted">Workers are shared fairly: each new task goes to the account with the fewest tasks running
              {plan.queue_weight !== 1 && <> (your plan counts as {plan.queue_weight}× share)</>}, so one busy account cannot hold up everyone
              else. Tasks beyond your limit wait in the queue and start as yours finish.</p>
          </section>
        </>
      )}

      <section className="card" data-testid="ai-spend">
        <h2>AI spend</h2>
        <p className="small muted">Every AI call in your projects, priced at the API&apos;s token rates. {all.total.calls} call(s), {money(all.total.usd)} in all
          {perMinute(all.total) != null && <>, {money(perMinute(all.total)!)} per minute of AI time</>}; {tokens(all.total.output)} tokens written, {tokens(all.total.input)} read.</p>
        <div className="grid2">
          <div><h3>By month</h3>
            <table className="small" data-testid="ai-by-month"><thead><tr><th>Month</th><th>Calls</th><th>Cost</th></tr></thead>
              <tbody>{months.map(([m, t]) => <tr key={m}><td>{m}</td><td>{t.calls}</td><td>{money(t.usd)}</td></tr>)}
                {!months.length && <tr><td colSpan={3} className="muted">None yet.</td></tr>}</tbody></table></div>
          <div><h3>By project</h3>
            <table className="small" data-testid="ai-by-project"><thead><tr><th>Project</th><th>Calls</th><th>Cost</th></tr></thead>
              <tbody>{byProject.map(([p, t]) => <tr key={p.id}><td><Link href={`/projects/${p.id}/usage`}>{p.name}</Link></td><td>{t.calls}</td><td>{money(t.usd)}</td></tr>)}
                {!byProject.length && <tr><td colSpan={3} className="muted">None yet.</td></tr>}</tbody></table></div>
        </div>
        <h3>By activity</h3>
        <table className="small" data-testid="ai-by-activity"><thead><tr><th>Activity</th><th>Calls</th><th>Cost</th><th>Share</th><th>Per call</th><th>Per minute</th></tr></thead>
          <tbody>{all.byActivity.map(([k, t]) => <tr key={k}><td>{k}</td><td>{t.calls}</td><td>{money(t.usd)}</td>
            <td>{all.total.usd ? `${Math.round((t.usd / all.total.usd) * 100)}%` : "—"}</td><td>{money(t.usd / t.calls)}</td><td>{perMinute(t) != null ? money(perMinute(t)!) : "—"}</td></tr>)}</tbody></table>
      </section>
    </main>
  );
}
