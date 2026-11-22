import Link from "next/link";
import { requireUser } from "@/lib/auth";

/** Every run of the project, newest first, each linking to its live page. */
export default async function RunsPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const { supabase } = await requireUser();
  const { data: runs } = await supabase.from("runs").select("id, name, status, mode, stop_reason, created_at, finished_at, max_ai_spend_usd, plans(version)")
    .eq("project_id", projectId).order("created_at", { ascending: false }).limit(100);
  const ids = (runs ?? []).map((r) => r.id);
  const { data: costs } = ids.length ? await supabase.from("cost_events").select("run_id, cost_usd").in("run_id", ids) : { data: [] };
  const spent = (id: string) => (costs ?? []).filter((c) => c.run_id === id).reduce((n, c) => n + Number(c.cost_usd), 0);
  return (
    <main>
      <h1>Runs</h1>
      <p className="muted">Each run works through an approved plan. The newest is first; open one to see what it is doing, approve its results or raise its budget.</p>
      <table data-testid="runs">
        <thead><tr><th>Run</th><th>Plan</th><th>Status</th><th>Started</th><th>Spent</th></tr></thead>
        <tbody>{(runs ?? []).map((r) => (
          <tr key={r.id}><td><Link href={`/projects/${projectId}/runs/${r.id}`}>{r.name || "Run"}</Link></td>
            <td>v{(r.plans as unknown as { version: number }).version}</td>
            <td><span className={`pill pill-${r.status}`}>{r.status}</span>{r.stop_reason ? <span className="small muted"> {r.stop_reason}</span> : null}</td>
            <td className="small">{new Date(r.created_at).toLocaleString()}</td><td>${spent(r.id).toFixed(2)} of ${Number(r.max_ai_spend_usd).toFixed(0)}</td></tr>))}
          {!(runs ?? []).length && <tr><td colSpan={5} className="muted">No runs yet: approve a plan and authorize a run from its page.</td></tr>}</tbody>
      </table>
    </main>
  );
}
