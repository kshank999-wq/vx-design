import Link from "next/link";
import { notFound } from "next/navigation";
import { GASKET_PRESETS, type GasketInput, type GasketResult, type StackInput, type StackResult, type ThermalInput, type ThermalResult } from "@vx/mech";
import { Banner } from "@/components/Banner";
import { SubmitButton } from "@/components/SubmitButton";
import { requireUser } from "@/lib/auth";
import { KIND_LABEL, mechCode, VERDICT } from "@/lib/mech";
import { deleteAnalysis, reviewAnalysis, saveGasket, saveStack, saveThermal } from "../actions";

const Tol = ({ k, label, v }: { k: string; label: string; v?: { nominal: number; plus: number; minus: number } | null }) => (
  <fieldset className="row tight"><legend>{label}</legend>
    <label className="inline">nominal<input name={`${k}_nominal`} defaultValue={v?.nominal ?? ""} size={6} aria-label={`${label} nominal`} /></label>
    <label className="inline">+<input name={`${k}_plus`} defaultValue={v?.plus ?? 0} size={5} aria-label={`${label} plus`} /></label>
    <label className="inline">−<input name={`${k}_minus`} defaultValue={v?.minus ?? 0} size={5} aria-label={`${label} minus`} /></label> mm
  </fieldset>
);

export default async function AnalysisPage({ params, searchParams }: {
  params: Promise<{ projectId: string; analysisId: string }>; searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const { projectId, analysisId } = await params;
  const { error, notice } = await searchParams;
  const { supabase, userId } = await requireUser();
  const [{ data: project }, { data: me }, { data: a }] = await Promise.all([
    supabase.from("projects").select("name").eq("id", projectId).maybeSingle(),
    supabase.from("project_members").select("role").eq("project_id", projectId).eq("user_id", userId).maybeSingle(),
    supabase.from("mech_analyses").select("*").eq("id", analysisId).eq("project_id", projectId).maybeSingle(),
  ]);
  if (!project || !a) notFound();
  const role = me?.role ?? "viewer";
  const canEdit = role === "owner" || role === "engineer";
  const canReview = role === "owner" || role === "reviewer";
  const header = (
    <div className="grid2">
      <label>Title<input name="title" required defaultValue={a.title} aria-label="Title" /></label>
      <label>Note<input name="note" defaultValue={a.note ?? ""} aria-label="Note" /></label>
    </div>
  );
  const key = a.updated_at as string;

  return (
    <main>
      <p className="crumbs"><Link href="/projects">Projects</Link> / <Link href={`/projects/${projectId}`}>{project.name}</Link> /{" "}
        <Link href={`/projects/${projectId}/mechanical`}>Mechanical checks</Link> /</p>
      <h1>{mechCode(a.analysis_no)} {a.title} <span className={`pill pill-${VERDICT[a.verdict]?.[1] ?? ""}`} data-testid="verdict">{VERDICT[a.verdict]?.[0]}</span></h1>
      <p className="muted small">{KIND_LABEL[a.kind]}{a.note && ` — ${a.note}`}</p>
      <Banner error={error} notice={notice} />

      {a.kind === "tolerance_stack" && (() => {
        const i = a.inputs as StackInput, r = a.result as StackResult;
        return (<>
          <section data-testid="result">
            <p>Nominal gap <strong>{r.nominal} mm</strong>. Worst case <strong>{r.worst.min} to {r.worst.max} mm</strong>; statistical (each tolerance ±3σ, root sum
              square) <strong>{r.rss.min} to {r.rss.max} mm</strong>{(i.min_gap != null || i.max_gap != null) && <> against a required gap of
              {i.min_gap != null && ` at least ${i.min_gap}`}{i.min_gap != null && i.max_gap != null && " and"}{i.max_gap != null && ` at most ${i.max_gap}`} mm</>}.</p>
            {r.verdict === "pass_statistical" && <p className="banner banner-warn">Clear statistically but not in the worst case: most builds fit, some can interfere. Tighten the largest contributors or widen the gap if every unit must fit.</p>}
            {r.assumed.length > 0 && <p className="small">Rests on assumed tolerances: {r.assumed.join(", ")}.</p>}
            <p className="small">Share of the variation: {r.shares.map((s) => `${s.name} ${s.pct}%`).join(" · ")}</p>
          </section>
          {canEdit && <form key={key} action={saveStack.bind(null, projectId, analysisId)} className="stack">
            {header}
            <div style={{ overflowX: "auto" }}><table className="small" data-testid="contributors">
              <thead><tr><th>Contributor</th><th>Direction</th><th>Nominal</th><th>+</th><th>−</th><th>Basis</th><th>Assumed</th></tr></thead>
              <tbody>{[...i.contributors, ...Array(2).fill(null)].map((c, n) => (
                <tr key={n}>
                  <td><input name={`c_name_${n}`} defaultValue={c?.name ?? ""} aria-label={`Contributor ${n + 1}`} /></td>
                  <td><select name={`c_sign_${n}`} defaultValue={String(c?.sign ?? 1)} aria-label={`Direction ${n + 1}`}><option value="1">+ adds to the gap</option><option value="-1">− takes from it</option></select></td>
                  <td><input name={`c_nominal_${n}`} defaultValue={c?.nominal ?? ""} size={6} aria-label={`Nominal ${n + 1}`} /></td>
                  <td><input name={`c_plus_${n}`} defaultValue={c?.plus ?? ""} size={5} aria-label={`Plus ${n + 1}`} /></td>
                  <td><input name={`c_minus_${n}`} defaultValue={c?.minus ?? ""} size={5} aria-label={`Minus ${n + 1}`} /></td>
                  <td><input name={`c_basis_${n}`} defaultValue={c?.basis ?? ""} aria-label={`Basis ${n + 1}`} /></td>
                  <td><input type="checkbox" name={`c_assumed_${n}`} defaultChecked={!!c?.assumed} aria-label={`Assumed ${n + 1}`} /></td>
                </tr>
              ))}</tbody>
            </table></div>
            <div className="grid2">
              <label>Required gap: at least (mm)<input name="min_gap" defaultValue={i.min_gap ?? ""} aria-label="Minimum gap" /></label>
              <label>At most (mm)<input name="max_gap" defaultValue={i.max_gap ?? ""} aria-label="Maximum gap" /></label>
            </div>
            <div><SubmitButton pendingText="Calculating…">Save and recalculate</SubmitButton></div>
          </form>}
        </>);
      })()}

      {a.kind === "gasket" && (() => {
        const i = a.inputs as GasketInput, r = a.result as GasketResult;
        return (<>
          <section data-testid="result">
            <p>Compression <strong>{r.compression_pct.min}% to {r.compression_pct.max}%</strong> (nominal {r.compression_pct.nominal}%) against {i.min_pct}–{i.max_pct}%
              {r.fill_pct != null && <>; groove fill up to <strong>{r.fill_pct}%</strong>{i.max_fill_pct != null && ` (limit ${i.max_fill_pct}%)`}</>}.</p>
            <ul className="small">{r.findings.map((f) => <li key={f}>{f}</li>)}</ul>
            {i.basis && <p className="small muted">Limits: {i.basis}.</p>}
          </section>
          {canEdit && <form key={key} action={saveGasket.bind(null, projectId, analysisId)} className="stack small">
            {header}
            <div className="grid2">
              <label>Preset limits<select name="preset" defaultValue="" aria-label="Preset"><option value="">(use the limits below)</option>
                {GASKET_PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label}: {p.min_pct}–{p.max_pct}%</option>)}</select></label>
              <label>Gasket type<select name="kind" defaultValue={i.kind} aria-label="Gasket type"><option value="oring">O-ring</option><option value="foam">foam strip</option></select></label>
            </div>
            <Tol k="section" label={i.kind === "oring" ? "O-ring cross-section" : "Foam thickness (uncompressed)"} v={i.section} />
            <Tol k="gap" label="Groove depth (closed gap)" v={i.gap} />
            <Tol k="width" label="Groove width (O-ring)" v={i.groove_width} />
            <div className="grid2">
              <label>Compression at least (%)<input name="min_pct" defaultValue={i.min_pct} aria-label="Minimum compression" /></label>
              <label>At most (%)<input name="max_pct" defaultValue={i.max_pct} aria-label="Maximum compression" /></label>
              <label>Groove fill at most (%)<input name="max_fill_pct" defaultValue={i.max_fill_pct ?? ""} aria-label="Maximum fill" /></label>
              <label>Where the limits come from<input name="basis" defaultValue={i.basis ?? ""} aria-label="Limits basis" /></label>
            </div>
            <div><SubmitButton pendingText="Calculating…">Save and recalculate</SubmitButton></div>
          </form>}
        </>);
      })()}

      {a.kind === "thermal" && (() => {
        const i = a.inputs as ThermalInput, r = a.result as ThermalResult;
        return (<>
          <section data-testid="result">
            <p>{i.power_w} W inside a {i.box_mm.x} × {i.box_mm.y} × {i.box_mm.z} mm box ({r.area_m2} m² of surface at {i.h_w_m2k} W/m²·K): the air inside rises
              {" "}<strong>{r.air_rise_c} °C</strong> to <strong>{r.air_c} °C</strong> at a {i.ambient_max_c} °C ambient.</p>
            <table className="small"><thead><tr><th>Part</th><th>Heat</th><th>θJA</th><th>Junction inside the box</th><th>Margin</th></tr></thead>
              <tbody>{r.sources.map((s, n) => (
                <tr key={s.name}><td>{s.name}</td><td>{i.sources[n]?.watts} W</td><td>{i.sources[n]?.theta_ja ?? "—"}</td>
                  <td>{s.tj_c ?? "not checked (no θJA)"}{s.tj_c != null && " °C"}</td>
                  <td>{s.margin_c == null ? "—" : <span className={`pill pill-${s.ok ? "complete" : "failed"}`}>{s.margin_c} °C</span>}</td></tr>
              ))}{!r.sources.length && <tr><td colSpan={5} className="muted">No parts listed.</td></tr>}</tbody></table>
            <ul className="small">{r.findings.map((f) => <li key={f}>{f}</li>)}</ul>
            {i.basis && <p className="small muted">Basis: {i.basis}.</p>}
            <p className="small muted">A first-order estimate for a sealed box (heat leaves only through its walls); a vented box runs cooler, and a part
              against a wall or under a heat-spreading pour may differ. Confirm with a thermocouple on a prototype.</p>
          </section>
          {canEdit && <form key={key} action={saveThermal.bind(null, projectId, analysisId)} className="stack small">
            {header}
            <div className="grid2">
              <label>Heat inside the box (W)<input name="power_w" defaultValue={i.power_w} aria-label="Power" /></label>
              <label>Ambient, worst case (°C)<input name="ambient_max_c" defaultValue={i.ambient_max_c} aria-label="Ambient" /></label>
              <label>Box X (mm)<input name="box_x" defaultValue={i.box_mm.x} aria-label="Box X" /></label>
              <label>Box Y (mm)<input name="box_y" defaultValue={i.box_mm.y} aria-label="Box Y" /></label>
              <label>Box Z (mm)<input name="box_z" defaultValue={i.box_mm.z} aria-label="Box Z" /></label>
              <label>Heat transfer coefficient (W/m²·K)<input name="h_w_m2k" defaultValue={i.h_w_m2k} aria-label="Coefficient" /></label>
              <label>Internal air limit (°C, optional)<input name="air_limit_c" defaultValue={i.air_limit_c ?? ""} aria-label="Air limit" /></label>
              <label>Basis<input name="basis" defaultValue={i.basis ?? ""} aria-label="Thermal basis" /></label>
            </div>
            <table><thead><tr><th>Part</th><th>Heat (W)</th><th>θJA (°C/W)</th><th>Tj max (°C)</th><th>Basis</th></tr></thead>
              <tbody>{[...i.sources, null].map((s, n) => (
                <tr key={n}><td><input name={`s_name_${n}`} defaultValue={s?.name ?? ""} aria-label={`Part ${n + 1}`} /></td>
                  <td><input name={`s_watts_${n}`} defaultValue={s?.watts ?? ""} size={5} aria-label={`Heat ${n + 1}`} /></td>
                  <td><input name={`s_theta_${n}`} defaultValue={s?.theta_ja ?? ""} size={5} aria-label={`Theta ${n + 1}`} /></td>
                  <td><input name={`s_tjmax_${n}`} defaultValue={s?.tj_max ?? ""} size={5} aria-label={`Tj max ${n + 1}`} /></td>
                  <td><input name={`s_basis_${n}`} defaultValue={s?.basis ?? ""} aria-label={`Part basis ${n + 1}`} /></td></tr>
              ))}</tbody></table>
            <div><SubmitButton pendingText="Calculating…">Save and recalculate</SubmitButton></div>
          </form>}
        </>);
      })()}

      <section>
        <h2>Review</h2>
        {a.reviewed_at ? <p data-testid="review">Reviewed {new Date(a.reviewed_at).toLocaleDateString()}: {a.review_note}</p> : <p className="muted small">Not reviewed. Saving changes clears a review.</p>}
        {canReview && !a.reviewed_at && (
          <form action={reviewAnalysis.bind(null, projectId, analysisId)} className="row tight">
            <input name="review_note" required aria-label="Review note" placeholder="what you checked" />
            <SubmitButton variant="secondary" pendingText="…">Mark reviewed</SubmitButton>
          </form>
        )}
        {canEdit && !a.reviewed_at && <form action={deleteAnalysis.bind(null, projectId, analysisId)}><SubmitButton variant="secondary" pendingText="…">Delete</SubmitButton></form>}
      </section>
    </main>
  );
}
