import Link from "next/link";
import { notFound } from "next/navigation";
import { AssemblyDraft, fastenersToLines, partsToLines } from "@vx/planning";
import { Banner } from "@/components/Banner";
import { SubmitButton } from "@/components/SubmitButton";
import { requireUser } from "@/lib/auth";
import { assemblyBom, assemblyFigures } from "@/lib/assembly";
import { addStep, approve, deleteStep, draftAssembly, moveStep, recheck, revise, saveHeader, saveStep } from "./actions";

export const maxDuration = 300;

/** Assembly instructions for the finished product: drafted, edited step by step, approved, exported for the assembler. */
export default async function AssemblyPage({ params, searchParams }: {
  params: Promise<{ projectId: string }>; searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const { projectId } = await params;
  const { error, notice } = await searchParams;
  const { supabase, userId } = await requireUser();
  const [{ data: project }, { data: me }, { data: versions }, figures] = await Promise.all([
    supabase.from("projects").select("name").eq("id", projectId).maybeSingle(),
    supabase.from("project_members").select("role").eq("project_id", projectId).eq("user_id", userId).maybeSingle(),
    supabase.from("assembly_instructions").select("id, version, status, content, problems, model, guidance, created_at, approved_at").eq("project_id", projectId)
      .order("version", { ascending: false }).limit(20),
    assemblyFigures(supabase, projectId),
  ]);
  if (!project) notFound();
  const role = me?.role;
  const canEdit = role === "owner" || role === "engineer";
  const canApprove = role === "owner" || role === "reviewer";
  const current = (versions ?? []).find((v) => v.status === "draft") ?? (versions ?? []).find((v) => v.status === "approved") ?? null;
  const d = current ? AssemblyDraft.parse(current.content) : null;
  const editable = canEdit && current?.status === "draft";
  const problems = (current?.problems ?? []) as string[];
  const { data: signed } = figures.length ? await supabase.storage.from("project-files").createSignedUrls(figures.map((f) => f.path), 3600) : { data: [] };
  const img = new Map(figures.map((f, i) => [f.code, signed?.[i]?.signedUrl ?? ""]));
  const total = d ? d.steps.reduce((a, s) => a + (s.minutes || 0), 0) : 0;

  return (
    <main>
      <p className="crumbs"><Link href="/projects">Projects</Link> / <Link href={`/projects/${projectId}`}>{project.name}</Link> /</p>
      <h1>Assembly instructions</h1>
      <p className="muted">How the finished product goes together, step by step, for the person building it: parts, fasteners with torques, tools,
        cautions and a check per step. Drafted from the parts already chosen, the manufacturing routes, the boards and the enclosure; edited here;
        approved by the owner or a reviewer, which locks the version; then exported for the assembler.</p>
      <Banner error={error} notice={notice} />

      {canEdit && (
        <details className="card" open={!current} data-testid="draft-form">
          <summary><strong>{current ? "Draft again" : "Draft the assembly instructions"}</strong></summary>
          <form action={draftAssembly.bind(null, projectId)} className="stack">
            <label>Anything the drafter should know (optional)<textarea name="guidance" rows={2} aria-label="Assembly guidance"
              placeholder="The display is bonded to the bezel by the supplier; the battery is a 2S pack with a JST connector." /></label>
            <div className="row"><SubmitButton pendingText="Drafting… (about a minute)">{current ? "Draft again" : "Draft assembly instructions"}</SubmitButton>
              <span className="small muted">{current ? "Replaces the current draft with a new version; approved versions stay." : "Reads Project inputs and Manufacturing routes."}</span></div>
          </form>
        </details>
      )}

      {current && d && <>
        <section className="card stack" data-testid="assembly" data-status={current.status}>
          <div className="row spread">
            <h2>{d.title} <span className="muted small">v{current.version}</span> <span className={`pill pill-${current.status === "approved" ? "approved" : "draft"}`}>{current.status}</span></h2>
            <div className="row">
              <a className="btn" href={`/projects/${projectId}/assembly/${current.id}/export?format=html`} target="_blank" rel="noreferrer">Printable instructions</a>
              <a className="btn btn-primary" href={`/projects/${projectId}/assembly/${current.id}/export`}>Download for the assembler</a>
            </div>
          </div>
          <p className="small muted">{d.steps.length} steps, about {total} min per unit · drafted with {current.model ?? "?"}{current.approved_at ? ` · approved ${new Date(current.approved_at).toLocaleDateString()}` : ""}</p>
          {problems.length > 0 && current.status === "draft" && (
            <div className="banner banner-warn small" data-testid="assembly-problems"><strong>The draft still has problems to fix:</strong><ul>{problems.map((p) => <li key={p}>{p}</li>)}</ul></div>)}
          {!!d.open_questions.length && <div className="small"><strong>Open questions for the designer:</strong><ul>{d.open_questions.map((q) => <li key={q}>{q}</li>)}</ul></div>}
          {!!d.assumptions.length && <details className="small"><summary>Assumptions</summary><ul>{d.assumptions.map((q) => <li key={q}>{q}</li>)}</ul></details>}
          <div className="grid2 small">
            <div><strong>Safety and handling</strong><ul>{d.safety.map((x) => <li key={x}>{x}</li>)}</ul></div>
            <div><strong>Tools and fixtures</strong><ul>{d.tools.map((x) => <li key={x}>{x}</li>)}</ul></div>
          </div>
          <details className="small" data-testid="assembly-bom"><summary>Parts and fasteners per unit</summary>
            <table><thead><tr><th>Qty</th><th>Item</th><th>Kind</th></tr></thead>
              <tbody>{assemblyBom(d).map((b) => <tr key={`${b.kind}${b.item}`}><td>{b.qty}</td><td>{b.item}</td><td>{b.kind}</td></tr>)}</tbody></table></details>
          {editable && (
            <details className="small"><summary>Edit title, safety, tools and final test</summary>
              <form action={saveHeader.bind(null, projectId, current.id)} className="stack">
                <label>Title<input name="title" defaultValue={d.title} aria-label="Assembly title" /></label>
                <label>Safety and handling (one per line)<textarea name="safety" rows={3} defaultValue={d.safety.join("\n")} aria-label="Safety" /></label>
                <label>Tools and fixtures (one per line)<textarea name="tools" rows={3} defaultValue={d.tools.join("\n")} aria-label="Tools" /></label>
                <label>Final functional test (one per line)<textarea name="final_test" rows={3} defaultValue={d.final_test.join("\n")} aria-label="Final test" /></label>
                <div className="row"><SubmitButton variant="secondary" pendingText="…">Save</SubmitButton></div>
              </form></details>
          )}
        </section>

        <ol className="steps-list" data-testid="steps">{d.steps.map((s, i) => (
          <li key={i} className="card stack" data-step={i + 1}>
            <div className="row spread"><h3>{i + 1}. {s.title}</h3><span className="small muted">{s.minutes} min</span></div>
            <div className="grid2">
              <div className="small">
                {!!s.parts.length && <p><strong>Parts:</strong> {s.parts.map((p) => `${p.qty} × ${p.name}`).join("; ")}</p>}
                {!!s.fasteners.length && <table data-testid="fasteners"><thead><tr><th>Qty</th><th>Fastener</th><th>Torque</th></tr></thead>
                  <tbody>{s.fasteners.map((f, k) => <tr key={k}><td>{f.qty}</td><td>{f.spec}</td><td>{f.torque_nm != null ? `${f.torque_nm} N·m` : "—"}
                    {f.torque_note && <div className="muted">{f.torque_note}</div>}</td></tr>)}</tbody></table>}
                {!!s.tools.length && <p><strong>Tools:</strong> {s.tools.join(", ")}</p>}
                <ol>{s.instructions.map((x, k) => <li key={k}>{x}</li>)}</ol>
                {!!s.cautions.length && <div className="banner banner-warn"><strong>Caution:</strong> {s.cautions.join(" ")}</div>}
                {s.check && <p><strong>Check:</strong> {s.check}</p>}
              </div>
              {s.figure && img.get(s.figure) ? <figure><img className="concept-thumb" src={img.get(s.figure)} alt={s.figure} /><figcaption className="small muted">{s.figure} {figures.find((f) => f.code === s.figure)?.title}</figcaption></figure> : <div />}
            </div>
            {editable && (
              <details className="small"><summary>Edit step {i + 1}</summary>
                <form action={saveStep.bind(null, projectId, current.id, i)} className="stack">
                  <label>Title<input name="title" defaultValue={s.title} aria-label={`Step ${i + 1} title`} /></label>
                  <div className="grid2">
                    <label>Parts (one per line, “2 × Front bezel”)<textarea name="parts" rows={3} defaultValue={partsToLines(s)} aria-label={`Step ${i + 1} parts`} /></label>
                    <label>Fasteners (“4 × M3 × 6 pan head @ 0.4 N·m (basis)”, or “@ none (pressed in)”)<textarea name="fasteners" rows={3} defaultValue={fastenersToLines(s)} aria-label={`Step ${i + 1} fasteners`} /></label>
                  </div>
                  <label>Instructions (one action per line)<textarea name="instructions" rows={4} defaultValue={s.instructions.join("\n")} aria-label={`Step ${i + 1} instructions`} /></label>
                  <div className="grid2">
                    <label>Tools (one per line)<textarea name="tools" rows={2} defaultValue={s.tools.join("\n")} aria-label={`Step ${i + 1} tools`} /></label>
                    <label>Cautions (one per line)<textarea name="cautions" rows={2} defaultValue={s.cautions.join("\n")} aria-label={`Step ${i + 1} cautions`} /></label>
                    <label>Check before the next step<input name="check" defaultValue={s.check ?? ""} aria-label={`Step ${i + 1} check`} /></label>
                    <label>Figure<select name="figure" defaultValue={s.figure ?? ""} aria-label={`Step ${i + 1} figure`}><option value="">None</option>
                      {figures.map((f) => <option key={f.code} value={f.code}>{f.code} {f.title}</option>)}</select></label>
                    <label>Minutes<input name="minutes" type="number" min={0.5} step={0.5} defaultValue={s.minutes} aria-label={`Step ${i + 1} minutes`} /></label>
                  </div>
                  <div className="row"><SubmitButton variant="secondary" pendingText="…">{`Save step ${i + 1}`}</SubmitButton></div>
                </form>
                <div className="row">
                  {i > 0 && <form action={moveStep.bind(null, projectId, current.id, i, -1)}><SubmitButton variant="secondary" pendingText="…">Move up</SubmitButton></form>}
                  {i < d.steps.length - 1 && <form action={moveStep.bind(null, projectId, current.id, i, 1)}><SubmitButton variant="secondary" pendingText="…">Move down</SubmitButton></form>}
                  <form action={deleteStep.bind(null, projectId, current.id, i)}><SubmitButton variant="secondary" pendingText="…">{`Delete step ${i + 1}`}</SubmitButton></form>
                </div>
              </details>
            )}
          </li>
        ))}</ol>
        {!!d.final_test.length && <section className="card small"><h3>Final functional test</h3><ol>{d.final_test.map((x) => <li key={x}>{x}</li>)}</ol></section>}

        <div className="row">
          {editable && <form action={addStep.bind(null, projectId, current.id)}><SubmitButton variant="secondary" pendingText="…">Add a step</SubmitButton></form>}
          {editable && <form action={recheck.bind(null, projectId, current.id)}><SubmitButton variant="secondary" pendingText="Checking…">Check again</SubmitButton></form>}
          {canApprove && current.status === "draft" && <form action={approve.bind(null, projectId, current.id)}><SubmitButton pendingText="…">Approve this version</SubmitButton></form>}
          {canEdit && current.status === "approved" && <form action={revise.bind(null, projectId, current.id)}><SubmitButton variant="secondary" pendingText="…">Start a revision</SubmitButton></form>}
        </div>
        {current.status === "draft" && !canApprove && <p className="small muted">The owner or a reviewer approves the draft; approval locks it.</p>}
      </>}

      {(versions ?? []).length > 1 && (
        <section><h2>Versions</h2><ul className="small" data-testid="versions">{(versions ?? []).map((v) => <li key={v.id}>v{v.version} · {v.status} · {new Date(v.created_at).toLocaleDateString()}
          {" · "}<a href={`/projects/${projectId}/assembly/${v.id}/export?format=html`} target="_blank" rel="noreferrer">view</a></li>)}</ul></section>
      )}
    </main>
  );
}
