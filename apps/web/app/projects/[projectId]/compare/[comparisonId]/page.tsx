import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { usd } from "@/lib/ai-usage";
import { READING_MODELS } from "@/lib/model";
import { compareRequirements, type CompareReq } from "@/lib/model-compare";

interface Run { requirements: CompareReq[]; cost_usd: number; duration_ms: number; error: string | null; offline?: boolean; tokens?: { input: number; output: number } }

/** One specification read by several models, set against the requirements already read from it. */
export default async function ComparisonPage({ params }: { params: Promise<{ projectId: string; comparisonId: string }> }) {
  const { projectId, comparisonId } = await params;
  const { supabase } = await requireUser();
  const { data: c } = await supabase.from("model_comparisons").select("created_at, results").eq("id", comparisonId).eq("project_id", projectId).maybeSingle();
  if (!c) notFound();
  const r = c.results as { document: string; baseline: { model: string; requirements: CompareReq[]; cost_usd: number }; models: Record<string, Run> };
  const base = r.baseline.requirements;
  const order = (m: string) => { const i = READING_MODELS.findIndex(([id]) => id === m); return i < 0 ? 99 : i; };
  const runs = Object.entries(r.models).sort((a, b) => order(a[0]) - order(b[0])).map(([m, run]) => [m, run, compareRequirements(base, run.requirements)] as const);
  const name = (m: string) => m.replace("claude-", "").replace(/-(\d)-(\d)$/, " $1.$2").replace(/^./, (x) => x.toUpperCase());
  const line = (x: CompareReq) => <><span className="mono muted">{x.blockId}</span> <span className="pill">{x.kind}</span> {x.priority !== "must" && <span className="pill">{x.priority}</span>} {x.statement}</>;

  return (
    <main>
      <p className="crumbs"><Link href="/projects">Projects</Link> / <Link href={`/projects/${projectId}/compare`}>Reading model</Link> /</p>
      <h1>{r.document}</h1>
      <p className="muted">Read again by each model on {new Date(c.created_at).toLocaleString()} and matched against the {base.length} requirements already read
        from it ({r.baseline.model}{r.baseline.cost_usd ? `, ${usd(r.baseline.cost_usd)}` : ""}). A match is the same source paragraph with the same meaning;
        check the lists below before deciding: a requirement only one model found may be a real miss or an over-reading.</p>

      <div className="scroll"><table className="small" data-testid="compare-summary">
        <thead><tr><th>Model</th><th>Requirements</th><th>Also in the baseline</th><th>Missed</th><th>Extra</th><th>Kind differs</th><th>Priority differs</th><th>Cost</th><th>Time</th></tr></thead>
        <tbody>
          <tr><td>Baseline ({r.baseline.model})</td><td>{base.length}</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td>{r.baseline.cost_usd ? usd(r.baseline.cost_usd) : "—"}</td><td>—</td></tr>
          {runs.map(([m, run, cmp]) => (
            <tr key={m} data-model={m}><td>{name(m)}{run.offline ? <span className="muted"> (offline stand-in)</span> : null}</td>
              {run.error ? <td colSpan={8} className="error-text">Failed: {run.error}</td> : <>
                <td>{run.requirements.length}</td><td>{cmp.matched.length} ({Math.round(cmp.recall * 100)}%)</td><td>{cmp.onlyBase.length}</td><td>{cmp.onlyOther.length}</td>
                <td>{cmp.matched.filter((x) => x.kindDiffers).length}</td><td>{cmp.matched.filter((x) => x.priorityDiffers).length}</td>
                <td>{usd(run.cost_usd)}</td><td>{(run.duration_ms / 1000).toFixed(0)} s</td></>}</tr>
          ))}
        </tbody>
      </table></div>

      {runs.filter(([, run]) => !run.error).map(([m, , cmp]) => (
        <section key={m} className="card" data-testid={`detail-${m}`}>
          <h2>{name(m)}</h2>
          <details open={cmp.onlyBase.length > 0}><summary>Missed: in the baseline, not found by {name(m)} ({cmp.onlyBase.length})</summary>
            <ul className="small">{cmp.onlyBase.map((x, i) => <li key={i}>{line(x)}</li>)}</ul></details>
          <details><summary>Extra: found only by {name(m)} ({cmp.onlyOther.length})</summary>
            <ul className="small">{cmp.onlyOther.map((x, i) => <li key={i}>{line(x)}</li>)}</ul></details>
          <details><summary>Matched, with a different kind or priority ({cmp.matched.filter((x) => x.kindDiffers || x.priorityDiffers).length})</summary>
            <ul className="small">{cmp.matched.filter((x) => x.kindDiffers || x.priorityDiffers).map((x, i) => (
              <li key={i}>{x.base.statement} <span className="muted">— baseline {x.base.kind}/{x.base.priority}, {name(m)} {x.other.kind}/{x.other.priority}</span></li>))}</ul></details>
          <details><summary>Matched ({cmp.matched.length}): the two wordings side by side</summary>
            <table className="small"><thead><tr><th>Baseline</th><th>{name(m)}</th></tr></thead>
              <tbody>{cmp.matched.map((x, i) => <tr key={i}><td>{x.base.statement}</td><td>{x.other.statement}</td></tr>)}</tbody></table></details>
        </section>
      ))}
    </main>
  );
}
