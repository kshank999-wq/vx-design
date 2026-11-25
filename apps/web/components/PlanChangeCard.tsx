import Link from "next/link";
import { SubmitButton } from "@/components/SubmitButton";
import { carryOnAfterChat, declinePlanChange, draftPlanChange } from "@/app/projects/[projectId]/workspace/actions";
import type { ProposalState } from "@/lib/plan-proposals";

interface Change { action: string; task_key: string | null; title: string; description?: string }
export interface ChangeData {
  suggested_plan_change?: Change | null; more_plan_changes?: Change[]; discrepancies?: string[]; new_information?: boolean; paused_runs?: string[];
}

function describe(c: Change): string {
  return c.action === "add_task" ? `Add "${c.title}"` : c.action === "remove_task" ? `Remove ${c.task_key} ("${c.title}")` : `Change ${c.task_key} ("${c.title}")`;
}

/**
 * A plan change the design agent proposed: the differences it found, the changes, and where the decision stands. The state
 * comes from the database (see lib/plan-proposals), so it reads the same in the workspace, on the run page, in the corner
 * chat and on the questions page. Only open proposals have buttons; out-of-date and declined ones shrink to one line.
 */
export function PlanChangeCard({ projectId, messageId, data, state, canDraft }: {
  projectId: string; messageId: number; data: ChangeData; state?: ProposalState | null; canDraft: boolean;
}) {
  const changes = [data.suggested_plan_change, ...(data.more_plan_changes ?? [])].filter((c): c is Change => !!c);
  const diffs = data.discrepancies ?? [];
  if (!changes.length && !diffs.length) return null;
  const s = state ?? { state: "open" as const };
  const plan = s.planId ? `/projects/${projectId}/plans/${s.planId}` : null;
  if (s.state === "outdated" || s.state === "declined") {
    return (
      <p className="plan-change-closed small muted" data-testid="plan-change-closed">
        Proposed plan update ({changes.map(describe).join("; ") || `${diffs.length} difference(s)`}):{" "}
        {s.state === "declined" ? "declined, not needed." : <>out of date: {s.note}.</>}
        {s.state === "outdated" && plan && <> <Link href={plan}>See v{s.planVersion}</Link></>}
      </p>
    );
  }
  const approved = s.state === "drafted" && s.planStatus && ["approved", "superseded"].includes(s.planStatus);
  return (
    <div className={`plan-change-card${approved ? " plan-change-done" : ""}`} data-testid="plan-change">
      {diffs.length > 0 && (<><strong>Differences found</strong><ul>{diffs.map((d, i) => <li key={i}>{d}</li>)}</ul></>)}
      {changes.length > 0 && (<><strong>Proposed plan update</strong><ul>{changes.map((c, i) => <li key={i}>{describe(c)}</li>)}</ul></>)}
      {s.state === "drafted" && plan && !canDraft ? (
        <p className="small muted">{approved ? `✓ Approved in plan v${s.planVersion}.` : `Drafted as plan v${s.planVersion}. The project owner or an engineer decides.`}</p>
      ) : s.state === "drafted" && plan ? (
        <p className="small">{approved
          ? <>✓ Approved in <Link href={plan}>plan v{s.planVersion}</Link>.</>
          : <><Link href={plan}>Drafted as plan v{s.planVersion} ({s.planStatus === "awaiting_approval" ? "waiting for approval" : "draft"}): review and approve it →</Link></>}</p>
      ) : canDraft ? (
        <>
          {(data.paused_runs ?? []).length > 0 && <p className="small"><strong>The work is paused</strong> until you decide.</p>}
          <div className="row tight wrap">
            {changes.length > 0 && <form action={draftPlanChange.bind(null, projectId, messageId)}><SubmitButton pendingText="Drafting…">✓ Yes, update the plan</SubmitButton></form>}
            {(data.paused_runs ?? []).length > 0
              ? <form action={carryOnAfterChat.bind(null, projectId, messageId)}><SubmitButton variant="secondary" pendingText="Resuming…">No, carry on</SubmitButton></form>
              : <form action={declinePlanChange.bind(null, projectId, messageId)}><SubmitButton variant="secondary" pendingText="Saving…">Not needed</SubmitButton></form>}
          </div>
          <p className="small muted">"Yes" makes a new draft plan version for you to review; nothing changes until you approve it.</p>
        </>
      ) : <p className="small muted">The project owner or an engineer decides.</p>}
    </div>
  );
}
