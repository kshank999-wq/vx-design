import Link from "next/link";
import { SectionTabs } from "@/components/SectionTabs";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { RfqManifest, SHARING_SCOPE_LABEL } from "@vx/contracts";
import { AutoRefresh } from "@/components/AutoRefresh";
import { Banner } from "@/components/Banner";
import { SubmitButton } from "@/components/SubmitButton";
import { requireUser } from "@/lib/auth";
import { CATEGORY_LABEL, fmtMoney, MFR_STATUS, RECIPIENT_STATUS, RFQ_STATUS } from "@/lib/rfq";
import { addRecipient, approveDisclosure, buildPacket, cancelRfq, closeRfq, removeRecipient, revokeAccess, saveManifest, sendRfq,
         setAttachments, setNda } from "../actions";

interface PacketFile { name: string; sha256: string; size: number; source: string }
interface Quote { id: string; recipient_id: string; revision: number; currency: string; lines: { quantity: number; unit_price: number }[];
                  tooling_cost: number | null; shipping_cost: number | null; lead_time_days: number | null; valid_until: string | null;
                  notes: string | null; submitted_at: string }

export default async function RfqPage({ params, searchParams }: {
  params: Promise<{ projectId: string; rfqId: string }>; searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const { projectId, rfqId } = await params;
  const { error, notice } = await searchParams;
  const { supabase, userId } = await requireUser();
  const [{ data: rfq }, { data: me }, { data: project }] = await Promise.all([
    supabase.from("rfqs").select("*").eq("id", rfqId).eq("project_id", projectId).maybeSingle(),
    supabase.from("project_members").select("role").eq("project_id", projectId).eq("user_id", userId).maybeSingle(),
    supabase.from("projects").select("name").eq("id", projectId).maybeSingle(),
  ]);
  if (!rfq || !project) notFound();
  const [{ data: missing }, { data: attached }, { data: versions }, { data: reqs }, { data: recipients }, { data: mfrs }, { data: quotes }] = await Promise.all([
    supabase.rpc("rfq_missing", { p_rfq_id: rfqId }),
    supabase.from("rfq_attachments").select("artifact_version_id").eq("rfq_id", rfqId),
    supabase.from("artifact_versions").select("id, version, sha256, size_bytes, committed_at, artifacts(name, kind)").eq("project_id", projectId)
      .eq("status", "committed").order("committed_at", { ascending: false }).limit(200),
    supabase.from("requirements").select("ref_code, kind, priority, text").eq("project_id", projectId).neq("status", "rejected").order("ref_code"),
    supabase.from("rfq_recipients").select("*, manufacturers(display_name, status, nda_method), manufacturer_contacts(name, verification_source)")
      .eq("rfq_id", rfqId).order("created_at"),
    supabase.from("manufacturers").select("id, display_name, status, categories, manufacturer_contacts(id, name, email, email_status)")
      .in("status", ["verified", "approved"]).order("display_name"),
    supabase.from("rfq_quotes").select("*").eq("rfq_id", rfqId).order("revision", { ascending: false }),
  ]);
  const role = me?.role ?? "viewer";
  const canEdit = role === "owner" || role === "engineer";
  const isOwner = role === "owner";
  const editable = canEdit && ["draft", "ready", "approved"].includes(rfq.status);
  const m = RfqManifest.parse(rfq.manifest ?? {});
  const ref = `${m.project_code || "VX"}-RFQ-${String(rfq.rfq_no).padStart(3, "0")}`;
  const chosen = new Set((attached ?? []).map((a) => a.artifact_version_id));
  const files = (rfq.packet_files ?? []) as PacketFile[];
  const recs = recipients ?? [];
  const latest = new Map<string, Quote>();
  for (const q of (quotes ?? []) as Quote[]) if (!latest.has(q.recipient_id)) latest.set(q.recipient_id, q);
  const qtys = [...new Set([...latest.values()].flatMap((q) => q.lines.map((l) => l.quantity)))].sort((a, b) => a - b);
  let packetUrl: string | null = null;
  if (rfq.packet_path) packetUrl = (await supabase.storage.from("project-files").createSignedUrl(rfq.packet_path, 600, { download: `${ref}.zip` })).data?.signedUrl ?? null;
  const h = await headers();
  const origin = `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host")}`;
  const onRfq = new Set(recs.map((r) => r.manufacturer_id));
  const contactOptions = (mfrs ?? []).filter((x) => !onRfq.has(x.id)).flatMap((x) =>
    ((x.manufacturer_contacts ?? []) as { id: string; name: string; email: string | null; email_status: string }[])
      .map((c) => ({ ...c, mfr: x.display_name, match: (x.categories as string[]).includes(rfq.category) })))
    .sort((a, b) => Number(b.match) - Number(a.match));

  return (
    <main>
      <p className="crumbs"><Link href="/projects">Projects</Link> / <Link href={`/projects/${projectId}`}>{project.name}</Link> / <Link href={`/projects/${projectId}/rfqs`}>RFQs</Link> /</p>
      <div className="row spread">
        <h1>{ref}: {rfq.title}</h1>
        {rfq.status === "packaging" && <AutoRefresh intervalMs={2000} />}
      </div>
      <p><span className={`pill big pill-rfq-${rfq.status}`} data-testid="rfq-status">{RFQ_STATUS[rfq.status]}</span>
        <span className="pill">{CATEGORY_LABEL[rfq.category as keyof typeof CATEGORY_LABEL]}</span>
        <span className="pill">{SHARING_SCOPE_LABEL[rfq.sharing_scope as keyof typeof SHARING_SCOPE_LABEL]}</span></p>
      <Banner error={error} notice={notice} />
      {rfq.packet_error && <p className="banner banner-error">The packet could not be built: {rfq.packet_error}</p>}

      <SectionTabs id="rfq" initial={rfq.status === "draft" ? "suppliers" : ["ready", "packaging", "approved"].includes(rfq.status) ? "packet" : "quotes"} sections={[
        { key: "manifest", label: "1. Manifest", content: (<>
      {/* 1. Manifest */}
      <details className="card" open>
        <summary><strong>1. Manifest</strong> {(missing as string[] | null)?.length
          ? <span className="small warn-text" data-testid="missing">Missing: {(missing as string[]).join(", ")}</span>
          : <span className="small">complete</span>}</summary>
        <form action={saveManifest.bind(null, projectId, rfqId)} className="stack">
          <fieldset disabled={!editable} className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
            <div className="grid2">
              <label>Title<input name="title" defaultValue={rfq.title} /></label>
              <label>Project code (what suppliers see instead of the project name)<input name="project_code" defaultValue={m.project_code} placeholder="SLATE" /></label>
              <label>Buyer company<input name="buyer_company" defaultValue={m.buyer.company} /></label>
              <label>Buyer contact<input name="buyer_contact" defaultValue={m.buyer.contact_name ?? ""} /></label>
              <label>Classification<input name="classification" defaultValue={m.classification} placeholder="Prototype PCB assembly, 4-layer" /></label>
              <label>Drawing revision<input name="drawing_revision" defaultValue={m.drawing_revision ?? ""} placeholder="A" /></label>
              <label>Prototype quantity<input name="qty_prototype" type="number" min="0" defaultValue={m.quantities.prototype} /></label>
              <label>Production quantity<input name="qty_production" type="number" min="0" defaultValue={m.quantities.production ?? ""} /></label>
              <label>Annual forecast (not a commitment)<input name="qty_forecast" type="number" min="0" defaultValue={m.quantities.forecast_annual ?? ""} /></label>
              <label>Response deadline<input name="response_deadline" type="date" defaultValue={rfq.response_deadline ?? ""} /></label>
              <label>Shipping terms (Incoterm and place)<input name="shipping_terms" defaultValue={m.shipping_terms} placeholder="DAP, London" /></label>
              <label>Tooling ownership<select name="tooling_ownership" defaultValue={m.tooling_ownership}>
                <option value="buyer">Buyer owns tooling</option><option value="supplier">Supplier owns tooling</option>
                <option value="not_applicable">Not applicable</option></select></label>
              <label>Materials (one per line)<textarea name="materials" rows={2} defaultValue={m.materials.join("\n")} /></label>
              <label>Finish<input name="finish" defaultValue={m.finish ?? ""} /></label>
              <label>Critical-to-quality dimensions (feature | nominal | tolerance)<textarea name="ctq" rows={2}
                defaultValue={m.ctq_dimensions.map((d) => `${d.feature} | ${d.nominal} | ${d.tolerance}`).join("\n")} /></label>
              <label>Standards (one per line)<textarea name="standards" rows={2} defaultValue={m.standards.join("\n")} placeholder="IPC-A-610 Class 2" /></label>
              <label>Compliance<input name="compliance" defaultValue={m.compliance ?? ""} placeholder="RoHS" /></label>
              <label>Tests and inspection<input name="tests_inspection" defaultValue={m.tests_inspection ?? ""} placeholder="AOI; flying probe" /></label>
              <label>Quote breakdown (one per line)<textarea name="quote_breakdown" rows={3} defaultValue={m.quote_breakdown.join("\n")} /></label>
              <label>Sharing scope<select name="sharing_scope" defaultValue={rfq.sharing_scope}>
                {Object.entries(SHARING_SCOPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
            </div>
            <label>Notes for suppliers<textarea name="notes" rows={2} defaultValue={m.notes ?? ""} /></label>
            <fieldset className="licenses">
              <legend className="small muted">Requirements to disclose (none are shared unless ticked)</legend>
              {(reqs ?? []).map((r) => (
                <label key={r.ref_code} className="radio"><input type="checkbox" name="requirement_refs" value={r.ref_code} defaultChecked={m.requirement_refs.includes(r.ref_code)} />
                  <span><strong>{r.ref_code}</strong> {r.text}</span></label>
              ))}
              {!reqs?.length && <span className="small muted">This project has no requirements.</span>}
            </fieldset>
            {editable && <div><SubmitButton pendingText="Saving…">Save manifest</SubmitButton></div>}
          </fieldset>
        </form>
      </details>

        </>) },
        { key: "files", label: "2. Files", content: (<>
      {/* 2. Files */}
      <details className="card" open>
        <summary><strong>2. Files to disclose</strong> <span className="small">{chosen.size} chosen</span></summary>
        <p className="small muted">Only approved (committed) files can be attached. Nothing else from the project is shared.</p>
        <form action={setAttachments.bind(null, projectId, rfqId)} className="stack">
          <fieldset disabled={!editable} className="licenses">
            {(versions ?? []).map((v) => {
              const a = v.artifacts as unknown as { name: string; kind: string };
              return (
                <label key={v.id} className="radio"><input type="checkbox" name="version_ids" value={v.id} defaultChecked={chosen.has(v.id)} />
                  <span>{a.name} v{v.version} <span className="muted small">({a.kind}, sha256 {v.sha256.slice(0, 12)})</span></span></label>
              );
            })}
            {!versions?.length && <span className="small muted">No approved files yet.</span>}
          </fieldset>
          {editable && <div><SubmitButton variant="secondary" pendingText="Saving…">Save files</SubmitButton></div>}
        </form>
      </details>

        </>) },
        { key: "suppliers", label: "3. Suppliers", content: (<>
      {/* 3. Suppliers (the internal contact sheet) */}
      <section className="card">
        <h2 style={{ marginTop: 0 }}>3. Suppliers</h2>
        <p className="small muted">The contact sheet stays here: suppliers never see each other. Only verified suppliers with a confirmed email can be added.</p>
        <table data-testid="recipients">
          <thead><tr><th>Supplier</th><th>Contact</th><th>NDA</th><th>Access</th><th></th></tr></thead>
          <tbody>
            {recs.map((r) => {
              const mf = r.manufacturers as unknown as { display_name: string; status: string; nda_method: string };
              const c = r.manufacturer_contacts as unknown as { name: string; verification_source: string | null };
              return (
                <tr key={r.id} data-name={mf.display_name}>
                  <td>{mf.display_name} <span className="pill">{MFR_STATUS[mf.status]}</span></td>
                  <td className="small">{c.name}<br />{r.email}<div className="muted">confirmed: {c.verification_source ?? "—"}</div></td>
                  <td className="small"><span className={`pill pill-nda-${r.nda_status}`}>{r.nda_status.replace("_", " ")}</span>{r.nda_note && <div className="muted">{r.nda_note}</div>}
                    {isOwner && !["sent", "closed", "canceled"].includes(rfq.status) && (
                      <form action={setNda.bind(null, projectId, rfqId, r.id)} className="row tight">
                        <select name="nda_status" defaultValue={r.nda_status} aria-label={`NDA status for ${mf.display_name}`}>
                          <option value="pending">pending</option><option value="signed">signed</option><option value="not_required">not required</option></select>
                        <input name="nda_note" placeholder="Which NDA, when signed" aria-label={`NDA note for ${mf.display_name}`} />
                        <SubmitButton variant="secondary" pendingText="…">Record</SubmitButton>
                      </form>)}</td>
                  <td className="small"><span className={`pill pill-rec-${r.status}`} data-testid="recipient-status">{RECIPIENT_STATUS[r.status]}</span>
                    {r.access_expires_at && <div className="muted">until {new Date(r.access_expires_at).toLocaleString()}</div>}
                    {r.decline_reason && <div className="muted">“{r.decline_reason}”</div>}</td>
                  <td>{editable && <form action={removeRecipient.bind(null, projectId, rfqId, r.id)}><button className="btn btn-link" type="submit">Remove</button></form>}
                    {isOwner && rfq.status === "sent" && r.status !== "revoked" && (
                      <form action={revokeAccess.bind(null, projectId, rfqId, r.id)}><button className="btn btn-link" type="submit">Revoke access</button></form>)}</td>
                </tr>
              );
            })}
            {!recs.length && <tr><td colSpan={5} className="muted">No suppliers yet.</td></tr>}
          </tbody>
        </table>
        {editable && (
          <form action={addRecipient.bind(null, projectId, rfqId)} className="row" style={{ marginTop: 10 }}>
            <select name="contact_id" required aria-label="Supplier contact" defaultValue="">
              <option value="" disabled>Choose a supplier contact…</option>
              {contactOptions.map((c) => (
                <option key={c.id} value={c.id} disabled={c.email_status !== "verified"}>
                  {c.mfr}: {c.name} {c.email_status === "verified" ? `<${c.email}>` : "(verify contact)"}{c.match ? "" : " (other category)"}
                </option>
              ))}
            </select>
            <SubmitButton variant="secondary" pendingText="Adding…">Add supplier</SubmitButton>
            <Link href="/suppliers" className="small">Directory</Link>
          </form>
        )}
      </section>

        </>) },
        { key: "packet", label: "4. Packet", content: (<>
      {/* 4. Packet and approval */}
      <section className="card stack" data-testid="packet">
        <h2 style={{ marginTop: 0 }}>4. Packet and approval</h2>
        {rfq.packet_sha256 ? (
          <>
            <p className="small">Packet sha256 <code data-testid="packet-sha">{rfq.packet_sha256}</code>
              {packetUrl && <> · <a href={packetUrl}>Download {ref}.zip</a></>}</p>
            <table className="small"><thead><tr><th>File</th><th>Size</th><th>sha256</th><th>From</th></tr></thead>
              <tbody>{files.map((f) => <tr key={f.name}><td>{f.name}</td><td>{f.size.toLocaleString()} B</td><td><code>{f.sha256.slice(0, 16)}</code></td><td>{f.source}</td></tr>)}</tbody></table>
          </>
        ) : <p className="small muted">{rfq.status === "packaging" ? "A worker is building the packet…" : "No packet yet."}</p>}
        {canEdit && ["draft", "ready"].includes(rfq.status) && (
          <form action={buildPacket.bind(null, projectId, rfqId)}>
            <SubmitButton variant={rfq.status === "ready" ? "secondary" : "primary"} pendingText="Requesting…"
              disabled={!!(missing as string[] | null)?.length}>{rfq.status === "ready" ? "Rebuild packet" : "Build packet"}</SubmitButton>
          </form>
        )}
        {rfq.status === "ready" && (isOwner ? (
          <form action={approveDisclosure.bind(null, projectId, rfqId)} className="approval-stop stack">
            <div className="small"><strong>Owner approval.</strong> You are approving disclosure of exactly this packet ({files.length} files,
              sha256 {rfq.packet_sha256?.slice(0, 12)}…) to {recs.length} supplier(s): {recs.map((r) => (r.manufacturers as unknown as { display_name: string }).display_name).join(", ")}.
              It is recorded in the audit log. Any later change needs a new approval.</div>
            <input name="note" placeholder="Note (optional)" aria-label="Approval note" />
            <div><SubmitButton pendingText="Approving…">Approve disclosure</SubmitButton></div>
          </form>
        ) : <p className="small warn-text">Waiting for the project owner to approve the disclosure.</p>)}
        {rfq.approved_at && <p className="small">Approved {new Date(rfq.approved_at).toLocaleString()}{rfq.approval_note ? `: ${rfq.approval_note}` : ""}</p>}
        {rfq.status === "approved" && isOwner && (
          <form action={sendRfq.bind(null, projectId, rfqId)} className="row">
            <label className="inline">Access window (days)<input name="window_days" type="number" min="1" max="90" defaultValue="21" style={{ width: 80 }} /></label>
            <SubmitButton pendingText="Releasing…">Release to suppliers</SubmitButton>
          </form>
        )}
      </section>

        </>) },
        ...(rfq.status === "sent" ? [{ key: "emails", label: "5. Emails", content: (<>
      {/* 5. Emails (VX Design does not send email) */}
      {rfq.status === "sent" && (
        <section className="card" data-testid="emails">
          <h2 style={{ marginTop: 0 }}>5. Emails to send</h2>
          <p className="small muted">VX Design does not send email. Send each supplier its message from your own mailbox; they sign in to the supplier portal with
            the same address to download the packet and quote.</p>
          {recs.filter((r) => r.status !== "revoked").map((r) => {
            const c = r.manufacturer_contacts as unknown as { name: string };
            const subject = `${ref}: request for quotation, ${rfq.title}`;
            const body = [`Dear ${c.name},`, "",
              `${m.buyer.company} would like your quotation for ${m.classification || rfq.title}. Quotes are due by ${rfq.response_deadline}.`, "",
              `The RFQ packet (sha256 ${rfq.packet_sha256}) is in our supplier portal:`, `${origin}/supplier`, "",
              `Sign in or create an account with this email address (${r.email}). Your access is open until ${new Date(r.access_expires_at!).toUTCString()}.`,
              "You can quote, revise your quote, or decline there.", "", "Thank you,", m.buyer.contact_name ?? m.buyer.company].join("\n");
            return (
              <details key={r.id} className="small">
                <summary>{(r.manufacturers as unknown as { display_name: string }).display_name}: {r.email} · <a href={`mailto:${r.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`}>Open in your email app</a></summary>
                <pre className="pre" data-testid="email-draft">{`Subject: ${subject}\n\n${body}`}</pre>
              </details>
            );
          })}
        </section>
      )}

        </>) }] : []),
        ...(["sent", "closed"].includes(rfq.status) ? [{ key: "quotes", label: "6. Quotes", content: (<>
      {/* 6. Quotes */}
      {["sent", "closed"].includes(rfq.status) && (
        <section className="card" data-testid="quotes">
          <h2 style={{ marginTop: 0 }}>6. Quotes</h2>
          {latest.size ? (
            <table className="small">
              <thead><tr><th>Supplier</th>{qtys.map((q) => <th key={q}>Unit @ {q}</th>)}<th>Tooling / NRE</th><th>Shipping</th><th>Lead time</th><th>Valid until</th><th></th></tr></thead>
              <tbody>
                {recs.filter((r) => latest.has(r.id)).map((r) => {
                  const q = latest.get(r.id)!;
                  const name = (r.manufacturers as unknown as { display_name: string }).display_name;
                  return (
                    <tr key={r.id} data-name={name} className={rfq.awarded_quote_id === q.id ? "chosen" : undefined}>
                      <td>{name} <span className="muted">rev {q.revision}</span>{rfq.awarded_quote_id === q.id && <span className="pill pill-complete">chosen</span>}
                        {q.notes && <div className="muted">{q.notes}</div>}</td>
                      {qtys.map((n) => <td key={n}>{fmtMoney(q.lines.find((l) => l.quantity === n)?.unit_price, q.currency)}</td>)}
                      <td>{fmtMoney(q.tooling_cost, q.currency)}</td><td>{fmtMoney(q.shipping_cost, q.currency)}</td>
                      <td>{q.lead_time_days != null ? `${q.lead_time_days} days` : "—"}</td><td>{q.valid_until ?? "—"}</td>
                      <td>{isOwner && rfq.status === "sent" && (
                        <form action={closeRfq.bind(null, projectId, rfqId, q.id)} className="stack">
                          <input name="note" placeholder="Why this supplier" aria-label={`Why choose ${name}`} />
                          <SubmitButton pendingText="…">Choose this quote</SubmitButton></form>)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : <p className="small muted">No quotes yet.</p>}
          <p className="small muted">Currencies are as quoted; they are not converted. Choosing a quote records a decision; the purchase order is placed outside VX Design.</p>
          {isOwner && rfq.status === "sent" && (
            <form action={closeRfq.bind(null, projectId, rfqId, null)} className="row">
              <input name="note" placeholder="Reason" aria-label="Reason for closing" />
              <SubmitButton variant="secondary" pendingText="Closing…">Close without choosing</SubmitButton>
            </form>
          )}
          {rfq.status === "closed" && <p className="small">Closed {new Date(rfq.closed_at!).toLocaleString()}{rfq.close_note ? `: ${rfq.close_note}` : ""}</p>}
        </section>
      )}

        </>) }] : []),
      ]} />

      {canEdit && ["draft", "ready", "approved"].includes(rfq.status) && (
        <form action={cancelRfq.bind(null, projectId, rfqId)}><button className="btn btn-link" type="submit">Cancel this RFQ</button></form>
      )}
    </main>
  );
}
