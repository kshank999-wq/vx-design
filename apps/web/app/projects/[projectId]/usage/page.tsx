import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { activityOf, loadAiCalls, perMinute, summarize, tokens, usd } from "@/lib/ai-usage";
import { PRICES } from "@vx/planning";
import { viewerPricing } from "@/lib/pricing";

/**
 * What this project's AI work has cost: every model call, priced from the token price table, by activity, with the
 * time each took. Staff only.
 */
export default async function UsagePage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const { supabase, userId } = await requireUser();
  const [{ data: project }, { data: me }] = await Promise.all([
    supabase.from("projects").select("name").eq("id", projectId).maybeSingle(),
    supabase.from("project_members").select("role").eq("project_id", projectId).eq("user_id", userId).maybeSingle(),
  ]);
  if (!project || !me || me.role === "client") notFound();
  const calls = await loadAiCalls(supabase, [projectId]);
  const month = new Date(); month.setUTCDate(1); month.setUTCHours(0, 0, 0, 0);
  const all = summarize(calls), thisMonth = summarize(calls.filter((c) => c.created_at >= month.toISOString()));
  const rate = perMinute(all.total);
  const price = PRICES["claude-opus-5-5"]!;
  // Customers see prices; administrators see our cost beside the price and the markup.
  const pr = await viewerPricing(supabase, projectId);
  const p = pr.price;

  return (
    <main>
      <p className="crumbs"><Link href="/projects">Projects</Link> / <Link href={`/projects/${projectId}`}>{project.name}</Link> /</p>
      <h1>AI usage</h1>
      {pr.admin ? (
        <p className="muted" data-testid="usage-admin-note">Administrator view: <strong>cost</strong> is ours at the API&apos;s token rates (Claude Opus 5.5: ${price.input} per million tokens read,
          ${price.output} per million written, ${price.cacheRead} per million read back from the cache); <strong>price</strong> is what this project&apos;s plan charges
          (×{pr.rate.toFixed(2)}), and the difference is our markup. Customers see the price only.</p>
      ) : (
        <p className="muted">Every AI call this project has made, with its price. Work done by the platform&apos;s own software (checks, calculations, file reading,
          exports) costs nothing here.</p>
      )}
      <p className="muted small"> <Link href={`/projects/${projectId}/compare`}>Choose or compare the model that reads specifications and datasheets</Link>.</p>

      <div className="tiles overview-tiles" data-testid="usage-tiles">
        {pr.admin && <div className="tile" data-testid="usage-markup"><strong>{usd(all.total.usd * (pr.rate - 1))}</strong> markup all time<span className="muted small">cost {usd(all.total.usd)} · price {usd(p(all.total.usd))}</span></div>}
        <div className="tile"><strong>{usd(p(thisMonth.total.usd))}</strong> this month<span className="muted small">{thisMonth.total.calls} AI call(s)</span></div>
        <div className="tile"><strong>{usd(p(all.total.usd))}</strong> all time<span className="muted small">{all.total.calls} AI call(s)</span></div>
        <div className="tile"><strong>{rate != null ? usd(p(rate)) : "—"}</strong> per minute of AI time<span className="muted small">{all.total.minutes.toFixed(1)} min timed</span></div>
        <div className="tile"><strong>{tokens(all.total.output)}</strong> tokens written<span className="muted small">{tokens(all.total.input)} read · {tokens(all.total.cacheRead)} from cache</span></div>
      </div>

      <section>
        <h2>By activity</h2>
        <table className="small" data-testid="usage-by-activity">
          <thead><tr><th>Activity</th><th>Calls</th>{pr.admin && <th>Cost</th>}<th>Price</th><th>Share</th><th>Per call</th><th>Time</th><th>Per minute</th><th>Read / written</th></tr></thead>
          <tbody>{all.byActivity.map(([k, t]) => (
            <tr key={k} data-activity={k}><td>{k}</td><td>{t.calls}</td>{pr.admin && <td>{usd(t.usd)}</td>}<td>{usd(p(t.usd))}</td><td>{all.total.usd ? `${Math.round((t.usd / all.total.usd) * 100)}%` : "—"}</td>
              <td>{usd(p(t.usd / t.calls))}</td><td>{t.minutes ? `${t.minutes.toFixed(1)} min` : "—"}</td><td>{perMinute(t) != null ? usd(p(perMinute(t)!)) : "—"}</td>
              <td>{tokens(t.input)} / {tokens(t.output)}</td></tr>
          ))}{!calls.length && <tr><td colSpan={pr.admin ? 9 : 8} className="muted">No AI calls yet.</td></tr>}</tbody>
        </table>
      </section>

      <section>
        <details className="card small" data-testid="usage-calls">
          <summary>Every call ({calls.length}{calls.length === 5000 ? ", the latest 5,000" : ""})</summary>
          <table>
            <thead><tr><th>When</th><th>Activity</th><th>Model</th><th>Read</th><th>Cache</th><th>Written</th><th>Time</th>{pr.admin && <th>Cost</th>}<th>Price</th></tr></thead>
            <tbody>{calls.slice(0, 300).map((c) => (
              <tr key={c.id} data-purpose={c.purpose ?? ""}><td>{new Date(c.created_at).toLocaleString()}</td>
                <td>{activityOf(c.purpose)}{c.purpose && /repair/.test(c.purpose) ? <span className="muted"> (repair round)</span> : null}{c.failed ? <span className="pill pill-failed">failed, billed</span> : null}{c.execution_id ? <span className="muted"> (run task)</span> : null}</td>
                <td className="mono">{c.resource}</td><td>{c.input_tokens != null ? tokens(c.input_tokens) : tokens(Number(c.quantity))}</td>
                <td>{tokens(Number(c.cache_read_tokens ?? 0))}</td><td>{c.output_tokens != null ? tokens(c.output_tokens) : "—"}</td>
                <td>{c.duration_ms ? `${(c.duration_ms / 1000).toFixed(0)} s` : "—"}</td>{pr.admin && <td>{usd(Number(c.cost_usd))}</td>}<td>{usd(p(Number(c.cost_usd)))}</td></tr>
            ))}</tbody>
          </table>
          {calls.length > 300 && <p className="muted">The 300 latest are shown.</p>}
        </details>
      </section>
    </main>
  );
}
