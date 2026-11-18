import Link from "next/link";
import { notFound } from "next/navigation";
import { Banner } from "@/components/Banner";
import { SubmitButton } from "@/components/SubmitButton";
import { requireUser } from "@/lib/auth";
import { STAGES } from "@/lib/validation";
import { addUnit, draftFromRequirements, newProcedure, updateFault } from "./actions";

const MATRIX: Record<string, [string, string]> = {
  verified: ["verified by test", "complete"], failing: ["failing", "failed"], incomplete: ["incomplete", "awaiting_approval"],
  not_tested: ["not tested", "awaiting_approval"], no_procedure: ["no procedure", ""],
};

export default async function ValidationPage({ params, searchParams }: {
  params: Promise<{ projectId: string }>; searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const { projectId } = await params;
  const { error, notice } = await searchParams;
  const { supabase, userId } = await requireUser();
  const [{ data: project }, { data: me }, { data: matrix }, { data: units }, { data: procs }, { data: faults }, { data: runs }, { data: builds }] = await Promise.all([
    supabase.from("projects").select("name").eq("id", projectId).maybeSingle(),
    supabase.from("project_members").select("role").eq("project_id", projectId).eq("user_id", userId).maybeSingle(),
    supabase.rpc("requirement_verification", { p_project_id: projectId }),
    supabase.from("units").select("*").eq("project_id", projectId).order("serial"),
    supabase.from("test_procedures").select("id, code, version, title, stage, status, requirement_refs, measurements").eq("project_id", projectId).neq("status", "superseded").order("code"),
    supabase.from("faults").select("*, units(serial), test_runs!faults_run_id_fkey(run_no)").eq("project_id", projectId).order("fault_no", { ascending: false }),
    supabase.from("test_runs").select("id, run_no, verdict, performed_at, units(serial), test_procedures(code, version, title)").eq("project_id", projectId).order("run_no", { ascending: false }).limit(25),
    supabase.from("artifact_versions").select("id, version, artifacts!inner(name, kind)").eq("project_id", projectId).eq("status", "committed").in("artifacts.kind", ["fab_package", "kicad_project", "pcb"]),
  ]);
  if (!project) notFound();
  const role = me?.role ?? "viewer";
  const canEdit = role === "owner" || role === "engineer";
  const canRecord = canEdit || role === "reviewer";
  const m = (matrix ?? []) as { ref_code: string; text: string; procedures: string[]; units_passed: number; units_failed: number; units_incomplete: number; last_run_at: string | null; status: string }[];
  const counts = m.reduce<Record<string, number>>((a, r) => ({ ...a, [r.status]: (a[r.status] ?? 0) + 1 }), {});
  const allRuns = runs ?? [];

  return (
    <main>
      <p className="crumbs"><Link href="/projects">Projects</Link> / <Link href={`/projects/${projectId}`}>{project.name}</Link> /</p>
      <h1>Build and validation</h1>
      <p className="muted">Prototype units, approved test procedures, recorded results with their evidence, and faults through to a verified fix.
        Pass and fail are computed from the approved limits, never typed in; recorded results cannot be edited. Test evidence is not certification.</p>
      <Banner error={error} notice={notice} />

      <section>
        <h2>Requirement verification</h2>
        <p className="small" data-testid="matrix-summary">{m.length} requirement(s): {counts.verified ?? 0} verified by test, {counts.failing ?? 0} failing,
          {" "}{(counts.not_tested ?? 0) + (counts.incomplete ?? 0)} not yet tested or incomplete, {counts.no_procedure ?? 0} without a procedure.</p>
        <table className="small" data-testid="matrix">
          <thead><tr><th>Requirement</th><th>Procedures</th><th>Units passing / failing / incomplete</th><th>Status</th></tr></thead>
          <tbody>{m.map((r) => (
            <tr key={r.ref_code} data-ref={r.ref_code}><td><strong>{r.ref_code}</strong> {r.text}</td><td>{r.procedures.join(", ") || "—"}</td>
              <td>{r.units_passed} / {r.units_failed} / {r.units_incomplete}</td>
              <td><span className={`pill pill-${MATRIX[r.status]?.[1] ?? ""}`}>{MATRIX[r.status]?.[0] ?? r.status}</span></td></tr>
          ))}{!m.length && <tr><td colSpan={4} className="muted">No requirements yet.</td></tr>}</tbody>
        </table>
      </section>

      <section>
        <h2>Units</h2>
        <table className="small" data-testid="units">
          <thead><tr><th>Serial</th><th>Revision</th><th>Built from</th><th>Lot / assembler</th><th>Status</th></tr></thead>
          <tbody>{(units ?? []).map((u) => {
            const b = (builds ?? []).find((x) => x.id === u.built_from_version_id);
            return <tr key={u.id} data-serial={u.serial}><td><strong>{u.serial}</strong></td><td>{u.revision}</td>
              <td>{b ? `${(b.artifacts as unknown as { name: string }).name} v${b.version}` : "—"}</td><td>{[u.lot, u.assembled_by].filter(Boolean).join(" · ") || "—"}</td>
              <td><span className={`pill pill-unit-${u.status}`}>{u.status.replace("_", " ")}</span></td></tr>;
          })}{!units?.length && <tr><td colSpan={5} className="muted">No units registered.</td></tr>}</tbody>
        </table>
        {canEdit && (
          <details className="card"><summary>Register a unit</summary>
            <form action={addUnit.bind(null, projectId)} className="stack">
              <div className="grid2">
                <label>Serial<input name="serial" required placeholder="SN-001" /></label>
                <label>Board revision<input name="revision" required placeholder="A" /></label>
                <label>Built from<select name="built_from" defaultValue=""><option value="">(not recorded)</option>
                  {(builds ?? []).map((b) => <option key={b.id} value={b.id}>{(b.artifacts as unknown as { name: string }).name} v{b.version}</option>)}</select></label>
                <label>Lot<input name="lot" /></label>
                <label>Assembled by<input name="assembled_by" /></label>
                <label>Received<input name="received_at" type="date" /></label>
              </div>
              <label>Notes<input name="notes" /></label>
              <div><SubmitButton pendingText="Registering…">Register unit</SubmitButton></div>
            </form>
          </details>
        )}
      </section>

      <section>
        <div className="row spread"><h2>Test plan</h2>
          {canEdit && <div className="row tight">
            <form action={draftFromRequirements.bind(null, projectId)}><SubmitButton variant="secondary" pendingText="Drafting…">Draft from requirements</SubmitButton></form>
            <form action={newProcedure.bind(null, projectId)}><SubmitButton variant="secondary" pendingText="…">New procedure</SubmitButton></form>
          </div>}
        </div>
        <table className="small" data-testid="procedures">
          <thead><tr><th>Procedure</th><th>Stage</th><th>Requirements</th><th>Checks</th><th>Status</th><th></th></tr></thead>
          <tbody>{(procs ?? []).map((p) => (
            <tr key={p.id} data-code={p.code} data-status={p.status}>
              <td><Link href={`/projects/${projectId}/validation/procedures/${p.id}`}>{p.code} v{p.version}</Link> {p.title}</td>
              <td>{STAGES[p.stage]}</td><td>{(p.requirement_refs as string[]).join(", ") || "—"}</td><td>{(p.measurements as unknown[]).length}</td>
              <td><span className={`pill pill-${p.status === "approved" ? "complete" : "awaiting_approval"}`}>{p.status}</span></td>
              <td>{p.status === "approved" && canRecord && (units ?? []).length > 0 &&
                <Link href={`/projects/${projectId}/validation/record?procedure=${p.id}`}>Record a test</Link>}</td>
            </tr>
          ))}{!procs?.length && <tr><td colSpan={6} className="muted">No procedures yet.</td></tr>}</tbody>
        </table>
      </section>

      <section>
        <h2>Faults</h2>
        <ul className="list small" data-testid="faults">{(faults ?? []).map((f) => (
          <li key={f.id} data-status={f.status}>
            <span className={`pill pill-${f.status === "verified" ? "complete" : f.status === "open" ? "failed" : "awaiting_approval"}`}>{f.status.replace("_", " ")}</span>
            {" "}<strong>F-{String(f.fault_no).padStart(3, "0")}</strong> {f.title}
            {f.run_id && <> · <Link href={`/projects/${projectId}/validation/runs/${f.run_id}`}>run {(f.test_runs as unknown as { run_no: number } | null)?.run_no}</Link></>}
            {f.root_cause && <div>Cause: {f.root_cause}</div>}
            {f.correction && <div>Correction ({f.correction_kind?.replace("_", " ")}): {f.correction}</div>}
            {f.verified_by_run && <div>Verified by <Link href={`/projects/${projectId}/validation/runs/${f.verified_by_run}`}>a passing retest</Link></div>}
            {canEdit && f.status !== "verified" && (
              <details><summary>Update</summary>
                <form action={updateFault.bind(null, projectId, f.id)} className="stack">
                  <div className="grid2">
                    <label>Status<select name="status" defaultValue={f.status === "open" ? "corrected" : "verified"} aria-label={`Status of F-${f.fault_no}`}>
                      <option value="open">open</option><option value="corrected">corrected</option><option value="verified">verified by retest</option><option value="wont_fix">won&apos;t fix (owner)</option></select></label>
                    <label>Correction kind<select name="correction_kind" defaultValue={f.correction_kind ?? "rework"} aria-label={`Correction kind for F-${f.fault_no}`}>
                      {["rework", "design_change", "firmware", "component", "procedure", "none"].map((k) => <option key={k} value={k}>{k.replace("_", " ")}</option>)}</select></label>
                  </div>
                  <label>Root cause<input name="root_cause" defaultValue={f.root_cause ?? ""} aria-label={`Root cause of F-${f.fault_no}`} /></label>
                  <label>Correction<input name="correction" defaultValue={f.correction ?? ""} aria-label={`Correction for F-${f.fault_no}`} /></label>
                  <label>Verified by run<select name="verified_by_run" defaultValue="" aria-label={`Verifying run for F-${f.fault_no}`}><option value="">—</option>
                    {allRuns.filter((r) => r.verdict === "pass").map((r) => <option key={r.id} value={r.id}>run {r.run_no}: {(r.units as unknown as { serial: string }).serial} {(r.test_procedures as unknown as { code: string }).code}</option>)}</select></label>
                  <label>Note<input name="note" aria-label={`Note for F-${f.fault_no}`} /></label>
                  <div><SubmitButton variant="secondary" pendingText="Saving…">Update fault</SubmitButton></div>
                </form>
              </details>
            )}
          </li>
        ))}{!faults?.length && <li className="muted">No faults recorded.</li>}</ul>
      </section>

      <section>
        <h2>Recent test runs</h2>
        <table className="small" data-testid="runs">
          <thead><tr><th>Run</th><th>Unit</th><th>Procedure</th><th>Performed</th><th>Result</th></tr></thead>
          <tbody>{allRuns.map((r) => {
            const p = r.test_procedures as unknown as { code: string; version: number; title: string };
            return <tr key={r.id}><td><Link href={`/projects/${projectId}/validation/runs/${r.id}`}>run {r.run_no}</Link></td>
              <td>{(r.units as unknown as { serial: string }).serial}</td><td>{p.code} v{p.version} {p.title}</td><td>{new Date(r.performed_at).toLocaleString()}</td>
              <td><span className={`pill pill-verdict-${r.verdict}`}>{r.verdict}</span></td></tr>;
          })}{!allRuns.length && <tr><td colSpan={5} className="muted">No tests recorded yet.</td></tr>}</tbody>
        </table>
      </section>
    </main>
  );
}
