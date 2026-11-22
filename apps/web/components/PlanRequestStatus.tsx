import Link from "next/link";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AutoRefresh } from "@/components/AutoRefresh";
import { ElapsedClock } from "@/components/ElapsedClock";

export interface ActivePlanRequest { id: string; status: string; requirements: number; created_at: string; claimed_at: string | null; revise: number | null }

/** The plan request a worker is on (or waiting for), if any. */
export async function activePlanRequest(supabase: SupabaseClient, projectId: string): Promise<ActivePlanRequest | null> {
  const { data } = await supabase.from("plan_requests").select("id, status, requirements, created_at, claimed_at, revise:payload->revise_from->version")
    .eq("project_id", projectId).in("status", ["queued", "running"]).order("created_at", { ascending: false }).limit(1).maybeSingle();
  return (data as ActivePlanRequest | null) ?? null;
}

/**
 * The plan being made by a worker, shown large: what it is doing (updating the latest plan, or planning from scratch),
 * a live clock, and a warning when no worker has picked it up. The page refreshes itself and links to the plan when it
 * is ready; a failure shows the reason.
 */
export async function PlanRequestStatus({ supabase, projectId }: { supabase: SupabaseClient; projectId: string }) {
  const { data: r } = await supabase.from("plan_requests").select("id, status, requirements, error, plan_id, created_at, claimed_at, completed_at, revise:payload->revise_from->version, plans(version)")
    .eq("project_id", projectId).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (!r) return null;
  const revise = r.revise as number | null;
  if (r.status === "queued" || r.status === "running") {
    const waiting = r.status === "queued";
    const stuck = waiting && Date.now() - new Date(r.created_at).getTime() > 3 * 60_000;
    const what = revise ? `Updating plan v${revise} with what changed` : `Building a plan from ${r.requirements} requirements`;
    return (
      <div className="card build-status" data-testid="plan-request" data-status={r.status} role="status" aria-live="polite">
        <div className="row spread">
          <div>
            <p className="eyebrow tech">{waiting ? "Waiting for a worker" : "Working"}</p>
            <h2>{what}…</h2>
          </div>
          <div className="build-clock"><ElapsedClock since={r.created_at} /><span className="muted small">elapsed</span></div>
        </div>
        <div className="build-bar" aria-hidden><span /></div>
        <ol className="build-steps small">
          <li className="done">Request sent</li>
          <li className={waiting ? "now" : "done"}>A worker picks it up</li>
          <li className={waiting ? "" : "now"}>{revise ? "Reworking the affected tasks and checking the whole plan" : "Planning every requirement and checking the plan"}</li>
          <li>Saved as a new draft version</li>
        </ol>
        <p className="small muted">{revise ? "Usually a few minutes: only the changes are planned." : "Usually 5 to 15 minutes for a large project."} You can leave this page; the work continues, and this page links to the plan when it is ready.</p>
        {stuck && <p className="banner banner-warn small" data-testid="no-worker">No worker has picked this up after {Math.round((Date.now() - new Date(r.created_at).getTime()) / 60000)} minutes. Check that the VX worker on your computer is running.</p>}
        <AutoRefresh intervalMs={5000} />
      </div>
    );
  }
  // Only recent outcomes are shown: older ones are in the plan list.
  if (!r.completed_at || Date.now() - new Date(r.completed_at).getTime() > 24 * 3600_000) return null;
  if (r.status === "failed") return <p className="banner banner-error" data-testid="plan-request" data-status="failed">{revise ? `Updating plan v${revise}` : "Plan generation"} failed: {r.error}</p>;
  const v = (r.plans as unknown as { version: number } | null)?.version;
  return <p className="banner banner-notice" data-testid="plan-request" data-status="done">{revise ? `Plan v${revise} was updated` : "The plan is ready"}{v ? ` as v${v}` : ""}:{" "}
    <Link href={`/projects/${projectId}/plans/${r.plan_id}`}>open it</Link>.</p>;
}
