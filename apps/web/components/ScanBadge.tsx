/** Virus-scan state of an uploaded file (G6). */
export function ScanBadge({ status, signature }: { status?: string | null; signature?: string | null }) {
  if (status === "clean") return <span className="pill pill-complete" title="Scanned by ClamAV">scanned clean</span>;
  if (status === "infected") return <span className="pill pill-failed" data-testid="infected" title={signature ?? ""}>infected: blocked{signature ? ` (${signature})` : ""}</span>;
  if (status === "error") return <span className="pill pill-awaiting_approval">scan failed</span>;
  return <span className="pill" title="No scan result yet (or no scanner configured)">not scanned</span>;
}
