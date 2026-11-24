import Link from "next/link";

const LABEL: Record<string, string> = {
  pending: "Starting", running: "Running", paused: "Paused", completed: "Completed", stopped: "Stopped", failed: "Failed", canceled: "Canceled",
};

export interface SideRun { id: string; name: string | null; status: string; created_at: string; plan_version: number | null }
export interface SideTask { id: string; title: string; status: string; deferred_at: string | null; skipped_at: string | null; blocker_reason: string | null }
export interface SideLive { task_id: string; title: string; run_id: string }

/**
 * The project's runs and where the work stands, beside any run page: every run (the working one first), what is
 * being worked on right now in any run, and a count of the plan's steps by state with links to the lists.
 */
export function RunsSide({ projectId, currentRunId, runs, tasks, live }: {
  projectId: string; currentRunId: string; runs: SideRun[]; tasks: SideTask[]; live: SideLive[];
}) {
  const working = runs.filter((r) => ["pending", "running", "paused"].includes(r.status));
  const rest = runs.filter((r) => !working.includes(r));
  const count = (f: (t: SideTask) => boolean) => tasks.filter(f).length;
  const interrupted = (t: SideTask) => t.status === "blocked" && /^interrupted /.test(t.blocker_reason ?? "");
  const rows: [string, number, string][] = [
    ["Done", count((t) => t.status === "complete" && !t.skipped_at), "?tab=tasks"],
    ["Working now", live.length, "?tab=tasks"],
    ["Waiting for you", count((t) => t.status === "awaiting_approval"), "#approvals"],
    ["Could not finish", count((t) => !t.deferred_at && (t.status === "failed" || interrupted(t))), "#what-to-do"],
    ["On hold", count((t) => !!t.skipped_at), "#what-to-do"],
    ["Saved for later", count((t) => !!t.deferred_at), "#what-to-do"],
    ["Not started", count((t) => ["ready", "pending", "blocked"].includes(t.status) && !t.deferred_at && !interrupted(t)), "?tab=tasks"],
  ];
  const item = (r: SideRun) => (
    <li key={r.id} className={r.id === currentRunId ? "current" : ""}>
      <Link href={`/projects/${projectId}/runs/${r.id}`}>
        <span className={`dot dot-${r.status}`} aria-hidden="true" />
        <span className="runs-side-name">{r.name || "Run"}{r.plan_version ? <span className="muted"> · plan v{r.plan_version}</span> : null}</span>
        <span className="muted small">{LABEL[r.status] ?? r.status} · {new Date(r.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
      </Link>
    </li>
  );
  return (
    <aside className="runs-side" data-testid="runs-side">
      <details open>
        <summary><strong>Runs</strong> <span className="muted small">({runs.length})</span></summary>
        {working.length > 0 && <><p className="runs-side-label">Working now</p><ul>{working.map(item)}</ul></>}
        {rest.length > 0 && <><p className="runs-side-label">Earlier</p><ul>{rest.map(item)}</ul></>}
      </details>
      {live.length > 0 && (
        <div className="runs-side-block">
          <p className="runs-side-label">Being worked on</p>
          <ul>{live.map((l) => <li key={l.task_id}><Link href={`/projects/${projectId}/runs/${l.run_id}?tab=tasks`}><span className="dot dot-running" aria-hidden="true" />{l.title}</Link></li>)}</ul>
        </div>
      )}
      <div className="runs-side-block">
        <p className="runs-side-label">Steps of this plan ({tasks.length})</p>
        <ul className="runs-side-counts">{rows.filter(([, n]) => n > 0).map(([label, n, href]) => (
          <li key={label}><a href={href}><span>{label}</span><strong>{n}</strong></a></li>))}</ul>
      </div>
    </aside>
  );
}
