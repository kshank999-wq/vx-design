import Link from "next/link";
import { SubmitButton } from "@/components/SubmitButton";
import { carryOnAfterChat, draftPlanChange } from "@/app/projects/[projectId]/workspace/actions";

interface Change { action: string; task_key: string | null; title: string; description?: string }
export interface ChangeData {
  suggested_plan_change?: Change | null; more_plan_changes?: Change[]; discrepancies?: string[]; new_information?: boolean; paused_runs?: string[];
}

function describe(c: Change): string {
  return c.action === "add_task" ? `Add "${c.title}"` : c.action === "remove_task" ? `Remove ${c.task_key} ("${c.title}")` : `Change ${c.task_key} ("${c.title}")`;
}

/**
 * Under an agent message that brought new information: the differences it found (against the plan, the concept look and the
 * mock-ups), the plan changes it proposes, and the decision: "Yes, update the plan" drafts a new plan version for review;
 * "No, carry on" resumes the work it paused. Used in the workspace, on the run page and in the corner chat.
 */
export function PlanChangeCard({ projectId, messageId, data, draftedPlanId, canDraft }: {
  projectId: string; messageId: number; data: ChangeData; draftedPlanId?: string | null; canDraft: boolean;
}) {
  const changes = [data.suggested_plan_change, ...(data.more_plan_changes ?? [])].filter((c): c is Change => !!c);
  const diffs = data.discrepancies ?? [];
  if (!changes.length && !diffs.length) return null;
  return (
    <div className="plan-change-card" data-testid="plan-change">
      {diffs.length > 0 && (<><strong>Differences found</strong><ul>{diffs.map((d, i) => <li key={i}>{d}</li>)}</ul></>)}
      {changes.length > 0 && (<><strong>Proposed plan update</strong><ul>{changes.map((c, i) => <li key={i}>{describe(c)}</li>)}</ul></>)}
      {(data.paused_runs ?? []).length > 0 && !draftedPlanId && <p className="small"><strong>The work is paused</strong> until you decide.</p>}
      {draftedPlanId ? <p className="small"><Link href={`/projects/${projectId}/plans/${draftedPlanId}`}>Drafted as a new plan version: review and approve it →</Link></p>
        : canDraft ? (
          <div className="row tight wrap">
            {changes.length > 0 && <form action={draftPlanChange.bind(null, projectId, messageId)}><SubmitButton pendingText="Drafting…">✓ Yes, update the plan</SubmitButton></form>}
            {(data.paused_runs ?? []).length > 0 && <form action={carryOnAfterChat.bind(null, projectId, messageId)}><SubmitButton variant="secondary" pendingText="Resuming…">No, carry on</SubmitButton></form>}
          </div>)
        : <p className="small muted">The project owner or an engineer decides.</p>}
    </div>
  );
}
