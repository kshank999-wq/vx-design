import Link from "next/link";
import { SubmitButton } from "@/components/SubmitButton";
import { requireUser } from "@/lib/auth";
import { restartRun } from "./[runId]/actions";

const LABEL: Record<string, string> = {
  pending: "Starting", running: "Running", paused: "Paused", completed: "Completed", stopped: "Stopped", failed: "Failed", canceled: "Canceled",
};
const GOING = ["pending", "running", "paused"];

/**
 * Every run of the project: the ones going first (green), then the rest, newest first. Each opens its page, and any
 * run that is not going can be restarted from here once its problem is dealt with.
 */
export default async function RunsPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const { supabase, userId } = await requireUser();
  const [{ data: runs }, { data: me }] = await Promise.all([
    supabase.from("runs").select("id, name, status, mode, stop_reason, created_at, finished_at, max_ai_spend_usd, plan_id, plans(version)")
      .eq("project_id", projectId).order("created_at", { ascending: false }).limit(100),
    supabase.from("project_members").select("role").eq("project_id", projectId).eq("user_id", userId).maybeSingle(),
  ]);
  const canControl = me?.role === "owner" || me?.role === "engineer";
  const ids = (runs ?? []).map((r) => r.id);
  const { data: costs } = ids.length ? await supabase.from("cost_events").select("run_id, cost_usd").in("run_id", ids) : { data: [] };
  const spent = (id: string) => (costs ?? []).filter((c) => c.run_id === id).reduce((n, c) => n + Number(c.cost_usd), 0);
  const all = runs ?? [];
  const sorted = [...all.filter((r) => r.status === "running" || r.status === "pending"), ...all.filter((r) => r.status === "paused"),
    ...all.filter((r) => !GOING.includes(r.status))];
  const goingOn = (planId: string, id: string) => all.find((o) => o.plan_id === planId && o.id !== id && GOING.includes(o.status));
  return (
    <main>
      <h1>Runs</h1>
      <p className="muted">Each run works through an approved plan. Green runs are working now; yellow ones have stopped and wait for you.
        Open a run to see what stopped it, deal with it (answer, give guidance, raise a limit), then restart it.</p>
      <div className="runs-list" data-testid="runs">
        {sorted.map((r) => {
          const going = GOING.includes(r.status) && r.status !== "paused";
          const other = goingOn(r.plan_id, r.id);
          return (
            <article key={r.id} className={`card run-row ${going ? "going" : ["stopped", "paused"].includes(r.status) ? "held" : ""}`} data-run={r.id}>
              <div>
                <div className="row tight wrap">
                  <strong><Link href={`/projects/${projectId}/runs/${r.id}`}>{r.name || "Run"}</Link></strong>
                  <span className={`pill pill-${r.status}`}>{LABEL[r.status] ?? r.status}</span>
                  <span className="small muted">plan v{(r.plans as unknown as { version: number }).version} · started {new Date(r.created_at).toLocaleString("en-US")} · ${spent(r.id).toFixed(2)} of ${Number(r.max_ai_spend_usd).toFixed(0)} AI</span>
                </div>
                {r.stop_reason && !going && <p className="small" style={{ margin: "6px 0 0" }}>{r.status === "stopped" ? "Stopped: " : ""}{r.stop_reason}</p>}
                {other && !going && <p className="small muted" style={{ margin: "4px 0 0" }}>The work of this plan is going on in {other.name || "another run"}; restarting this one stops that one (its finished work is kept).</p>}
              </div>
              <div className="row tight">
                <Link className="btn btn-secondary" href={`/projects/${projectId}/runs/${r.id}`}>Open</Link>
                {canControl && !GOING.includes(r.status) && (
                  <form action={restartRun.bind(null, projectId, r.id)}>
                    <SubmitButton pendingText="Restarting…">{["canceled", "failed"].includes(r.status) ? "↻ Start again" : "↻ Restart"}</SubmitButton>
                  </form>
                )}
              </div>
            </article>
          );
        })}
        {!all.length && <p className="muted">No runs yet: approve a plan and authorize a run from its page.</p>}
      </div>
    </main>
  );
}
