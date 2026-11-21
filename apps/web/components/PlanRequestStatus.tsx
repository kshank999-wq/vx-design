import Link from "next/link";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AutoRefresh } from "@/components/AutoRefresh";

/** The latest worker-made plan: in progress (the page refreshes itself), failed (with the reason), or just finished. */
export async function PlanRequestStatus({ supabase, projectId }: { supabase: SupabaseClient; projectId: string }) {
  const { data: r } = await supabase.from("plan_requests").select("id, status, requirements, error, plan_id, created_at, completed_at")
    .eq("project_id", projectId).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (!r) return null;
  const since = (t: string) => `${Math.max(1, Math.round((Date.now() - new Date(t).getTime()) / 60000))} min`;
  if (r.status === "queued" || r.status === "running") {
    return <p className="banner banner-notice" data-testid="plan-request" data-status={r.status}>
      {r.status === "queued" ? `Waiting for a worker to plan ${r.requirements} requirements…` : `A worker is planning ${r.requirements} requirements (${since(r.created_at)} so far; usually 5 to 15 minutes).`}
      {" "}<AutoRefresh intervalMs={5000} /></p>;
  }
  // Only recent outcomes are shown: older ones are in the plan list.
  if (!r.completed_at || Date.now() - new Date(r.completed_at).getTime() > 24 * 3600_000) return null;
  if (r.status === "failed") return <p className="banner banner-error" data-testid="plan-request" data-status="failed">Plan generation failed: {r.error}</p>;
  return <p className="banner banner-notice" data-testid="plan-request" data-status="done">The plan from {r.requirements} requirements is ready:{" "}
    <Link href={`/projects/${projectId}/plans/${r.plan_id}`}>open it</Link>.</p>;
}
