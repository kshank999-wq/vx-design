import Link from "next/link";
import { notFound } from "next/navigation";
import { Banner } from "@/components/Banner";
import { SubmitButton } from "@/components/SubmitButton";
import { requireUser } from "@/lib/auth";
import { limitText, type MeasurementDef } from "@/lib/validation";
import { recordRun } from "../actions";

export default async function RecordPage({ params, searchParams }: {
  params: Promise<{ projectId: string }>; searchParams: Promise<{ error?: string; procedure?: string; unit?: string; supersedes?: string }>;
}) {
  const { projectId } = await params;
  const { error, procedure, unit, supersedes } = await searchParams;
  const { supabase } = await requireUser();
  const [{ data: procs }, { data: units }] = await Promise.all([
    supabase.from("test_procedures").select("id, code, version, title, measurements, setup, steps").eq("project_id", projectId).eq("status", "approved").order("code"),
    supabase.from("units").select("id, serial, revision, status").eq("project_id", projectId).neq("status", "scrapped").order("serial"),
  ]);
  if (!procs) notFound();
  const p = procs.find((x) => x.id === procedure) ?? procs[0];
  if (!p) return <main><h1>Record a test</h1><p className="muted">Approve a test procedure first.</p></main>;
  const ms = p.measurements as MeasurementDef[];
  const now = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);

  return (
    <main>
      <p className="crumbs"><Link href={`/projects/${projectId}/validation`}>Build and validation</Link> /</p>
      <h1>Record a test</h1>
      <Banner error={error} />
      <form method="get" className="row small">
        <label className="inline">Procedure<select name="procedure" defaultValue={p.id} aria-label="Procedure to record">
          {procs.map((x) => <option key={x.id} value={x.id}>{x.code} v{x.version}: {x.title}</option>)}</select></label>
        <button className="btn btn-secondary" type="submit">Switch</button>
      </form>
      <form action={recordRun.bind(null, projectId)} className="card stack" data-testid="record-form">
        <input type="hidden" name="procedure" value={p.id} />
        {supersedes && <input type="hidden" name="supersedes" value={supersedes} />}
        <h2 style={{ marginTop: 0 }}>{p.code} v{p.version}: {p.title}</h2>
        {p.setup && <p className="small"><strong>Setup:</strong> {p.setup}</p>}
        {p.steps && <p className="small pre">{p.steps}</p>}
        <div className="grid2">
          <label>Unit<select name="unit" defaultValue={unit ?? units?.[0]?.id} required>{(units ?? []).map((u) => <option key={u.id} value={u.id}>{u.serial} (rev {u.revision}, {u.status})</option>)}</select></label>
          <label>Performed<input name="performed_at" type="datetime-local" defaultValue={now} required /></label>
          <label>Temperature (°C)<input name="temperature_c" type="number" step="any" /></label>
          <label>Supply (V)<input name="supply_v" type="number" step="any" /></label>
          <label>Firmware version<input name="firmware" /></label>
          <label>Location / bench<input name="location" /></label>
        </div>
        <label>Equipment (one per line: name, asset id, calibrated until)<textarea name="equipment" rows={2} placeholder="DMM, DMM-7, 2027-03-01" /></label>
        <table className="small">
          <thead><tr><th>Measurement</th><th>Limit</th><th>Value</th><th>Requirement</th></tr></thead>
          <tbody>{ms.map((m) => (
            <tr key={m.key}><td>{m.label} <code className="muted">{m.key}</code></td><td>{limitText(m)}</td>
              <td>{m.kind === "boolean"
                ? <select name={`v_${m.key}`} defaultValue="" aria-label={m.label}><option value="">—</option><option value="yes">yes</option><option value="no">no</option></select>
                : <input name={`v_${m.key}`} type={m.kind === "numeric" ? "number" : "text"} step="any" aria-label={m.label} />}{m.unit ? ` ${m.unit}` : ""}</td>
              <td>{m.requirement_ref ?? "—"}</td></tr>
          ))}</tbody>
        </table>
        <label>Or paste values (one &quot;key,value&quot; per line, e.g. from a bench script)<textarea name="paste" rows={3} aria-label="Pasted values" /></label>
        <label>Notes{supersedes ? " (required: what this correction fixes)" : ""}<textarea name="notes" rows={2} required={!!supersedes} /></label>
        <p className="small muted">The result is judged against the approved limits when you record it, and cannot be edited afterwards; a mistake is corrected by a new run.</p>
        <div><SubmitButton pendingText="Recording…">Record result</SubmitButton></div>
      </form>
    </main>
  );
}
