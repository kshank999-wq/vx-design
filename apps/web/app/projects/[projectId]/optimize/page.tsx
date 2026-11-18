import Link from "next/link";
import { notFound } from "next/navigation";
import { AutoRefresh } from "@/components/AutoRefresh";
import { Banner } from "@/components/Banner";
import { SubmitButton } from "@/components/SubmitButton";
import { requireUser } from "@/lib/auth";
import { decide, runAnalysis } from "./actions";

interface Impact { metric: string; at?: string; before: number | string | null; after: number | string | null; unit: string; better: "lower" | "higher" | "n/a" }
interface Check { id: string; status: "met" | "violated" | "needs_review"; detail: string }

const OBJECTIVE: Record<string, string> = {
  cost: "Cost", availability: "Availability", lifecycle: "Lifecycle", supply: "Second source", consolidation: "Fewer parts",
  power: "Power", standby: "Standby power", thermal: "Thermal",
};
const fmt = (v: number | string | null, unit: string) => v === null ? "—" : typeof v === "number" ? `${v.toLocaleString("en-US", { maximumFractionDigits: 4 })}${unit ? ` ${unit}` : ""}` : v;
function delta(i: Impact): { text: string; good: boolean | null } {
  if (typeof i.before !== "number" || typeof i.after !== "number" || i.better === "n/a") return { text: "", good: null };
  const d = i.after - i.before;
  if (!d) return { text: "no change", good: null };
  const pct = i.before ? ` (${d > 0 ? "+" : ""}${((100 * d) / Math.abs(i.before)).toFixed(0)}%)` : "";
  return { text: `${d > 0 ? "+" : ""}${Math.round(d * 10000) / 10000}${pct}`, good: i.better === "lower" ? d < 0 : d > 0 };
}

export default async function OptimizePage({ params, searchParams }: {
  params: Promise<{ projectId: string }>; searchParams: Promise<{ error?: string; notice?: string; objective?: string }>;
}) {
  const { projectId } = await params;
  const { error, notice, objective } = await searchParams;
  const { supabase, userId } = await requireUser();
  const [{ data: project }, { data: me }, { data: runs }] = await Promise.all([
    supabase.from("projects").select("name").eq("id", projectId).maybeSingle(),
    supabase.from("project_members").select("role").eq("project_id", projectId).eq("user_id", userId).maybeSingle(),
    supabase.from("optimization_runs").select("*").eq("project_id", projectId).order("run_no", { ascending: false }).limit(5),
  ]);
  if (!project) notFound();
  const latest = runs?.[0];
  const { data: props } = latest
    ? await supabase.from("proposals").select("*").eq("run_id", latest.id).order("rank")
    : { data: [] as never[] };
  const role = me?.role ?? "viewer";
  const canRun = role === "owner" || role === "engineer";
  const canDecide = role === "owner" || role === "reviewer";
  const busy = latest?.status === "queued" || latest?.status === "running";
  const all = (props ?? []).filter((p) => !objective || p.objective === objective);
  const open = all.filter((p) => p.status === "open");
  const decided = all.filter((p) => p.status === "accepted" || p.status === "rejected");
  const inputs = (latest?.inputs ?? {}) as { bom?: { artifact: string; sha256: string } | null; power?: { artifact: string; sha256: string } | null;
                                             lookups?: { looked_up: number; found: number; providers: string[]; skipped: number } };
  const summary = (latest?.summary ?? {}) as { note?: string | null; fixture?: boolean };
  const excluded = (latest?.excluded ?? []) as { title: string; reason: string }[];

  const card = (p: NonNullable<typeof props>[number]) => {
    const impact = p.impact as Impact[];
    const checks = p.constraints as Check[];
    const basis = p.basis as { method: string; inputs: string[]; assumptions: string[] };
    const affects = p.affects as { interfaces: string[]; manufacturability: string[]; standards: string[] };
    const review = checks.some((c) => c.status === "needs_review");
    return (
      <article key={p.id} className="card stack proposal" data-testid="proposal" data-objective={p.objective} data-status={p.status}>
        <div className="row spread">
          <h3>{p.status === "open" && <span className="muted">#{p.rank} </span>}{p.title}</h3>
          <span className="row tight">
            <span className={`pill pill-obj-${p.objective}`}>{OBJECTIVE[p.objective] ?? p.objective}</span>
            <span className={`pill pill-conf-${p.confidence}`} title={p.confidence_reason ?? ""}>{p.confidence} confidence</span>
            <span className="pill">effort {p.effort}</span>
          </span>
        </div>
        <p className="small"><strong>Change:</strong> {(p.change as { from: string }).from} → {(p.change as { to: string }).to} <span className="muted">({p.subject})</span></p>
        <table className="small impact" data-testid="impact">
          <thead><tr><th>Measure</th><th>Before</th><th>After</th><th>Change</th></tr></thead>
          <tbody>{impact.map((i, k) => {
            const d = delta(i);
            return <tr key={k}><td>{i.metric}{i.at ? <span className="muted"> · {i.at}</span> : null}</td><td>{fmt(i.before, i.unit)}</td><td>{fmt(i.after, i.unit)}</td>
              <td className={d.good === null ? "" : d.good ? "good" : "error-text"}>{d.text}</td></tr>;
          })}</tbody>
        </table>
        <details className="small"><summary>Basis, constraints and effects</summary>
          <p><strong>How it was computed:</strong> {basis.method}. Inputs: {basis.inputs.join("; ") || "—"}.</p>
          {!!basis.assumptions.length && <p className="warn-text"><strong>Assumed:</strong> {basis.assumptions.join("; ")}</p>}
          <p><strong>Confidence:</strong> {p.confidence}: {p.confidence_reason}</p>
          <p><strong>Cost and work:</strong> {p.cost_note}</p>
          <ul>{checks.map((c, k) => <li key={k}><span className={`pill pill-check-${c.status === "met" ? "pass" : c.status === "violated" ? "fail" : "warning"}`}>{c.status.replace("_", " ")}</span> <strong>{c.id}</strong>: {c.detail}</li>)}</ul>
          {!!affects.interfaces.length && <p><strong>Interfaces:</strong> {affects.interfaces.join("; ")}</p>}
          {!!affects.manufacturability.length && <p><strong>Manufacturing:</strong> {affects.manufacturability.join("; ")}</p>}
          {!!affects.standards.length && <p><strong>Standards:</strong> {affects.standards.join("; ")}</p>}
          {!!p.targets.length && <p><strong>Requirements:</strong> {p.targets.join(", ")}</p>}
        </details>
        {p.status === "open" && (canDecide ? (
          <form className="approval-stop stack" action={decide.bind(null, projectId, p.id, true)}>
            {review && <label className="radio"><input type="checkbox" name="reviewed" /> The constraints marked “needs review” have been checked</label>}
            <textarea name="note" rows={2} placeholder="Note (required to reject)" aria-label={`Note for ${p.title}`} />
            <div className="row tight">
              <SubmitButton pendingText="Accepting…">Accept</SubmitButton>
              <SubmitButton variant="danger" formAction={decide.bind(null, projectId, p.id, false)} pendingText="Rejecting…">Reject</SubmitButton>
            </div>
          </form>
        ) : <p className="small muted">An owner or reviewer decides.</p>)}
        {p.status !== "open" && <p className="small" data-testid="decision"><span className={`pill pill-${p.status === "accepted" ? "complete" : "failed"}`}>{p.status}</span>
          {" "}{p.decided_at ? new Date(p.decided_at).toLocaleString() : ""}{p.decision_note ? `: ${p.decision_note}` : ""}
          {p.status === "accepted" && " · recorded as a decision for the next design revision"}</p>}
      </article>
    );
  };

  return (
    <main>
      <p className="crumbs"><Link href="/projects">Projects</Link> / <Link href={`/projects/${projectId}`}>{project.name}</Link> /</p>
      <div className="row spread"><h1>Optimization proposals</h1>{busy && <AutoRefresh intervalMs={2500} />}</div>
      <p className="muted">Ranked changes to cost, availability, lifecycle, power and heat. Every before/after is computed from distributor offers or by
        re-running the power calculator; assumptions are named. Ideas that would break a hard constraint (value, package, rating, a requirement)
        are not offered. Accepted proposals become decisions for the next design revision.</p>
      <Banner error={error} notice={notice} />

      {canRun && (
        <form action={runAnalysis.bind(null, projectId)} className="card row" data-testid="run-form">
          <label className="inline">Rank cost at <select name="focus" defaultValue="100" aria-label="Focus quantity">{[1, 10, 100, 1000].map((q) => <option key={q} value={q}>{q} boards</option>)}</select></label>
          <label className="inline">Assembly fee per unique part (optional)<input name="fee" type="number" step="0.01" min="0" style={{ width: 90 }} aria-label="Assembly fee per unique part" /></label>
          <SubmitButton pendingText="Requesting…" disabled={busy}>{latest ? "Run the analysis again" : "Run the analysis"}</SubmitButton>
        </form>
      )}

      {latest ? (
        <section className="small" data-testid="run">
          <p><span className={`pill pill-${latest.status === "ready" ? "complete" : latest.status === "failed" ? "failed" : "awaiting_approval"}`} data-testid="run-status">{latest.status}</span>
            {" "}Analysis {latest.run_no}{latest.completed_at ? `, ${new Date(latest.completed_at).toLocaleString()}` : ""}.
            {" "}Read: {inputs.bom ? <code>{inputs.bom.artifact}</code> : "no sourced BOM"}{", "}{inputs.power ? <code>{inputs.power.artifact}</code> : "no power budget"}
            {inputs.lookups ? `; ${inputs.lookups.found} of ${inputs.lookups.looked_up} alternative part(s) found at ${inputs.lookups.providers.join(", ") || "no distributor"}` : ""}.</p>
          {latest.error && <p className="banner banner-error">{latest.error}</p>}
          {summary.note && <p className="warn-text">{summary.note}</p>}
          {summary.fixture && <p className="warn-text">Uses fixture distributor data (invented prices and stock): review the method, not the numbers.</p>}
        </section>
      ) : <p className="muted">No analysis yet. It needs an approved sourced BOM and/or power budget.</p>}

      {latest?.status === "ready" && (
        <>
          <p className="row small">Show: <Link href={`?`}>all</Link>{Object.entries(OBJECTIVE).map(([k, v]) => <Link key={k} href={`?objective=${k}`}>{v}</Link>)}</p>
          <h2>Open ({open.length})</h2>
          {open.map(card)}
          {!open.length && <p className="muted">Nothing open{objective ? " for this objective" : ""}.</p>}
          {!!decided.length && <><h2>Decided ({decided.length})</h2>{decided.map(card)}</>}
          {!!excluded.length && (
            <details className="card small" data-testid="excluded"><summary>Not offered: {excluded.length} idea(s) that would break a hard constraint</summary>
              <ul>{excluded.map((e, i) => <li key={i}><strong>{e.title}</strong>: {e.reason}</li>)}</ul></details>
          )}
        </>
      )}
    </main>
  );
}
