"use client";
/** Opens the browser's print dialog (the page has print styles: a clean, dated checklist). */
export function PrintButton({ label = "🖨 Print checklist" }: { label?: string }) {
  return <button type="button" className="btn btn-secondary no-print" onClick={() => window.print()}>{label}</button>;
}
