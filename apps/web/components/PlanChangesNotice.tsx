import type { PlanChanges } from "@vx/planning";
import { SubmitButton } from "@/components/SubmitButton";

/**
 * What has been added or changed since the latest plan, with a button to regenerate it. The new plan is given the same
 * list and the old plan's tasks, so it revises the old plan to take them in.
 */
export function PlanChangesNotice({ changes, action, canEdit }: { changes: PlanChanges | null; action?: () => Promise<void>; canEdit: boolean }) {
  if (!changes?.items.length) return null;
  return (
    <div className="card notice-changes" data-testid="plan-changes">
      <strong>New since plan v{changes.version}</strong>
      <span className="muted small"> (made {new Date(changes.since).toLocaleString()})</span>
      <ul className="small">{changes.items.map((x) => <li key={x}>{x}</li>)}</ul>
      {canEdit && action ? (
        <form action={action}>
          <SubmitButton pendingText="Regenerating… (can take a few minutes)">Regenerate the plan with these changes</SubmitButton>
        </form>
      ) : <p className="small muted">An engineer can regenerate the plan to take these in.</p>}
    </div>
  );
}
