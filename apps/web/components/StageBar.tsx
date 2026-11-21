import Link from "next/link";
import type { SupabaseClient } from "@supabase/supabase-js";
import { STAGES, type StageRow } from "@/lib/stages";

const SHORT: Record<string, string> = { S0: "Intake", S1: "Concept", S2: "Architecture", S3: "Detailed design", S4: "Sourcing",
  S5: "Prototype", S6: "Validation", S7: "Production", S8: "Lifecycle" };

/** The S0–S8 strip: signed off, in progress, open or locked; each links to the stage gates. */
export async function StageBar({ supabase, projectId }: { supabase: SupabaseClient; projectId: string }) {
  const { data } = await supabase.rpc("stage_status", { p_project: projectId });
  const rows = new Map(((data ?? []) as StageRow[]).map((r) => [r.stage, r]));
  return (
    <nav className="stage-bar" aria-label="Product stages" data-testid="stage-bar">
      {STAGES.map((s) => {
        const r = rows.get(s);
        const state = r?.status === "signed_off" ? "done" : r?.current ? "active" : r?.unlocked ? "open" : "locked";
        const label = state === "done" ? "Signed off" : state === "active" ? `In progress${r && r.tasks_total ? ` · ${r.tasks_done}/${r.tasks_total}` : ""}` : state === "open" ? "Open" : "Locked";
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
