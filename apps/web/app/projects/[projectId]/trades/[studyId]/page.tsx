import Link from "next/link";
import { notFound } from "next/navigation";
import { Banner } from "@/components/Banner";
import { SubmitButton } from "@/components/SubmitButton";
import { requireUser } from "@/lib/auth";
import { KINDS, studyCode, type Study } from "@/lib/trades";
import { addModuleOption, decideStudy, fillFromCatalog, saveStudy, withdrawStudy } from "../actions";

const BLANK = 2;

export default async function StudyPage({ params, searchParams }: {
  params: Promise<{ projectId: string; studyId: string }>; searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const { projectId, studyId } = await params;
  const { error, notice } = await searchParams;
  const { supabase, userId } = await requireUser();
  const [{ data: project }, { data: me }, { data: row }, { data: modules }] = await Promise.all([
    supabase.from("projects").select("name").eq("id", projectId).maybeSingle(),
    supabase.from("project_members").select("role").eq("project_id", projectId).eq("user_id", userId).maybeSingle(),
    supabase.from("trade_studies").select("*").eq("id", studyId).eq("project_id", projectId).maybeSingle(),
    supabase.from("modules").select("id, name, manufacturer, mpn, kind").order("name"),
  ]);
  if (!project || !row) notFound();
  const s = row as Study;
  const role = me?.role ?? "viewer";
  const draft = s.status === "draft";
  const canEdit = draft && (role === "owner" || role === "engineer");
  const canDecide = draft && (role === "owner" || role === "reviewer");
  const r = s.result;
  const fmt = (v: unknown) => (typeof v === "boolean" ? (v ? "yes" : "no") : v == null ? "" : String(v));
  const crit = [...s.criteria, ...(canEdit ? Array.from({ length: BLANK }, () => null) : [])];
  const opts = [...s.options, ...(canEdit ? Array.from({ length: BLANK }, () => null) : [])];

  return (
    <main>
      <p className="crumbs"><Link href="/projects">Projects</Link> / <Link href={`/projects/${projectId}`}>{project.name}</Link> /{" "}
        <Link href={`/projects/${projectId}/trades`}>Trade studies</Link> /</p>
      <h1>{studyCode(s.study_no)} {s.question} <span className="pill">{s.stage}</span>{" "}
        <span className={`pill pill-${s.status === "decided" ? "complete" : "awaiting_approval"}`} data-testid="study-status">{s.status}</span></h1>
      <Banner error={error} notice={notice} />

      {r && (
        <section className="card" data-testid="ranking">
          <h2>Ranking</h2>
          <table className="small">
            <thead><tr><th>Option</th><th>Score (0–100)</th><th>Notes</th></tr></thead>
            <tbody>{r.ranking.map((o) => (
              <tr key={o.key} data-option={o.key}>
                <td><strong>{o.name}</strong>{s.chosen_option === o.key && <span className="pill pill-complete"> chosen</span>}</td>
                <td>{o.total ?? "excluded"}</td>
                <td>{o.excluded.length ? `fails: ${o.excluded.join(", ")}` : ""}{o.missing.length ? `${o.excluded.length ? "; " : ""}no value for: ${o.missing.join(", ")}` : ""}</td>
              </tr>
            ))}</tbody>
          </table>
          <p className="small" data-testid="sensitivity">{!r.winner ? "No option can be ranked yet."
            : r.robust ? `${r.ranking[0]!.name} leads, and stays ahead if any one weight is halved or doubled.`
            : `Close call: ${r.sensitive_to.map((x) => `with "${x.criterion}" ${x.change}, ${x.winner} would win`).join("; ")}.`}
            {r.winner && !r.complete && " Some values are missing, so the ranking may change."}</p>
        </section>
      )}

      {s.status !== "draft" && (
        <section className="card">
          <p>{s.status === "decided" ? <>Chose <strong>{s.options.find((o) => o.key === s.chosen_option)?.name}</strong>: {s.decision_note}</> : <>Withdrawn: {s.decision_note}</>}</p>
          {s.decision_id && <p className="small muted">Recorded as a project decision on {new Date(s.decided_at!).toLocaleString()}.</p>}
        </section>
      )}

      <form action={saveStudy.bind(null, projectId, studyId)} className="stack" id="study">
        <fieldset disabled={!canEdit} className="stack">
          <label>Question<input name="question" defaultValue={s.question} /></label>
          <label>Context<input name="context" defaultValue={s.context ?? ""} placeholder="What the choice is for, constraints" /></label>
          <label>Requirements<input name="requirement_refs" defaultValue={s.requirement_refs.join(", ")} placeholder="REQ-IF-001, REQ-PWR-002" /></label>

          <h2>Criteria</h2>
          <table className="small" data-testid="criteria">
            <thead><tr><th>Criterion</th><th>Kind</th><th>Weight (0–10)</th><th>Unit</th></tr></thead>
            <tbody>{crit.map((c, i) => (
              <tr key={c?.key ?? `new-${i}`}>
                <td><input name={`c_label_${i}`} defaultValue={c?.label ?? ""} aria-label={`Criterion ${i + 1}`} />
                  <input type="hidden" name={`c_key_${i}`} value={c?.key ?? ""} /></td>
                <td><select name={`c_kind_${i}`} defaultValue={c?.kind ?? "lower"} aria-label={`Kind ${i + 1}`}>
                  {Object.entries(KINDS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></td>
                <td><input name={`c_weight_${i}`} defaultValue={c ? String(c.weight) : "5"} inputMode="decimal" aria-label={`Weight ${i + 1}`} /></td>
                <td><input name={`c_unit_${i}`} defaultValue={c?.unit ?? ""} aria-label={`Unit ${i + 1}`} /></td>
              </tr>
            ))}</tbody>
          </table>

          <h2>Options</h2>
          <table className="small" data-testid="options">
            <thead><tr><th>Option</th><th>Part number</th><th>Manufacturer</th><th>Description</th></tr></thead>
            <tbody>{opts.map((o, j) => (
              <tr key={o?.key ?? `new-${j}`}>
                <td><input name={`o_name_${j}`} defaultValue={o?.name ?? ""} aria-label={`Option ${j + 1}`} />
                  <input type="hidden" name={`o_key_${j}`} value={o?.key ?? ""} /></td>
                <td><input name={`o_mpn_${j}`} defaultValue={o?.mpn ?? ""} aria-label={`Part number ${j + 1}`} /></td>
                <td><input name={`o_mfr_${j}`} defaultValue={o?.manufacturer ?? ""} aria-label={`Manufacturer ${j + 1}`} /></td>
                <td><input name={`o_desc_${j}`} defaultValue={o?.description ?? ""} aria-label={`Description ${j + 1}`} /></td>
              </tr>
            ))}</tbody>
          </table>

          {s.criteria.length > 0 && s.options.length > 0 && <>
            <h2>Scores</h2>
            <p className="small muted">Value, then where it came from. Must-haves take yes or no; ratings 1–5 (5 best). Values filled from the catalog are marked.</p>
            <table className="small" data-testid="scores">
              <thead><tr><th>Criterion</th>{s.options.map((o) => <th key={o.key}>{o.name}</th>)}</tr></thead>
              <tbody>{s.criteria.map((c) => (
                <tr key={c.key} data-criterion={c.key}>
                  <td>{c.label}{c.unit ? ` (${c.unit})` : ""}<div className="muted">{KINDS[c.kind]}{c.kind !== "must" ? `, weight ${c.weight}` : ""}</div></td>
                  {s.options.map((o) => {
                    const sc = s.scores[o.key]?.[c.key];
                    return <td key={o.key}>
                      <input name={`s__${o.key}__${c.key}`} defaultValue={fmt(sc?.value)} aria-label={`${o.name}: ${c.label}`} />
                      <input name={`b__${o.key}__${c.key}`} defaultValue={sc?.basis ?? ""} placeholder="basis" aria-label={`Basis, ${o.name}: ${c.label}`} />
                      {sc?.source === "catalog" && <div className="muted">from the catalog</div>}
                    </td>;
                  })}
                </tr>
              ))}</tbody>
            </table>
          </>}
        </fieldset>
        {canEdit && <div className="row tight">
          <SubmitButton pendingText="Saving…">Save and rank</SubmitButton>
          <SubmitButton variant="secondary" formAction={fillFromCatalog.bind(null, projectId, studyId)} pendingText="Looking up…">Fill from parts catalog</SubmitButton>
          {!!modules?.length && <>
            <select name="module_id" defaultValue="" aria-label="Module to add"><option value="">(module from the catalog)</option>
              {modules.map((m) => <option key={m.id} value={m.id}>{m.name} ({m.manufacturer} {m.mpn})</option>)}</select>
            <SubmitButton variant="secondary" formAction={addModuleOption.bind(null, projectId, studyId)} pendingText="Adding…">Add module as option</SubmitButton>
          </>}
        </div>}
      </form>

      {canDecide && r?.winner && (
        <form action={decideStudy.bind(null, projectId, studyId)} className="card stack" data-testid="decide">
          <h2>Decide</h2>
          <label>Choice<select name="option" defaultValue={r.winner}>
            {r.ranking.filter((o) => !o.excluded.length).map((o) => <option key={o.key} value={o.key}>{o.name}</option>)}</select></label>
          <label>Rationale<input name="rationale" required placeholder="Why this one (and anything the scores do not show)" /></label>
          <div><SubmitButton pendingText="Recording…">Record the decision</SubmitButton></div>
        </form>
      )}
      {canEdit && (
        <details className="card"><summary>Withdraw this study</summary>
          <form action={withdrawStudy.bind(null, projectId, studyId)} className="row">
            <input name="note" required placeholder="Why it is no longer needed" aria-label="Reason to withdraw" />
            <SubmitButton variant="secondary" pendingText="…">Withdraw</SubmitButton>
          </form>
        </details>
      )}
    </main>
  );
}
