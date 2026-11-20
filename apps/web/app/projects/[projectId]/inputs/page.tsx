import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Banner } from "@/components/Banner";
import { FluxUpload } from "@/components/FluxUpload";
import { InputsUpload } from "@/components/InputsUpload";
import { SubmitButton } from "@/components/SubmitButton";
import { requireUser } from "@/lib/auth";
import { crossDocumentDuplicates } from "@/lib/documents";
import { IMAGE_TYPES, loadPlanInputs, refCode, REFERENCE_KINDS } from "@/lib/plan-inputs";
import { createPlan, runExtraction } from "../actions";
import { extractAll, removeReference, setAuditInPlan, updateReference } from "./actions";
import { createAudit, runAudit } from "../flux/actions";

export const maxDuration = 300;

const kindLabel = (k: string) => REFERENCE_KINDS.find(([x]) => x === k)?.[1] ?? k;

/** Everything a plan is built from, in one place, and the plan built from it. */
export default async function InputsPage({ params, searchParams }: {
  params: Promise<{ projectId: string }>; searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const { projectId } = await params;
  const { error, notice } = await searchParams;
  const { supabase, userId } = await requireUser();
  const [{ data: project }, { data: me }, { data: docs }, { data: reqs }, { data: refs }, { data: audits }, { data: intake }, { data: freeze },
         { count: standards }, { count: sources }, { data: plans }] = await Promise.all([
    supabase.from("projects").select("name").eq("id", projectId).maybeSingle(),
    supabase.from("project_members").select("role").eq("project_id", projectId).eq("user_id", userId).maybeSingle(),
    supabase.from("documents").select("id, title, filename, extraction_status, extraction_report").eq("project_id", projectId).order("created_at"),
    supabase.from("requirements").select("id, ref_code, text, status, document_id").eq("project_id", projectId).order("ref_code"),
    supabase.from("project_references").select("*").eq("project_id", projectId).order("ref_no"),
    supabase.from("flux_audits").select("id, audit_no, title, status, summary, use_in_plan, completed_at, error, flux_audit_files(count)").eq("project_id", projectId).order("audit_no"),
    supabase.from("project_intake").select("intended_use, quantity, max_dimensions").eq("project_id", projectId).maybeSingle(),
    supabase.from("current_design_freeze").select("frozen_at").eq("project_id", projectId).maybeSingle(),
    supabase.from("project_standards").select("id", { count: "exact", head: true }).eq("project_id", projectId).eq("status", "confirmed"),
    supabase.from("sources").select("id", { count: "exact", head: true }).eq("project_id", projectId),
    supabase.from("plans").select("id, version, status, inputs, created_at").eq("project_id", projectId).order("version", { ascending: false }).limit(3),
  ]);
  if (!project) notFound();
  if (me?.role === "client") redirect(`/projects/${projectId}/workspace`);
  const canEdit = me?.role === "owner" || me?.role === "engineer";
  const reqCount = (id: string) => (reqs ?? []).filter((r) => r.document_id === id && r.status !== "rejected").length;
  const pending = (docs ?? []).filter((d) => d.extraction_status === "pending" || d.extraction_status === "failed");
  const active = (reqs ?? []).filter((r) => r.status !== "rejected");
  const dups = crossDocumentDuplicates(reqs ?? []);
  const docTitle = new Map((docs ?? []).map((d) => [d.id, d.title]));
  const images = (refs ?? []).filter((r) => IMAGE_TYPES.includes(r.mime_type ?? ""));
  const { data: signed } = images.length ? await supabase.storage.from("project-files").createSignedUrls(images.map((r) => r.storage_path), 3600) : { data: [] };
  const url = new Map<string, string>((signed ?? []).filter((s) => s.path && s.signedUrl).map((s) => [s.path!, s.signedUrl!]));
  const { data: files } = (refs ?? []).length ? await supabase.storage.from("project-files").createSignedUrls((refs ?? []).map((r) => r.storage_path), 3600, { download: true }) : { data: [] };
  const dl = new Map<string, string>((files ?? []).filter((s) => s.path && s.signedUrl).map((s) => [s.path!, s.signedUrl!]));
  const loaded = await loadPlanInputs(supabase, projectId);

  return (
    <main>
      <p className="crumbs"><Link href="/projects">Projects</Link> / <Link href={`/projects/${projectId}`}>{project.name}</Link> /</p>
      <h1>Project inputs</h1>
      <p className="muted">Everything the plan is built from: the specifications, mock-ups and references, and work already done in other tools.
        The plan cites these by their codes (REF-1, PW-1) and says for each task whether it reuses earlier work, adapts it or starts fresh,
        so nothing that exists is done again. Imported work is never treated as verified: the plan includes the checks that re-establish it.</p>
      <Banner error={error} notice={notice} />

      <section>
        <h2>1. Specifications</h2>
        <table className="small" data-testid="specs">
          <thead><tr><th>Document</th><th>Requirements</th><th /></tr></thead>
          <tbody>{(docs ?? []).map((d) => {
            const report = (d.extraction_report ?? {}) as { error?: string; model?: string };
            return <tr key={d.id} data-doc={d.filename} data-status={d.extraction_status}>
              <td><strong>{d.title}</strong><div className="muted">{d.filename}</div></td>
              <td><span className={`pill pill-${d.extraction_status}`}>{d.extraction_status}</span>{d.extraction_status === "done" && <> {reqCount(d.id)} requirement(s)</>}
                {report.error && <div className="error-text">{report.error}</div>}</td>
              <td className="right">{canEdit && d.extraction_status !== "pending" && d.extraction_status !== "running" && (
                <form action={runExtraction.bind(null, projectId, d.id, "inputs")}><SubmitButton variant="secondary" pendingText="Extracting…">Re-extract</SubmitButton></form>)}</td>
            </tr>;
          })}{!docs?.length && <tr><td colSpan={3} className="muted">No specifications yet. Add every spec you have: one per board, the enclosure, the software.</td></tr>}</tbody>
        </table>
        {canEdit && <>
          <InputsUpload projectId={projectId} mode="specification" />
          {pending.length > 0 && (
            <form action={extractAll.bind(null, projectId)} className="row">
              <SubmitButton pendingText="Reading the documents… (a few minutes)">{`Extract requirements from ${pending.length} document(s)`}</SubmitButton>
              <span className="small muted">The documents are read at the same time; requirement numbers continue across them.</span>
            </form>
          )}
        </>}
        {dups.length > 0 && (
          <details className="card small" open data-testid="duplicates">
            <summary>{dups.length} requirement(s) appear in more than one document</summary>
            <p className="muted">Nearly the same words in different specifications. Reject one of each pair on the <Link href={`/projects/${projectId}`}>requirements list</Link>, or keep both if they differ.</p>
            <ul>{dups.slice(0, 20).map(([a, b, score]) => <li key={`${a.id}-${b.id}`}><strong>{a.ref_code}</strong> ({docTitle.get(a.document_id!)}) and <strong>{b.ref_code}</strong> ({docTitle.get(b.document_id!)}), {Math.round(score * 100)}% the same: “{a.text}”</li>)}</ul>
          </details>
        )}
      </section>

      <section>
        <h2>2. Mock-ups and references</h2>
        <p className="small muted">Sketches, renders, photos of a prototype, drawings, datasheets, and files from other tools or another engineer (a KiCad
          project, a BOM spreadsheet, a schematic PDF: choose “Prior design”). Say in the note what each one shows and what to keep. Images can also be
          given to a concept round as references.</p>
        <div className="ref-grid" data-testid="references">{(refs ?? []).map((r) => (
          <div key={r.id} className="card small" data-ref={refCode(r.ref_no)}>
            {url.get(r.storage_path) ? <a href={url.get(r.storage_path)} target="_blank" rel="noreferrer"><img className="concept-thumb" src={url.get(r.storage_path)} alt={r.title} /></a>
              : <p className="muted">{r.filename}</p>}
            <p><strong>{refCode(r.ref_no)}</strong> {r.title} <span className="pill">{kindLabel(r.kind)}</span>{!r.use_in_plan && <span className="pill">not in the plan</span>}</p>
            {r.note && <p>{r.note}</p>}
            <p className="muted">{r.filename}{dl.get(r.storage_path) && <> · <a href={dl.get(r.storage_path)}>download</a></>}</p>
            {canEdit && (
              <details><summary>Edit</summary>
                <form action={updateReference.bind(null, projectId, r.id)} className="stack">
                  <label>Title<input name="title" defaultValue={r.title} required aria-label={`Title ${refCode(r.ref_no)}`} /></label>
                  <label>Kind<select name="kind" defaultValue={r.kind} aria-label={`Kind ${refCode(r.ref_no)}`}>{REFERENCE_KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
                  <label>Note<textarea name="note" rows={3} defaultValue={r.note ?? ""} aria-label={`Note ${refCode(r.ref_no)}`} /></label>
                  <label className="inline"><input type="checkbox" name="use_in_plan" defaultChecked={r.use_in_plan} aria-label={`Use ${refCode(r.ref_no)} in the plan`} /> Use in the plan</label>
                  <div className="row"><SubmitButton variant="secondary" pendingText="…">Save</SubmitButton></div>
                </form>
                <form action={removeReference.bind(null, projectId, r.id)}><SubmitButton variant="secondary" pendingText="…">Remove</SubmitButton></form>
              </details>
            )}
          </div>
        ))}{!refs?.length && <p className="muted">None yet.</p>}</div>
        {canEdit && <InputsUpload projectId={projectId} mode="reference" kinds={REFERENCE_KINDS} />}
      </section>

      <section>
        <h2>3. Prior work</h2>
        <p className="small muted">Designs already started elsewhere. Add a Flux project's exported files here (or on the <Link href={`/projects/${projectId}/flux`}>Flux import</Link> page)
          and run the audit: its parts, board, design notes, earlier decisions and open problems become prior work the plan builds on.</p>
        <table className="small" data-testid="prior-work">
          <thead><tr><th>Audit</th><th>Status</th><th>Found</th><th>In the plan</th></tr></thead>
          <tbody>{(audits ?? []).map((a) => {
            const s = (a.summary ?? {}) as { components?: number; blockers?: number; warnings?: number };
            return <tr key={a.id} data-audit={a.audit_no}>
              <td><Link href={`/projects/${projectId}/flux/${a.id}`}>Flux audit #{a.audit_no}</Link> {a.title}</td>
              <td>{a.status}</td>
              <td>{a.status === "ready" ? `${s.components ?? 0} parts, ${s.blockers ?? 0} blocker(s), ${s.warnings ?? 0} warning(s)` : "—"}</td>
              <td>{a.status !== "ready" ? <span className="muted">audit not run yet</span> : <>{a.use_in_plan ? "yes" : "no"}
                {canEdit && <form action={setAuditInPlan.bind(null, projectId, a.id, !a.use_in_plan)} style={{ display: "inline" }}>
                  {" "}<SubmitButton variant="secondary" pendingText="…">{a.use_in_plan ? "Leave out" : "Use"}</SubmitButton></form>}</>}</td>
            </tr>;
          })}{!audits?.length && <tr><td colSpan={4} className="muted">No imports yet.</td></tr>}</tbody>
        </table>
        {canEdit && (() => {
          const open = (audits ?? []).filter((a) => a.status === "draft" || a.status === "failed").at(-1);
          const running = (audits ?? []).some((a) => a.status === "queued" || a.status === "running");
          if (running) return <p className="small muted" data-testid="flux-running">A worker is reading a Flux import; it appears above when the audit is ready. Reload to check.</p>;
          if (!open) return (
            <form action={createAudit.bind(null, projectId)} className="card row" data-testid="flux-start">
              <input type="hidden" name="from" value="inputs" />
              <label className="inline">Import from Flux<input name="title" required defaultValue={project.name} aria-label="Flux import title" /></label>
              <SubmitButton variant="secondary" pendingText="…">Start a Flux import</SubmitButton>
              <span className="small muted">Then add every file Flux exports (ZIPs included) and run the audit.</span>
            </form>
          );
          const n = Number((open.flux_audit_files as unknown as { count: number }[] | null)?.[0]?.count ?? 0);
          return (
            <div className="card stack" data-testid="flux-open">
              <p className="small"><strong>Flux import #{open.audit_no}</strong> {open.title}: {n} file(s) added.
                {open.status === "failed" && open.error && <span className="error-text"> The last audit failed: {open.error}</span>}{" "}
                <Link href={`/projects/${projectId}/flux/${open.id}`}>See the files</Link></p>
              <FluxUpload projectId={projectId} auditId={open.id} revisions={[]} />
              {n > 0 && (
                <form action={runAudit.bind(null, projectId, open.id, "inputs")} className="row">
                  <SubmitButton pendingText="Requesting…">Run the audit</SubmitButton>
                  <span className="small muted">A worker reads every file; the import then appears above as prior work.</span>
                </form>
              )}
            </div>
          );
        })()}
      </section>

      <section>
        <h2>4. Other inputs</h2>
        <ul className="small" data-testid="other-inputs">
          <li>Intake: {intake?.intended_use || intake?.quantity || intake?.max_dimensions ? "filled in" : "not filled in"} · <Link href={`/projects/${projectId}/wizard`}>requirement wizard</Link> · <Link href={`/projects/${projectId}/risks`}>intake and risks</Link></li>
          <li>Design freeze: {freeze ? `frozen ${new Date(freeze.frozen_at).toLocaleDateString()}` : "none yet"} · <Link href={`/projects/${projectId}/concepts`}>concepts</Link></li>
          <li>Standards confirmed: {standards ?? 0} · reference documents in the knowledge base: {sources ?? 0} · <Link href={`/projects/${projectId}`}>project page</Link></li>
        </ul>
      </section>

      <section className="card">
        <h2>5. The plan</h2>
        <p className="small">{active.length} requirement(s) from {(docs ?? []).length} document(s){loaded.sources.length ? `; builds on ${loaded.sources.map((s) => s.id).join(", ")}` : "; no references or prior work to build on"}.</p>
        <details className="small" data-testid="plan-context"><summary>What the planner reads</summary><pre className="doc">{loaded.context}</pre></details>
        {canEdit && (
          <form action={createPlan.bind(null, projectId, "inputs")} className="row">
            <SubmitButton disabled={!active.length} pendingText="Planning… (a minute or two)">Generate plan from these inputs</SubmitButton>
            {!active.length && <span className="small muted">Extract requirements first.</span>}
          </form>
        )}
        {!!plans?.length && <ul className="small">{plans.map((p) => <li key={p.id}><Link href={`/projects/${projectId}/plans/${p.id}`}>Plan v{p.version}</Link> · {p.status}
          {(p.inputs as unknown[]).length ? ` · built on ${(p.inputs as { id: string }[]).map((x) => x.id).join(", ")}` : ""}</li>)}</ul>}
      </section>
    </main>
  );
}
