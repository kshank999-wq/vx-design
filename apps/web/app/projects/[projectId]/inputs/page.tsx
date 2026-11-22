import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { AutoRefresh } from "@/components/AutoRefresh";
import { Banner } from "@/components/Banner";
import { FluxUpload } from "@/components/FluxUpload";
import { InputsUpload } from "@/components/InputsUpload";
import { activePlanRequest, PlanRequestStatus } from "@/components/PlanRequestStatus";
import { SubmitButton } from "@/components/SubmitButton";
import { requireUser } from "@/lib/auth";
import { crossDocumentDuplicates } from "@/lib/documents";
import { SUBSYSTEMS, subsystemLabel, type RegisterItem } from "@vx/planning";
import { IMAGE_TYPES, ITEM_STATUS_LABEL, loadPlanInputs, PART_STATUS, refCode, REFERENCE_KINDS, VISUAL_KINDS } from "@/lib/plan-inputs";
import { createPlan, runExtraction } from "../actions";
import { PlanChangesNotice } from "@/components/PlanChangesNotice";
import { placePartFile, readPackagesAsParts, readPartFiles } from "./actions";
import { editRegisterItem, extractAll, removePart, removeReference, requestRegister, savePart, setAuditInPlan, updateReference } from "./actions";
import { createAudit, runAudit } from "../flux/actions";

export const maxDuration = 300;

const kindLabel = (k: string) => REFERENCE_KINDS.find(([x]) => x === k)?.[1] ?? k;
const partStatusLabel = (k: string) => PART_STATUS.find(([x]) => x === k)?.[1] ?? k;
const NOT_VISUAL = ["prior_design", "datasheet", "model_3d"];
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const INPUT_STEPS = [
  { title: "Specifications", sub: "Specs and requirements" }, { title: "Mock-ups", sub: "How it should look" },
  { title: "Parts chosen", sub: "Datasheets, STEP models" }, { title: "Prior work", sub: "Flux, files, earlier work" },
  { title: "Plan", sub: "Other inputs, generate" },
];
const DOCS_SHOWN = 8;

/** Everything a plan is built from, in one place, and the plan built from it. */
export default async function InputsPage({ params, searchParams }: {
  params: Promise<{ projectId: string }>; searchParams: Promise<{ error?: string; notice?: string; step?: string; docs?: string }>;
}) {
  const { projectId } = await params;
  const sp = await searchParams;
  const { error, notice } = sp;
  const step = Math.min(5, Math.max(1, Number(sp.step) || 1));
  const { supabase, userId } = await requireUser();
  const [{ data: project }, { data: me }, { data: docs }, { data: reqs }, { data: refs }, { data: audits }, { data: intake }, { data: freeze },
         { count: standards }, { count: sources }, { data: plans }, { data: parts }, { data: registers }] = await Promise.all([
    supabase.from("projects").select("name, reading_model").eq("id", projectId).maybeSingle(),
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
    supabase.from("project_parts").select("*").eq("project_id", projectId).order("created_at"),
    supabase.from("prior_work_registers").select("id, status, items, sources, edits, progress, error, model, created_at, completed_at")
      .eq("project_id", projectId).order("created_at", { ascending: false }).limit(5),
  ]);
  if (!project) notFound();
  if (me?.role === "client") redirect(`/projects/${projectId}/workspace`);
  const canEdit = me?.role === "owner" || me?.role === "engineer";
  const planBuilding = await activePlanRequest(supabase, projectId);
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
  const visual = (refs ?? []).filter((r) => !r.part_id && !NOT_VISUAL.includes(r.kind));
  // Unattached datasheets and models are part files (placed on the Parts screen); prior work is files from other tools.
  const priorFiles = (refs ?? []).filter((r) => !r.part_id && r.kind === "prior_design");
  const filesOf = (partId: string) => (refs ?? []).filter((r) => r.part_id === partId);
  const partFile = (r: NonNullable<typeof refs>[number]) => !r.part_id && ["datasheet", "model_3d"].includes(r.kind);
  const unread = (refs ?? []).filter((r) => partFile(r) && !r.identified_at);
  const packages = (refs ?? []).filter((r) => !r.part_id && ["other", "datasheet", "prior_design"].includes(r.kind) && /\.zip$/i.test(r.filename));
  const unplaced = (refs ?? []).filter((r) => partFile(r) && r.identified_at);
  const building = (registers ?? []).find((r) => r.status === "queued" || r.status === "running");
  const lastFailed = (registers ?? [])[0]?.status === "failed" ? (registers ?? [])[0] : null;
  const ready = (registers ?? []).find((r) => r.status === "ready");
  const regItems = (ready?.items ?? []) as RegisterItem[];
  const regEdits = (ready?.edits ?? {}) as Record<string, { status?: string; note?: string; excluded?: boolean }>;
  const regSources = (ready?.sources ?? []) as { file: string; origin: string; chars: number; items: number; note?: string }[];
  const lastPlanAt = plans?.[0]?.created_at;
  const registerNewer = ready?.completed_at && (!lastPlanAt || new Date(ready.completed_at) > new Date(lastPlanAt));
  const partsChangedSince = ready?.completed_at && (parts ?? []).some((p) => new Date(p.updated_at) > new Date(ready.completed_at!));

  const stepDone = [(docs ?? []).length > 0 && active.length > 0, visual.length > 0, (parts ?? []).length > 0,
    (audits ?? []).some((a) => a.status === "ready") || priorFiles.length > 0 || !!ready, (plans ?? []).length > 0];
  const summary = [
    { label: "Specifications", text: `${(docs ?? []).length} document(s) · ${active.length} requirement(s)`, done: stepDone[0]! },
    { label: "Mock-ups", text: `${visual.length} reference(s)`, done: stepDone[1]! },
    { label: "Parts chosen", text: `${(parts ?? []).length} part(s)`, done: stepDone[2]! },
    { label: "Prior work", text: `${(audits ?? []).filter((a) => a.status === "ready").length} Flux import(s) · ${priorFiles.length} file(s)${ready ? ` · ${regItems.length} earlier-work item(s)` : ""}`, done: stepDone[3]! },
    { label: "Plan", text: plans?.length ? `v${plans[0]!.version} · ${plans[0]!.status}` : "not generated yet", done: stepDone[4]! },
  ];

  const refCard = (r: NonNullable<typeof refs>[number]) => (
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
  );
  const partFields = (p?: NonNullable<typeof parts>[number]) => {
    const tag = p ? ` ${p.mpn}` : "";
    return <div className="grid2">
      <label>Part number<input name="mpn" required defaultValue={p?.mpn ?? ""} aria-label={`Part number${tag}`} placeholder="RVT101HVHNWC00-B" /></label>
      <label>Manufacturer<input name="manufacturer" defaultValue={p?.manufacturer ?? ""} aria-label={`Manufacturer${tag}`} placeholder="Riverdi" /></label>
      <label className="span2">What it is for<input name="role" required defaultValue={p?.role ?? ""} aria-label={`What it is for${tag}`} placeholder="10.1-inch front touchscreen" /></label>
      <label>Subsystem<select name="subsystem" defaultValue={p?.subsystem ?? "other"} aria-label={`Subsystem${tag}`}>{SUBSYSTEMS.map((x) => <option key={x} value={x}>{cap(subsystemLabel(x))}</option>)}</select></label>
      <label>How far it got<select name="status" defaultValue={p?.status ?? "selected"} aria-label={`Status${tag}`}>{PART_STATUS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
      <label className="span2">Note (why it was chosen, samples, problems)<textarea name="note" rows={2} defaultValue={p?.note ?? ""} aria-label={`Part note${tag}`} /></label>
    </div>;
  };

  return (
    <main className="setup">
      <p className="crumbs"><Link href="/projects">Projects</Link> / <Link href={`/projects/${projectId}`}>{project.name}</Link> /</p>
      <div className="title-row"><h1>Project inputs</h1>
        {((audits ?? []).some((a) => a.status === "queued" || a.status === "running") || (docs ?? []).some((d) => d.extraction_status === "running")) && !building && <AutoRefresh intervalMs={3000} />}</div>
      <Banner error={error} notice={notice} />
      <PlanRequestStatus supabase={supabase} projectId={projectId} />
      <div className="setup-grid">
        <nav className="card setup-rail" aria-label="Input steps" data-testid="input-steps">
          <h2 className="eyebrow">Inputs</h2>
          {INPUT_STEPS.map((x, k) => (
            <Link key={x.title} href={`/projects/${projectId}/inputs?step=${k + 1}`} className={`setup-step${k + 1 === step ? " active" : ""}${stepDone[k] ? " done" : ""}`}
              aria-current={k + 1 === step ? "step" : undefined}>
              <span className="step-num">{stepDone[k] && k + 1 !== step ? "✓" : String(k + 1).padStart(2, "0")}</span>
              <span><strong>{x.title}</strong><small>{x.sub}</small></span>
            </Link>
          ))}
          <p className="small muted setup-hint">The plan cites these by their codes (REF-1, PW-1, PR-1) and says for each task whether it reuses earlier work, adapts it,
            replaces it or starts fresh. Imported work is never treated as verified.</p>
        </nav>
        <div className="card setup-main" data-testid="input-step" data-step={step}>
          <p className="eyebrow tech">Step {String(step).padStart(2, "0")} / 05</p>
      {step === 1 && <>
      <section>
        <h2 className="setup-title">Specifications</h2>
        <p className="small muted" data-testid="reading-with">Read by rules where a sentence is clear, otherwise by {(project as { reading_model?: string | null })?.reading_model?.replace("claude-", "Claude ").replace(/-(\d)-(\d)$/, " $1.$2").replace(/ (\w)/, (m) => m.toUpperCase()) ?? "Claude Opus 5.5"}.{" "}
          <Link href={`/projects/${projectId}/compare`}>Change or compare models</Link></p>
        <table className="small" data-testid="specs">
          <thead><tr><th>Document</th><th>Requirements</th><th /></tr></thead>
          <tbody>{(docs ?? []).slice(0, sp.docs === "all" ? undefined : DOCS_SHOWN).map((d) => {
            const report = (d.extraction_report ?? {}) as { error?: string; model?: string; sources?: { reused: number; rules: number; ai: number } | null };
            const how = report.sources ? [report.sources.rules && `${report.sources.rules} by rules`, report.sources.reused && `${report.sources.reused} reused`, report.sources.ai && `${report.sources.ai} by AI`].filter(Boolean).join(" · ") : "";
            return <tr key={d.id} data-doc={d.filename} data-status={d.extraction_status}>
              <td><strong>{d.title}</strong><div className="muted">{d.filename}</div></td>
              <td><span className={`pill pill-${d.extraction_status}`}>{d.extraction_status}</span>{d.extraction_status === "done" && <> {reqCount(d.id)} requirement(s){how && <div className="muted small" data-testid="read-by">{how}</div>}</>}
                {report.error && <div className="error-text">{report.error}</div>}</td>
              <td className="right">{canEdit && d.extraction_status !== "pending" && d.extraction_status !== "running" && (
                <form action={runExtraction.bind(null, projectId, d.id, "inputs")}><SubmitButton variant="secondary" pendingText="Extracting…">Re-extract</SubmitButton></form>)}</td>
            </tr>;
          })}{!docs?.length && <tr><td colSpan={3} className="muted">No specifications yet. Add every spec you have: one per board, the enclosure, the software.</td></tr>}</tbody>
        </table>
        {(docs ?? []).length > DOCS_SHOWN && sp.docs !== "all" && <p><Link className="btn" href={`/projects/${projectId}/inputs?step=1&docs=all`}>{`Show all ${(docs ?? []).length} documents`}</Link></p>}
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

      </>}

      {step === 2 && <>
      <section>
        <h2 className="setup-title">Mock-ups and references</h2>
        <p className="small muted">How the product should look: sketches, renders, photos of a prototype or a product you like, dimensioned drawings. Say in the
          note what each one shows and what to keep. Images can also be given to a concept round. Part datasheets and 3D models go under 3, files from
          other tools or engineers under 4.</p>
        <div className="ref-grid" data-testid="references">{visual.map(refCard)}{!visual.length && <p className="muted">None yet.</p>}</div>
        {canEdit && <InputsUpload projectId={projectId} mode="reference" kinds={VISUAL_KINDS} />}
      </section>

      </>}

      {step === 3 && <>
      <section>
        <h2 className="setup-title">Parts already chosen</h2>
        <p className="small muted">Upload the manufacturer datasheets (PDF) and the 3D or CAD files (STEP, STL, IGES) of the parts already picked. Each
          datasheet is read for the part number, manufacturer, what the part is and its key specifications, and becomes a part; each model is
          matched to its part by the part number inside it or in its file name. A manufacturer&apos;s ZIP package can go in as it is: it is opened
          and its datasheets and models are read. Check the result and set how far each part got. The plan must continue, adapt or replace each one.</p>
        {canEdit && packages.length > 0 && (
          <form action={readPackagesAsParts.bind(null, projectId)} className="card notice-changes" data-testid="packages-elsewhere">
            <strong>{packages.length} ZIP package(s) were added as references, not as parts:</strong>
            <span className="small"> {packages.map((r) => r.filename).join(", ")}.</span>
            <div className="row"><SubmitButton pendingText="Opening and reading… (a minute or two)">Read them as parts</SubmitButton>
              <span className="small muted">Each is opened; its datasheets and 3D models become part files and are read; the ZIP itself is removed.</span></div>
          </form>
        )}
        {canEdit && <div className="card dropzone" data-testid="part-files"><InputsUpload projectId={projectId} mode="partfiles" /></div>}
        {canEdit && unread.length > 0 && (
          <form action={readPartFiles.bind(null, projectId)} className="row" data-testid="read-part-files">
            <SubmitButton pendingText="Reading…">Read the files</SubmitButton><span className="small muted">{unread.length} file(s) not read yet.</span></form>
        )}
        {unplaced.length > 0 && (
          <div className="card small" data-testid="unplaced-files">
            <strong>Files to place ({unplaced.length})</strong>
            <ul className="plain">{unplaced.map((f) => (
              <li key={f.id} className="unplaced" data-file={f.filename}>
                <span className="pill">{kindLabel(f.kind)}</span> {dl.get(f.storage_path) ? <a href={dl.get(f.storage_path)}>{f.filename}</a> : f.filename}
                {f.identify_note && <span className="warn-text"> · {f.identify_note}</span>}
                {canEdit && (
                  <form action={placePartFile.bind(null, projectId, f.id)} className="row tight">
                    {!!parts?.length && <select name="part_id" defaultValue="" aria-label={`Part for ${f.filename}`}><option value="">{f.kind === "datasheet" ? "New part…" : "Which part?"}</option>
                      {(parts ?? []).map((p) => <option key={p.id} value={p.id}>{p.mpn}</option>)}</select>}
                    {f.kind === "datasheet" && <input name="mpn" placeholder="or type its part number" aria-label={`Part number for ${f.filename}`} />}
                    <SubmitButton variant="secondary" pendingText="…">Place</SubmitButton>
                  </form>
                )}
              </li>))}</ul>
          </div>
        )}
        {SUBSYSTEMS.filter((sub) => (parts ?? []).some((p) => p.subsystem === sub)).map((sub) => (
          <div key={sub} data-testid={`parts-${sub}`}>
            <h3 className="small">{cap(subsystemLabel(sub))}</h3>
            <table className="small">
              <thead><tr><th>Part</th><th>What it is for</th><th>Status</th><th>Files</th></tr></thead>
              <tbody>{(parts ?? []).filter((p) => p.subsystem === sub).map((p) => (
                <tr key={p.id} data-part={p.mpn}>
                  <td><strong className="mono">{p.mpn}</strong>{p.manufacturer && <div className="muted">{p.manufacturer}</div>}</td>
                  <td>{p.role}{p.note && <div className="muted">{p.note}</div>}
                    {((p.specs ?? []) as { name: string; value: string }[]).length > 0 && (
                      <details className="specs"><summary className="muted">{((p.specs ?? []) as unknown[]).length} key specs</summary>
                        <dl className="facts">{((p.specs ?? []) as { name: string; value: string }[]).flatMap((x, k) => [<dt key={`n${k}`}>{x.name}</dt>, <dd key={`v${k}`}>{x.value}</dd>])}</dl></details>)}</td>
                  <td><span className={`pill pill-${p.status === "rejected" ? "rejected" : p.status === "candidate" ? "draft" : "complete"}`}>{partStatusLabel(p.status)}</span></td>
                  <td>
                    <ul className="plain">{filesOf(p.id).map((f) => <li key={f.id}><span className="pill">{kindLabel(f.kind)}</span>{" "}
                      {dl.get(f.storage_path) ? <a href={dl.get(f.storage_path)}>{f.filename}</a> : f.filename}</li>)}
                      {!filesOf(p.id).length && <li className="muted">no files yet</li>}</ul>
                    {canEdit && (
                      <details><summary>Attach files or edit</summary>
                        <InputsUpload projectId={projectId} mode="part" partId={p.id} partLabel={p.mpn} />
                        <form action={savePart.bind(null, projectId, p.id)} className="stack">
                          {partFields(p)}
                          <div className="row"><SubmitButton variant="secondary" pendingText="…">Save part</SubmitButton></div>
                        </form>
                        <form action={removePart.bind(null, projectId, p.id)}><SubmitButton variant="secondary" pendingText="…">{`Remove ${p.mpn}`}</SubmitButton></form>
                      </details>
                    )}
                  </td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        ))}
        {!parts?.length && <p className="muted" data-testid="parts-none">No parts yet: upload their datasheets above.</p>}
        {canEdit && (
          <details className="card" data-testid="add-part">
            <summary>Add a part by hand (no datasheet)</summary>
            <form action={savePart.bind(null, projectId, null)} className="stack">
              {partFields()}
              <div className="row"><SubmitButton pendingText="Adding…">Add part</SubmitButton>
                <span className="small muted">Then attach its datasheet and STEP model from its row.</span></div>
            </form>
          </details>
        )}
      </section>

      </>}

      {step === 4 && <>
      <section>
        <h2 className="setup-title">Prior work</h2>
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
          if (running) return <p className="small muted" data-testid="flux-running">A worker is reading a Flux import. This page updates by itself; the import appears above when the audit is ready.</p>;
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

        <h3>Files from other tools or engineers</h3>
        <p className="small muted">A KiCad or Altium project, a schematic or layout PDF, a BOM spreadsheet, design notes, a power budget, test reports. Say where
          each came from and how far it got.</p>
        <div className="ref-grid" data-testid="prior-files">{priorFiles.map(refCard)}{!priorFiles.length && <p className="muted">None yet.</p>}</div>
        {canEdit && <InputsUpload projectId={projectId} mode="prior" />}

        <div className="card stack" data-testid="register">
          <h3>What was already done</h3>
          <p className="small muted">A worker reads every earlier design document in full (the documents inside the Flux imports used for the plan, the files
            above and the parts' datasheets) and lists each part and design decision with how far it got, quoting the document it came from. Correct
            anything it got wrong: your corrections are kept when the list is rebuilt. The plan must say for each selected, designed, laid-out or verified
            item whether it continues with it, adapts it or replaces it.</p>
          {building ? (
            <p className="banner banner-notice" data-testid="register-building" data-status={building.status}>
              {building.status === "queued" ? "Waiting for a worker…" : `Reading the earlier work: ${building.progress ?? "starting"}.`} This page updates by itself.
              <AutoRefresh intervalMs={5000} /></p>
          ) : canEdit && (
            <form action={requestRegister.bind(null, projectId)} className="row">
              <SubmitButton variant={ready ? "secondary" : "primary"} pendingText="Requesting…">{ready ? "Rebuild the list" : "Build the list of earlier work"}</SubmitButton>
              <span className="small muted">Takes 5 to 20 minutes depending on how many documents there are. Claude reads each document once; the tokens are added to
                the project&apos;s costs. Rebuild after adding parts or files.</span>
            </form>
          )}
          {lastFailed && !building && <p className="error-text small" data-testid="register-failed">The last build failed: {lastFailed.error}</p>}
          {ready && <>
            <p className="small" data-testid="register-summary">
              {regItems.length} item(s) from {regSources.filter((x) => x.chars > 0).length} document(s), built {new Date(ready.completed_at!).toLocaleString()}
              {" · "}{loaded.mustAddress.filter((m) => m.id.startsWith("PR-")).length} the plan must address
              {Object.values(regEdits).some((e) => e.excluded) && <> · {Object.values(regEdits).filter((e) => e.excluded).length} left out</>}
              {partsChangedSince && <span className="warn-text"> · parts changed since: rebuild to include them</span>}
              {registerNewer && plans?.length ? <span className="warn-text"> · newer than the latest plan: generate the plan again to use it</span> : null}</p>
            {SUBSYSTEMS.filter((sub) => regItems.some((i) => i.subsystem === sub)).map((sub) => (
              <details key={sub} className="small" open={regItems.length <= 30} data-testid={`register-${sub}`}>
                <summary><strong>{cap(subsystemLabel(sub))}</strong> ({regItems.filter((i) => i.subsystem === sub).length})</summary>
                <table className="small">
                  <thead><tr><th>Item</th><th>Status</th><th>What</th><th>From</th></tr></thead>
                  <tbody>{regItems.filter((i) => i.subsystem === sub).map((i) => {
                    const e = regEdits[i.id] ?? {};
                    const st = e.status ?? i.status;
                    return <tr key={i.id} data-item={i.id} data-status={st} className={e.excluded ? "muted" : ""}>
                      <td className="mono">{i.id}</td>
                      <td><span className={`pill pill-${st === "rejected" ? "rejected" : st === "open" ? "open" : st === "considered" ? "draft" : "complete"}`}>{ITEM_STATUS_LABEL[st] ?? st}</span>
                        {e.status && <div className="muted">corrected</div>}{e.excluded && <div>left out</div>}</td>
                      <td><strong>{i.mpn ? `${i.mpn} ` : ""}{i.title}</strong>{i.manufacturer && <span className="muted"> ({i.manufacturer})</span>}
                        <div>{i.detail}</div>
                        {i.issues.length > 0 && <div className="warn-text">Issues: {i.issues.join("; ")}</div>}
                        {e.note && <div><strong>Your note:</strong> {e.note}</div>}
                        {canEdit && (
                          <details><summary>Correct</summary>
                            <form action={editRegisterItem.bind(null, projectId, ready.id, i.id)} className="stack">
                              <label>Status<select name="status" defaultValue={e.status ?? ""} aria-label={`Status ${i.id}`}>
                                <option value="">{`As found (${ITEM_STATUS_LABEL[i.status] ?? i.status})`}</option>
                                {Object.entries(ITEM_STATUS_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
                              <label>Note for the plan<textarea name="note" rows={2} defaultValue={e.note ?? ""} aria-label={`Note ${i.id}`} /></label>
                              <label className="inline"><input type="checkbox" name="excluded" defaultChecked={!!e.excluded} aria-label={`Leave out ${i.id}`} /> Leave out (wrong or irrelevant)</label>
                              <div className="row"><SubmitButton variant="secondary" pendingText="…">{`Save ${i.id}`}</SubmitButton></div>
                            </form>
                          </details>
                        )}</td>
                      <td>{i.sources.slice(0, 4).map((x, k) => <div key={k} title={x.quote}>{x.file}{x.origin !== "owner" && <span className="muted"> ({x.origin})</span>}</div>)}
                        {i.sources.length > 4 && <div className="muted">and {i.sources.length - 4} more</div>}</td>
                    </tr>;
                  })}</tbody>
                </table>
              </details>
            ))}
            {regSources.length > 0 && (
              <details className="small" data-testid="register-sources"><summary>Documents read ({regSources.length})</summary>
                <ul>{regSources.map((x, k) => <li key={k}>{x.file} <span className="muted">({x.origin})</span>: {x.note ?? `${x.items} item(s)`}</li>)}</ul>
              </details>
            )}
          </>}
        </div>
      </section>

      </>}

      {step === 5 && <>
      <section>
        <h2>Other inputs</h2>
        <ul className="small" data-testid="other-inputs">
          <li>Intake: {intake?.intended_use || intake?.quantity || intake?.max_dimensions ? "filled in" : "not filled in"} · <Link href={`/projects/${projectId}/wizard`}>requirement wizard</Link> · <Link href={`/projects/${projectId}/risks`}>intake and risks</Link></li>
          <li>Design freeze: {freeze ? `frozen ${new Date(freeze.frozen_at).toLocaleDateString()}` : "none yet"} · <Link href={`/projects/${projectId}/concepts`}>concepts</Link></li>
          <li>Standards confirmed: {standards ?? 0} · reference documents in the knowledge base: {sources ?? 0} · <Link href={`/projects/${projectId}`}>project page</Link></li>
        </ul>
      </section>

      <section>
        <h2>The plan</h2>
        <p className="small">{active.length} requirement(s) from {(docs ?? []).length} document(s){loaded.sources.length ? `; builds on ${loaded.sources.map((s) => s.id).join(", ")}` : "; no references or prior work to build on"}{loaded.register ? `; ${loaded.register.items.length} earlier-work item(s), ${loaded.mustAddress.filter((m) => m.id.startsWith("PR-")).length} of which the plan must address` : ""}{loaded.inputs.parts?.length ? `; ${loaded.inputs.parts.length} chosen part(s), each to be used by a task` : ""}.</p>
        <PlanChangesNotice changes={loaded.changes} canEdit={canEdit} building={!!planBuilding} action={createPlan.bind(null, projectId, "inputs", "revise")} fresh={createPlan.bind(null, projectId, "inputs", "fresh")} />
        <details className="small" data-testid="plan-context"><summary>What the planner reads</summary><pre className="doc">{loaded.context}</pre></details>
        {canEdit && !planBuilding && !loaded.changes?.items.length && (
          <form action={createPlan.bind(null, projectId, "inputs", plans?.length ? "fresh" : undefined)} className="row">
            <SubmitButton variant={plans?.length ? "secondary" : undefined} disabled={!active.length} pendingText="Starting…">{plans?.length ? "Rebuild the plan from scratch" : "Generate plan from these inputs"}</SubmitButton>
            {!active.length && <span className="small muted">Extract requirements first.</span>}
          </form>
        )}
        {!!plans?.length && <ul className="small">{plans.map((p) => <li key={p.id}><Link href={`/projects/${projectId}/plans/${p.id}`}>Plan v{p.version}</Link> · {p.status}
          {(p.inputs as unknown[]).length ? ` · built on ${(p.inputs as { id: string }[]).map((x) => x.id).join(", ")}` : ""}</li>)}</ul>}
      </section>
      </>}
          <div className="setup-actions">
            {step > 1 ? <Link className="btn" href={`/projects/${projectId}/inputs?step=${step - 1}`}>← Back</Link> : <span />}
            {step < 5 && <Link className="btn btn-primary" href={`/projects/${projectId}/inputs?step=${step + 1}`}>{`Continue: ${INPUT_STEPS[step]!.title} →`}</Link>}
          </div>
        </div>
        <aside className="setup-side">
          <div className="card" data-testid="inputs-summary">
            <h2 className="eyebrow">The plan builds on</h2>
            <ul className="manifest">{summary.map((m) => <li key={m.label} className={m.done ? "done" : ""}><span className="mdot" /><span><strong>{m.label}</strong><small>{m.text}</small></span></li>)}</ul>
          </div>
        </aside>
      </div>
    </main>
  );
}
