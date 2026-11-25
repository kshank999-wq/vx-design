import type { SupabaseClient } from "@supabase/supabase-js";
import { PlanChangeCard, type ChangeData } from "@/components/PlanChangeCard";
import { ReadMore } from "@/components/ReadMore";
import { hasProposal, proposalStates } from "@/lib/plan-proposals";

/**
 * "Proposed plan updates": every plan change the design agent proposed that still needs a decision (open), or was
 * drafted but not approved yet, in one place. Shown in the workspace and on the questions page; out-of-date and
 * declined proposals are left out (the chat keeps a one-line note).
 */
export async function PlanProposals({ supabase, projectId, canDraft }: { supabase: SupabaseClient; projectId: string; canDraft: boolean }) {
  const { data: msgs } = await supabase.from("project_messages").select("id, author_kind, body, data, created_at")
    .eq("project_id", projectId).eq("author_kind", "assistant").order("id", { ascending: false }).limit(200);
  const withChanges = (msgs ?? []).filter((m) => hasProposal(m.data));
  const states = await proposalStates(supabase, projectId, withChanges);
  const pending = withChanges.filter((m) => {
    const s = states[String(m.id)];
    return s && (s.state === "open" || (s.state === "drafted" && !["approved", "superseded"].includes(s.planStatus ?? "")));
  });
  if (!pending.length) return null;
  return (
    <section className="card plan-proposals" data-testid="plan-proposals" id="plan-updates">
      <h2>Proposed plan updates <span className="muted small">({pending.length})</span></h2>
      <p className="small muted">Changes the design agent suggested from the chat or from comparing the plan with your concepts. Decide each one here or in the chat: the answer shows everywhere.</p>
      <ul className="list">{pending.map((m) => (
        <li key={m.id}>
          <div className="small muted">Suggested {new Date(m.created_at as string).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</div>
          <ReadMore text={m.body as string} lines={3} />
          <PlanChangeCard projectId={projectId} messageId={m.id as number} data={m.data as ChangeData} state={states[String(m.id)]} canDraft={canDraft} />
        </li>
      ))}</ul>
    </section>
  );
}
