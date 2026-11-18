import Link from "next/link";
import { notFound } from "next/navigation";
import { Banner } from "@/components/Banner";
import { SubmitButton } from "@/components/SubmitButton";
import { requireUser } from "@/lib/auth";
import { limitText, STAGES, type MeasurementDef } from "@/lib/validation";
import { approveProcedure, reviseProcedure, saveProcedure } from "../../actions";

export default async function ProcedurePage({ params, searchParams }: {
  params: Promise<{ projectId: string; procedureId: string }>; searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const { projectId, procedureId } = await params;
  const { error, notice } = await searchParams;
  const { supabase, userId } = await requireUser();
  const [{ data: p }, { data: me }, { data: reqs }, { data: versions }] = await Promise.all([
    supabase.from("test_procedures").select("*").eq("id", procedureId).eq("project_id", projectId).maybeSingle(),
    supabase.from("project_members").select("role").eq("project_id", projectId).eq("user_id", userId).maybeSingle(),
    supabase.from("requirements").select("ref_code, text").eq("project_id", projectId).neq("status", "rejected").order("ref_code"),
    supabase.from("test_procedures").select("id, version, status").eq("project_id", projectId).order("version"),
  ]);
  if (!p) notFound();
  const role = me?.role ?? "viewer";
  const draft = p.status === "draft";
  const canEdit = (role === "owner" || role === "engineer") && draft;
  const ms = p.measurements as MeasurementDef[];
  const rows = canEdit ? [...ms, ...Array.from({ length: 3 }, () => null)] : ms;
  const sameCode = (versions ?? []).filter((v) => v.id === p.id || true);

  return (
    <main>
      <p className="crumbs"><Link href={`/projects/${projectId}/validation`}>Build and validation</Link> /</p>
      <h1>{p.code} v{p.version} <span className={`pill big pill-${p.status === "approved" ? "complete" : "awaiting_approval"}`} data-testid="procedure-status">{p.status}</span></h1>
      <Banner error={error} notice={notice} />
      {p.approved_at && <p className="small muted">Approved {new Date(p.approved_at).toLocaleString()}. Approved versions are frozen; revise to make a new version.</p>}
      <form action={saveProcedure.bind(null, projectId, p.id)} className="stack">
        <fieldset disabled={!canEdit} className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
          <div className="grid2">
            <label>Title<input name="title" defaultValue={p.title} required /></label>
            <label>Stage<select name="stage" defaultValue={p.stage}>{Object.entries(STAGES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          </div>
          <label>Setup (equipment, fixtures, firmware)<textarea name="setup" rows={2} defaultValue={p.setup ?? ""} /></label>
          <label>Steps<textarea name="steps" rows={5} defaultValue={p.steps ?? ""} /></label>
          <fieldset className="licenses"><legend className="small muted">Requirements verified</legend>
            {(reqs ?? []).map((r) => <label key={r.ref_code} className="radio"><input type="checkbox" name="requirement_refs" value={r.ref_code}
              defaultChecked={(p.requirement_refs as string[]).includes(r.ref_code)} /><span><strong>{r.ref_code}</strong> {r.text}</span></label>)}
          </fieldset>
          <h2>Measurements and checks</h2>
          <p className="small muted">Numeric: give min and/or max (pass inside the limits). Yes/no and text: give the expected answer. A measurement with no limit is recorded for information only.</p>
          <table className="small" data-testid="measurement-defs">
            <thead><tr><th>Key</th><th>Label</th><th>Kind</th><th>Unit</th><th>Min</th><th>Max</th><th>Expected</th><th>Requirement</th><th>Basis</th></tr></thead>
            <tbody>{rows.map((m, i) => canEdit ? (
              <tr key={i}>
                <td><input name="m_key" defaultValue={m?.key ?? ""} aria-label={`Key ${i + 1}`} style={{ width: 120 }} /></td>
                <td><input name="m_label" defaultValue={m?.label ?? ""} aria-label={`Label ${i + 1}`} /></td>
                <td><select name="m_kind" defaultValue={m?.kind ?? "numeric"} aria-label={`Kind ${i + 1}`}><option value="numeric">number</option><option value="boolean">yes/no</option><option value="text">text</option></select></td>
                <td><input name="m_unit" defaultValue={m?.unit ?? ""} aria-label={`Unit ${i + 1}`} style={{ width: 60 }} /></td>
                <td><input name="m_min" type="number" step="any" defaultValue={m?.min ?? ""} aria-label={`Min ${i + 1}`} style={{ width: 80 }} /></td>
                <td><input name="m_max" type="number" step="any" defaultValue={m?.max ?? ""} aria-label={`Max ${i + 1}`} style={{ width: 80 }} /></td>
                <td><input name="m_expected" defaultValue={m?.expected ?? ""} aria-label={`Expected ${i + 1}`} style={{ width: 70 }} /></td>
                <td><select name="m_req" defaultValue={m?.requirement_ref ?? ""} aria-label={`Requirement ${i + 1}`}><option value="">—</option>
                  {(reqs ?? []).map((r) => <option key={r.ref_code} value={r.ref_code}>{r.ref_code}</option>)}</select></td>
                <td><input name="m_basis" defaultValue={m?.basis ?? ""} aria-label={`Basis ${i + 1}`} /></td>
              </tr>
            ) : (
              <tr key={i}><td><code>{m!.key}</code></td><td>{m!.label}</td><td>{m!.kind}</td><td>{m!.unit ?? ""}</td><td colSpan={3}>{limitText(m!)}</td>
                <td>{m!.requirement_ref ?? "—"}</td><td className="muted">{m!.basis ?? ""}</td></tr>
            ))}</tbody>
          </table>
          {canEdit && <div><SubmitButton pendingText="Saving…">Save draft</SubmitButton></div>}
        </fieldset>
      </form>
      <div className="row">
        {draft && (role === "owner" || role === "reviewer") && (
          <form action={approveProcedure.bind(null, projectId, p.id)} className="approval-stop stack">
            <div className="small"><strong>Approval.</strong> Check the limits against the requirements and the datasheets. Once approved, this version is frozen and results are judged against it.</div>
            <div><SubmitButton pendingText="Approving…">Approve procedure</SubmitButton></div>
          </form>
        )}
        {p.status === "approved" && (role === "owner" || role === "engineer") &&
          <form action={reviseProcedure.bind(null, projectId, p.id)}><SubmitButton variant="secondary" pendingText="…">Revise (new version)</SubmitButton></form>}
        {p.status === "approved" && <Link className="btn btn-primary" href={`/projects/${projectId}/validation/record?procedure=${p.id}`}>Record a test</Link>}
      </div>
      {sameCode.length > 1 && <p className="small muted">Versions of this project&apos;s procedures are kept; superseded versions stay attached to the results recorded with them.</p>}
    </main>
  );
}
