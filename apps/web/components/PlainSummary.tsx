import Link from "next/link";
import type { ReactNode } from "react";

/**
 * What a finished step did, in everyday language, with the technical record one click away: either a link to the
 * full result (`href`) or the details folded underneath (`children`).
 */
export function PlainSummary({ text, href, children, label = "See the full technical explanation" }: {
  text: string | null | undefined; href?: string | null; children?: ReactNode; label?: string;
}) {
  if (!text && !children) return null;
  return (
    <div className="plain-summary" data-testid="plain-summary">
      {text ? <p>{text}</p> : <p className="muted">No plain-language summary for this step yet.</p>}
      {children ? (
        <details className="plain-more"><summary>{label}</summary>{children}{href && <p><Link href={href}>Open the full result</Link></p>}</details>
      ) : href ? <Link className="plain-more-link" href={href}>{label} →</Link> : null}
    </div>
  );
}
