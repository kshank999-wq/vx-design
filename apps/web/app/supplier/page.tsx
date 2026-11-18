import { RfqManifest, SHARING_SCOPE_LABEL } from "@vx/contracts";
import { Banner } from "@/components/Banner";
import { SubmitButton } from "@/components/SubmitButton";
import { requireUser } from "@/lib/auth";
import { CATEGORY_LABEL, fmtMoney, RECIPIENT_STATUS } from "@/lib/rfq";
import { declineRfq, submitQuote } from "./actions";

interface Row {
  recipient_id: string; rfq_ref: string; title: string; category: string; manifest: unknown; sharing_scope: string;
  response_deadline: string; status: string; rfq_status: string; access_expires_at: string; window_open: boolean;
  packet_sha256: string; packet_files: { name: string; sha256: string; size: number }[]; manufacturer: string;
  my_quotes: { revision: number; currency: string; lines: { quantity: number; unit_price: number }[]; tooling_cost: number | null;
               shipping_cost: number | null; lead_time_days: number | null; valid_until: string | null; notes: string | null; submitted_at: string }[];
}

/** Supplier portal: the RFQs released to the signed-in (confirmed) email address, and nothing else. */
export default async function SupplierPortal({ searchParams }: { searchParams: Promise<{ error?: string; notice?: string }> }) {
  const { error, notice } = await searchParams;
  const { supabase, email } = await requireUser();
  const { data, error: e } = await supabase.rpc("supplier_rfqs");
  const rows = (data ?? []) as Row[];

  return (
    <main>
      <h1>Supplier portal</h1>
      <p className="muted">Requests for quotation sent to <strong>{email}</strong>. Each packet is confidential: download it only while your access is open,
        use it only to quote, and delete it if you decline. Opening a packet is recorded.</p>
      <Banner error={error ?? e?.message} notice={notice} />
      {rows.map((r) => {
        const m = RfqManifest.parse(r.manifest ?? {});
        const q = m.quantities;
        const last = r.my_quotes[0];
        const qtys = [...new Set([q.prototype, q.production, ...(last?.lines.map((l) => l.quantity) ?? [])].filter((n): n is number => !!n))].sort((a, b) => a - b);
        return (
          <section key={r.recipient_id} className="card stack" data-testid="supplier-rfq" data-ref={r.rfq_ref}>
            <div className="row spread">
              <h2 style={{ margin: 0 }}>{r.rfq_ref}: {r.title}</h2>
              <span className={`pill pill-rec-${r.status}`}>{r.window_open ? RECIPIENT_STATUS[r.status] : r.rfq_status === "closed" ? "RFQ closed" : "Access closed"}</span>
            </div>
            <dl className="facts">
              <dt>For</dt><dd>{r.manufacturer}</dd>
              <dt>From</dt><dd>{m.buyer.company}</dd>
              <dt>Category</dt><dd>{CATEGORY_LABEL[r.category as keyof typeof CATEGORY_LABEL]}</dd>
              <dt>Quantities</dt><dd>prototype {q.prototype}{q.production ? `, production ${q.production}` : ""}{q.forecast_annual ? `, forecast ${q.forecast_annual}/yr` : ""}</dd>
              <dt>Due</dt><dd>{r.response_deadline}</dd>
              <dt>Shipping</dt><dd>{m.shipping_terms}</dd>
              <dt>Scope</dt><dd>{SHARING_SCOPE_LABEL[r.sharing_scope as keyof typeof SHARING_SCOPE_LABEL]}</dd>
              <dt>Access until</dt><dd>{new Date(r.access_expires_at).toUTCString()}</dd>
            </dl>
            {r.window_open ? (
              <>
                <p className="row">
                  <a className="btn btn-primary" href={`/supplier/packet/${r.recipient_id}?ref=${encodeURIComponent(r.rfq_ref)}`}>Download packet ({r.packet_files.length} files)</a>
                  <span className="small muted">sha256 <code>{r.packet_sha256}</code> (each file is listed in SHA256SUMS inside)</span>
                </p>
                <details open={!last}>
                  <summary><strong>{last ? `Revise your quote (current: revision ${last.revision})` : "Submit a quote"}</strong></summary>
                  <form action={submitQuote.bind(null, r.recipient_id)} className="stack" data-testid="quote-form">
                    <div className="row">
                      <label>Currency<input name="currency" required maxLength={3} defaultValue={last?.currency ?? "USD"} style={{ width: 80 }} /></label>
                      <label>Tooling / NRE<input name="tooling_cost" type="number" step="0.01" min="0" defaultValue={last?.tooling_cost ?? ""} /></label>
                      <label>Shipping<input name="shipping_cost" type="number" step="0.01" min="0" defaultValue={last?.shipping_cost ?? ""} /></label>
                      <label>Lead time (days)<input name="lead_time_days" type="number" min="0" defaultValue={last?.lead_time_days ?? ""} /></label>
                      <label>Valid until<input name="valid_until" type="date" defaultValue={last?.valid_until ?? ""} /></label>
                    </div>
                    <table className="small"><thead><tr><th>Quantity</th><th>Unit price</th></tr></thead>
                      <tbody>{[...qtys, null].map((n, i) => (
                        <tr key={i}><td><input name="quantity" type="number" min="1" defaultValue={n ?? ""} aria-label={`Quantity ${i + 1}`} /></td>
                          <td><input name="unit_price" type="number" step="0.0001" min="0" defaultValue={last?.lines.find((l) => l.quantity === n)?.unit_price ?? ""}
                            aria-label={n ? `Unit price at ${n}` : "Unit price, extra quantity"} /></td></tr>))}</tbody></table>
                    <label>Notes (exceptions, suggestions)<textarea name="notes" rows={2} defaultValue={last?.notes ?? ""} /></label>
                    <div><SubmitButton pendingText="Submitting…">{last ? "Submit revision" : "Submit quote"}</SubmitButton></div>
                  </form>
                </details>
                {r.status !== "declined" && (
                  <details className="small"><summary>Decline</summary>
                    <form action={declineRfq.bind(null, r.recipient_id)} className="row">
                      <input name="reason" placeholder="Reason (optional)" aria-label="Reason for declining" />
                      <SubmitButton variant="danger" pendingText="…">Decline this RFQ</SubmitButton></form>
                  </details>
                )}
              </>
            ) : <p className="small muted">Access to this RFQ has closed.</p>}
            {!!r.my_quotes.length && (
              <p className="small">Your quotes: {r.my_quotes.map((x) => `rev ${x.revision} (${x.lines.map((l) => `${l.quantity} @ ${fmtMoney(l.unit_price, x.currency)}`).join(", ")})`).join("; ")}</p>
            )}
          </section>
        );
      })}
      {!rows.length && <p className="muted">No requests for quotation for this email address. If a buyer sent you one, sign in with the address it was sent to and
        confirm that address.</p>}
    </main>
  );
}
