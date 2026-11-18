import Link from "next/link";
import { notFound } from "next/navigation";
import { Banner } from "@/components/Banner";
import { SubmitButton } from "@/components/SubmitButton";
import { requireUser } from "@/lib/auth";
import { CATEGORY_LABEL, MFR_STATUS, NDA_METHODS } from "@/lib/rfq";
import { ManufacturerFields } from "@/components/Suppliers";
import { ProcessRules } from "@/components/ProcessRules";
import { addContact, removeContact, setManufacturerStatus, updateManufacturer, verifyContact, verifyManufacturer } from "../actions";

export default async function SupplierPage({ params, searchParams }: {
  params: Promise<{ manufacturerId: string }>; searchParams: Promise<{ error?: string; notice?: string; edit?: string; template?: string }>;
}) {
  const { manufacturerId: id } = await params;
  const { error, notice, edit, template } = await searchParams;
  const { supabase } = await requireUser();
  const [{ data: m }, { data: contacts }, { data: editor }, { data: rules }, { data: perf }] = await Promise.all([
    supabase.from("manufacturers").select("*").eq("id", id).maybeSingle(),
    supabase.from("manufacturer_contacts").select("*").eq("manufacturer_id", id).order("created_at"),
    supabase.rpc("is_knowledge_editor"),
    supabase.from("process_rules").select("*").eq("manufacturer_id", id).order("process"),
    supabase.rpc("vendor_performance", { p_manufacturer: id }),
  ]);
  const vp = (perf ?? {}) as Record<string, number | null>;
  const pct = (n: number | null | undefined, d: number | null | undefined) => (d ? `${Math.round((100 * (n ?? 0)) / d)}%` : "—");
  if (!m) notFound();
  const certs = (m.certifications ?? []) as { name: string; evidence: string | null }[];

  return (
    <main>
      <p className="crumbs"><Link href="/suppliers">Suppliers</Link> /</p>
      <h1>{m.display_name} <span className={`pill big pill-mfr-${m.status}`} data-testid="mfr-status">{MFR_STATUS[m.status]}</span></h1>
      <Banner error={error} notice={notice} />
      <dl className="facts">
        <dt>Legal name</dt><dd>{m.legal_name ?? <span className="warn-text">not confirmed</span>}</dd>
        <dt>Country</dt><dd>{m.country ?? <span className="warn-text">not confirmed</span>}</dd>
        <dt>Website</dt><dd>{m.website ? <a href={m.website} target="_blank" rel="noreferrer">{m.website}</a> : "—"}</dd>
        <dt>Categories</dt><dd>{(m.categories as string[]).map((c) => CATEGORY_LABEL[c as keyof typeof CATEGORY_LABEL]).join(", ") || "—"}</dd>
        <dt>Processes</dt><dd>{(m.processes as string[]).length ? <ul>{(m.processes as string[]).map((p) => <li key={p}>{p}</li>)}</ul> : <span className="warn-text">none recorded</span>}</dd>
        <dt>Certifications</dt><dd>{certs.length ? <ul>{certs.map((c) => <li key={c.name}>{c.name}{c.evidence ? ` (${c.evidence})` : " (no evidence recorded)"}</li>)}</ul> : "—"}</dd>
        <dt>NDA</dt><dd>{NDA_METHODS[m.nda_method]}</dd>
        <dt>File formats</dt><dd>{(m.file_formats as string[]).join(", ") || "—"}</dd>
        <dt>Lead times</dt><dd>{m.lead_time_note ?? "—"}</dd>
        {m.notes && <><dt>Notes</dt><dd>{m.notes}</dd></>}
        {m.verified_at && <><dt>Verified</dt><dd>{new Date(m.verified_at).toLocaleDateString()}: {m.verification_note}</dd></>}
        {m.approved_at && <><dt>Approved</dt><dd>{new Date(m.approved_at).toLocaleDateString()}</dd></>}
      </dl>

      <section className="card stack">
        <h2 style={{ marginTop: 0 }}>Status</h2>
        {m.status === "candidate" && (
          <form action={verifyManufacturer.bind(null, id)} className="stack">
            <p className="small muted">Verify once the legal name, country and at least one process are recorded and you have checked them
              (company register, certificates, capability pages, a call).</p>
            <label>How was this confirmed?<input name="note" required placeholder="Company register entry and capability page, 18 Nov" /></label>
            <div><SubmitButton pendingText="Verifying…">Verify supplier</SubmitButton></div>
          </form>
        )}
        {m.status === "verified" && (editor
          ? <form action={setManufacturerStatus.bind(null, id, "approved")} className="row">
              <input name="note" placeholder="Note (optional)" aria-label="Approval note" />
              <SubmitButton pendingText="Approving…">Add to the approved vendor list</SubmitButton></form>
          : <p className="small muted">A library editor can add it to the approved vendor list.</p>)}
        {m.status !== "inactive"
          ? <form action={setManufacturerStatus.bind(null, id, "inactive")}><SubmitButton variant="secondary" pendingText="…">Mark inactive</SubmitButton></form>
          : <form action={setManufacturerStatus.bind(null, id, "candidate")}><SubmitButton variant="secondary" pendingText="…">Reactivate as candidate</SubmitButton></form>}
      </section>

      <section>
        <h2>Performance</h2>
        <p className="small muted">From your projects&apos; records: RFQ responses, production lots, inspections and delivery dates. Projects you are not on are not counted.</p>
        <dl className="facts" data-testid="vendor-performance">
          <dt>RFQs</dt><dd>{vp.rfqs_invited ?? 0} invited, {vp.rfqs_quoted ?? 0} quoted, {vp.rfqs_declined ?? 0} declined, {vp.awards ?? 0} awarded
            {vp.median_lead_days != null && `; median quoted lead time ${vp.median_lead_days} days`}</dd>
          <dt>Lots</dt><dd>{vp.lots ?? 0} built, {vp.lots_accepted ?? 0} accepted, {vp.lots_rejected ?? 0} rejected</dd>
          <dt>Inspection</dt><dd>{vp.units_inspected ? `${vp.defects} defect(s) in ${vp.units_inspected} inspected (${pct(vp.defects, vp.units_inspected)})` : "no inspections"}</dd>
          <dt>On time</dt><dd>{vp.deliveries ? `${vp.on_time} of ${vp.deliveries} lot(s) (${pct(vp.on_time, vp.deliveries)})` : "no delivery dates recorded"}</dd>
        </dl>
      </section>

      <ProcessRules manufacturerId={id} rows={rules ?? []} editor={!!editor} editProcess={edit} template={template} />

      <h2>Contacts</h2>
      <table data-testid="contacts">
        <thead><tr><th>Name</th><th>Email</th><th>Phone</th><th></th></tr></thead>
        <tbody>
          {(contacts ?? []).map((c) => (
            <tr key={c.id} data-name={c.name}>
              <td>{c.name}{c.role && <div className="small muted">{c.role}</div>}</td>
              <td>{c.email ?? "—"} {c.email_status === "verified"
                ? <><span className="pill pill-approved">confirmed</span><div className="small muted">{c.verification_source}</div></>
                : <span className="pill pill-awaiting_approval" data-testid="verify-contact">verify contact</span>}</td>
              <td>{c.phone ?? "—"}</td>
              <td>
                {c.email && c.email_status !== "verified" && (
                  <form action={verifyContact.bind(null, id, c.id)} className="row tight">
                    <input name="source" required placeholder="How was it confirmed?" aria-label={`How ${c.name}'s email was confirmed`} />
                    <SubmitButton variant="secondary" pendingText="…">Confirm email</SubmitButton>
                  </form>
                )}
                <form action={removeContact.bind(null, id, c.id)}><button className="btn btn-link" type="submit">Remove</button></form>
              </td>
            </tr>
          ))}
          {!contacts?.length && <tr><td colSpan={4} className="muted">No contacts yet. Add one from the supplier&apos;s own published contact details or correspondence.</td></tr>}
        </tbody>
      </table>
      <form action={addContact.bind(null, id)} className="card stack">
        <h3>Add a contact</h3>
        <div className="grid2">
          <label>Name<input name="name" required placeholder="Quotes desk" /></label>
          <label>Role<input name="role" placeholder="Sales" /></label>
          <label>Email<input name="email" type="email" /></label>
          <label>Phone<input name="phone" /></label>
        </div>
        <div><SubmitButton pendingText="Adding…">Add contact</SubmitButton></div>
      </form>

      <details className="card">
        <summary>Edit details</summary>
        <form action={updateManufacturer.bind(null, id)} className="stack">
          <ManufacturerFields m={m} />
          <div><SubmitButton pendingText="Saving…">Save</SubmitButton></div>
        </form>
      </details>
    </main>
  );
}
