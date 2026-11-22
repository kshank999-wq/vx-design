import { fmtEstimate, type Estimate } from "@/lib/cost-estimate";

/** The likely AI cost of the action next to it, and what the figure is based on. */
export function CostHint({ e, what }: { e: Estimate | null | undefined; what?: string }) {
  if (!e) return null;
  return <span className="small muted cost-hint" data-testid="cost-hint" title={`Estimate ${e.basis}; the actual cost appears on the AI usage page.`}>
    {what ? `${what}: ` : ""}{fmtEstimate(e)} <span className="cost-basis">({e.basis})</span></span>;
}
