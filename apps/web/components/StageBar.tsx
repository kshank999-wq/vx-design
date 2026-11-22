import Link from "next/link";
import type { SupabaseClient } from "@supabase/supabase-js";
import { STAGES, type StageRow } from "@/lib/stages";

const SHORT: Record<string, string> = { S0: "Intake", S1: "Concept", S2: "Architecture", S3: "Detailed design", S4: "Sourcing",
  S5: "Prototype", S6: "Validation", S7: "Production", S8: "Lifecycle" };

/** The S0–S8 strip: signed off, in progress, open or locked; each links to the stage gates. */
export async function StageBar({ supabase, projectId }: { supabase: SupabaseClient; projectId: string }) {
  const [{ data }, { data: project }] = await Promise.all([
    supabase.rpc("stage_status", { p_project: projectId }),
    supabase.from("projects").select("stage_gates").eq("id", projectId).maybeSingle(),
  ]);
  const rows = new Map(((data ?? []) as StageRow[]).map((r) => [r.stage, r]));
  // Gates off: the plan runs straight through, so "where we are" is where the work is, not the last sign-off.
  let working: string | null = null;
  if (project && project.stage_gates === false) {
    const { data: plan } = await supabase.from("plans").select("id").eq("project_id", projectId).eq("status", "approved").order("version", { ascending: false }).limit(1).maybeSingle();
    const { data: tasks } = plan ? await supabase.from("tasks").select("stage, status").eq("plan_id", plan.id) : { data: [] };
    const busy = (tasks ?? []).find((t) => ["running", "validating", "awaiting_approval"].includes(t.status));
    working = busy?.stage ?? STAGES.find((st) => (tasks ?? []).some((t) => t.stage === st && !["complete", "canceled", "superseded"].includes(t.status))) ?? null;
    for (const st of STAGES) {
      const r = rows.get(st);
      if (r) rows.set(st, { ...r, current: st === working, unlocked: true });
    }
  }
  return (
    <nav className="stage-bar" aria-label="Product stages" data-testid="stage-bar">
      {STAGES.map((s) => {
        const r = rows.get(s);
        const allDone = !!r && r.tasks_total > 0 && r.tasks_done === r.tasks_total;
        const before = working != null && STAGES.indexOf(s) < STAGES.indexOf(working as never);
        const state = r?.status === "signed_off" || (working != null && allDone) ? "done" : r?.current ? "active" : working != null && before ? "passed" : r?.unlocked ? "open" : "locked";
        const label = state === "done" ? (r?.status === "signed_off" ? "Signed off" : "Done") : state === "passed" ? "Not signed off" : state === "active" ? `In progress${r && r.tasks_total ? ` · ${r.tasks_done}/${r.tasks_total}` : ""}` : state === "open" ? "Open" : "Locked";
        return (
          <Link key={s} href={`/projects/${projectId}/stages`} className={`stage stage-${state}`} aria-current={state === "active" ? "step" : undefined}>
            <span className="stage-code">{s}</span>
            <span><span className="stage-name">{SHORT[s]}</span><small>{label}</small></span>
          </Link>
        );
      })}
    </nav>
  );
}
