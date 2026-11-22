import type { PlanChanges } from "@vx/planning";
import { SubmitButton } from "@/components/SubmitButton";

/**
 * What has been added or changed since the latest plan, with a button to work it into that plan (only the changes are
 * planned) and a secondary one to plan again from scratch. Hidden while a plan is being made.
 */
export function PlanChangesNotice({ changes, action, fresh, canEdit, building }: {
  changes: PlanChanges | null; action?: () => Promise<void>; fresh?: () => Promise<void>; canEdit: boolean; building?: boolean;
}) {
  if (!changes?.items.length || building) return null;
  return (
    <div className="card notice-changes" data-testid="plan-changes">
      <strong>New since plan v{changes.version}</strong>
      <span className="muted small"> (made {new Date(changes.since).toLocaleString()})</span>
      <ul className="small">{changes.items.map((x) => <li key={x}>{x}</li>)}</ul>
      {canEdit && action ? (
        <div className="row">
          <form action={action}>
            <SubmitButton pendingText="Starting…">Update plan v{changes.version} with these changes</SubmitButton>
          </form>
          {fresh && <form action={fresh}><SubmitButton variant="secondary" pendingText="Starting…">Rebuild from scratch</SubmitButton></form>}
          <span className="small muted">Updating reworks only what these changes affect and keeps the rest.</span>
        </div>
      ) : <p className="small muted">An engineer can update the plan to take these in.</p>}
    </div>
  );
}
