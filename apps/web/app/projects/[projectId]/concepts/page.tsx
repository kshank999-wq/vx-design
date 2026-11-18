import Link from "next/link";
import { notFound } from "next/navigation";
import { AutoRefresh } from "@/components/AutoRefresh";
import { Banner } from "@/components/Banner";
import { SubmitButton } from "@/components/SubmitButton";
import { requireUser } from "@/lib/auth";
import { cancelConcepts, freezeDesign, requestConcepts } from "./actions";

interface Brief {
  product_summary?: string; envelope?: { length_mm: number; width_mm: number; height_mm: number; basis: string };
  constraints?: string[]; assumptions?: string[]; offline?: boolean;
}
interface Cmf { summary?: string; colours?: string[]; materials?: string[]; finishes?: string[]; design_language?: string }

const STATUS: Record<string, string> = { queued: "Queued", generating: "Generating…", ready: "Ready", partial: "Partly ready", failed: "Failed", canceled: "Canceled" };

export default async function ConceptsPage({ params, searchParams }: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ embed?: string; error?: string; notice?: string }>;
}) {
  const { projectId } = await params;
  const { embed: e, error, notice } = await searchParams;
  const embed = e === "1";
  const { supabase, userId } = await requireUser();
  const [{ data: project }, { data: me }, { data: rounds }, { data: variants }, { data: freeze }] = await Promise.all([
    supabase.from("projects").select("id, name").eq("id", projectId).maybeSingle(),
    supabase.from("project_members").select("role").eq("project_id", projectId).eq("user_id", userId).maybeSingle(),
    supabase.from("concept_rounds").select("id, round_no, direction, variant_count, parent_variant_id, status, brief, brief_model, provider, model, error, created_at")
      .eq("project_id", projectId).order("round_no", { ascending: false }).limit(30),
    supabase.from("concept_variants").select("id, round_id, ordinal, name, rationale, prompt, cmf, status, error, image_path, mime_type, provider, model, seed, revised_prompt, provider_meta")
      .eq("project_id", projectId).order("ordinal"),
    supabase.from("current_design_freeze").select("id, variant_id, envelope, cmf, note, change_reason, frozen_at").eq("project_id", projectId).maybeSingle(),
  ]);
  if (!project) notFound();
  const role = me?.role ?? "viewer";
  const canRequest = ["owner", "engineer", "client"].includes(role);
  const canFreeze = ["owner", "reviewer", "client"].includes(role);
  const urls = new Map<string, string>();
  const paths = (variants ?? []).filter((v) => v.image_path).map((v) => v.image_path!);
  if (paths.length) {
    const { data } = await supabase.storage.from("project-files").createSignedUrls(paths, 3600);
    for (const s of data ?? []) if (s.path && s.signedUrl) urls.set(s.path, s.signedUrl);
  }
  const byRound = (id: string) => (variants ?? []).filter((v) => v.round_id === id);
  const variantName = new Map((variants ?? []).map((v) => [v.id, v.name]));
  const frozen = freeze ? (variants ?? []).find((v) => v.id === freeze.variant_id) : null;
  const busy = (rounds ?? []).some((r) => r.status === "queued" || r.status === "generating");
  const hidden = embed ? <input type="hidden" name="embed" value="1" /> : null;
  const fenv = freeze?.envelope as { length_mm: number; width_mm: number; height_mm: number; basis?: string } | undefined;

  return (
    <main className={embed ? "embed" : undefined}>
      <p className="crumbs"><Link href="/projects">Projects</Link> / <Link href={`/projects/${projectId}`}>{project.name}</Link> /</p>
      <div className="row spread"><h1>Concepts</h1>{busy && <AutoRefresh intervalMs={3000} />}</div>
      <p className="banner banner-warn">Concept images are generated pictures for choosing a direction: <strong>concept, not CAD</strong>.
        Nothing in them is a dimension or a part. Engineering works to the frozen envelope and requirements; later mock-ups come from the CAD model.</p>
      <Banner error={error} notice={notice} />

      {freeze && frozen && (
        <section className="card freeze" data-testid="freeze">
          <h2>Design freeze</h2>
          <div className="row" style={{ alignItems: "flex-start" }}>
            {frozen.image_path && urls.get(frozen.image_path) && <img className="concept-thumb" src={urls.get(frozen.image_path)} alt={`Frozen concept ${frozen.name}`} />}
            <div>
              <p><strong>{frozen.name}</strong> · envelope {fenv!.length_mm} × {fenv!.width_mm} × {fenv!.height_mm} mm (L × W × H)</p>
              {(freeze.cmf as Cmf)?.summary && <p className="small">CMF: {(freeze.cmf as Cmf).summary}</p>}
              <p className="small muted">Frozen {new Date(freeze.frozen_at).toLocaleString()}{freeze.note ? ` · ${freeze.note}` : ""}
                {freeze.change_reason ? ` · changed because: ${freeze.change_reason}` : ""}</p>
              <p className="small muted">Changing it later needs a reason (change control) and is recorded as a new decision.</p>
            </div>
          </div>
        </section>
      )}

      {canRequest && (
        <form action={requestConcepts.bind(null, projectId, null)} className="card stack" data-testid="request-form">
          {hidden}
          <h2>Ask for concepts</h2>
          <label>Direction<textarea name="direction" rows={3} required maxLength={4000}
            placeholder="Look and feel, materials, colours, how it is held or mounted, products you like (described, not named)" /></label>
          <div className="row">
            <label className="inline">Variants
              <select name="count" defaultValue="3">{[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
            <SubmitButton pendingText="Requesting…">Generate concepts</SubmitButton>
          </div>
          <p className="small muted">Claude writes a brief from the requirements and your direction; an image model renders each variant.
            Image generation is paid: up to 2 rounds at a time and 12 a day per project.</p>
        </form>
      )}

      {(rounds ?? []).map((r) => {
        const brief = (r.brief ?? {}) as Brief;
        const vs = byRound(r.id);
        return (
          <section key={r.id} className="round" data-testid={`round-${r.round_no}`}>
            <div className="row spread">
              <h2>Round {r.round_no}{r.parent_variant_id && <span className="muted small"> · refining “{variantName.get(r.parent_variant_id) ?? "earlier variant"}”</span>}</h2>
              <span className={`pill pill-${r.status === "ready" ? "complete" : r.status === "failed" ? "failed" : "awaiting_approval"}`} data-testid="round-status">{STATUS[r.status]}</span>
            </div>
            <p className="small"><strong>Direction:</strong> {r.direction}</p>
            {r.status === "queued" && canRequest && (
              <form action={cancelConcepts.bind(null, projectId, r.id)}>{hidden}<button className="btn btn-link" type="submit">Cancel</button></form>
            )}
            {r.error && <p className="small error-text">{r.error}</p>}
            {brief.offline && <p className="small warn-text">Offline stand-in brief (not AI): the variants are fixed examples, not derived from your requirements.</p>}
            {brief.envelope && (
              <details className="small"><summary>Brief: envelope about {brief.envelope.length_mm} × {brief.envelope.width_mm} × {brief.envelope.height_mm} mm</summary>
                {brief.product_summary && <p>{brief.product_summary}</p>}
                <p>Envelope basis: {brief.envelope.basis}</p>
                {!!brief.constraints?.length && <><strong>Constraints from the requirements</strong><ul>{brief.constraints.map((c, i) => <li key={i}>{c}</li>)}</ul></>}
                {!!brief.assumptions?.length && <><strong>Assumptions</strong><ul>{brief.assumptions.map((c, i) => <li key={i}>{c}</li>)}</ul></>}
                <p className="muted">Brief by {r.brief_model}; images by {r.provider} {r.model}.</p>
              </details>
            )}
            <div className="concepts">
              {vs.map((v) => {
                const cmf = (v.cmf ?? {}) as Cmf;
                const meta = (v.provider_meta ?? {}) as { placeholder?: boolean; references?: string[]; reference_note?: string; watermark?: string };
                const isFrozen = freeze?.variant_id === v.id;
                return (
                  <article key={v.id} className={`concept card${isFrozen ? " frozen" : ""}`} data-testid="variant" data-name={v.name}>
                    <div className="concept-img">
                      {v.status === "ready" && v.image_path && urls.get(v.image_path)
                        ? <a href={urls.get(v.image_path)} target="_blank" rel="noreferrer"><img src={urls.get(v.image_path)} alt={`Concept ${v.name}`} /></a>
                        : <div className="concept-missing small">{v.error ?? "No image"}</div>}
                      <span className="concept-label">concept, not CAD</span>
                    </div>
                    <h3>{v.name}{isFrozen && <span className="pill pill-complete">frozen</span>}</h3>
                    {cmf.summary && <p className="small"><strong>CMF:</strong> {cmf.summary}</p>}
                    {cmf.design_language && <p className="small muted">{cmf.design_language}</p>}
                    {v.rationale && <p className="small">{v.rationale}</p>}
                    {meta.placeholder && <p className="small warn-text">Offline placeholder, not a generated image.</p>}
                    <details className="small"><summary>Provenance</summary>
                      <p><strong>Prompt:</strong> {v.prompt}</p>
                      {v.revised_prompt && <p><strong>Provider rewrote it:</strong> {v.revised_prompt}</p>}
                      <p>{v.provider} · {v.model}{v.seed ? ` · seed ${v.seed}` : ""}{meta.watermark ? ` · ${meta.watermark}` : ""}</p>
                      {!!meta.references?.length && <p>Reference: {meta.references.join(", ")}</p>}
                      {meta.reference_note && <p className="warn-text">{meta.reference_note}</p>}
                    </details>
                    {v.status === "ready" && canRequest && (
                      <details className="small"><summary>Refine this</summary>
                        <form action={requestConcepts.bind(null, projectId, v.id)} className="stack">
                          {hidden}
                          <textarea name="direction" rows={2} required placeholder="What to keep, what to change" aria-label={`How to refine ${v.name}`} />
                          <div className="row"><select name="count" defaultValue="2" aria-label="Variants">{[1, 2, 3, 4].map((n) => <option key={n}>{n}</option>)}</select>
                            <SubmitButton pendingText="Requesting…">Refine</SubmitButton></div>
                        </form>
                      </details>
                    )}
                    {v.status === "ready" && canFreeze && !isFrozen && (
                      <details className="small"><summary>Freeze this design</summary>
                        <form action={freezeDesign.bind(null, projectId, v.id)} className="stack">
                          {hidden}
                          <div className="row tight">
                            <label>L mm<input name="length_mm" type="number" step="0.1" min="1" required defaultValue={brief.envelope?.length_mm} aria-label={`Length of ${v.name}`} /></label>
                            <label>W mm<input name="width_mm" type="number" step="0.1" min="1" required defaultValue={brief.envelope?.width_mm} aria-label={`Width of ${v.name}`} /></label>
                            <label>H mm<input name="height_mm" type="number" step="0.1" min="1" required defaultValue={brief.envelope?.height_mm} aria-label={`Height of ${v.name}`} /></label>
                          </div>
                          <input name="cmf" defaultValue={cmf.summary ?? ""} aria-label="Colours, materials and finish" />
                          <input name="note" placeholder="Note (optional)" aria-label="Note" />
                          {freeze && <input name="change_reason" required placeholder="Why change the frozen design?" aria-label="Reason for the change" />}
                          <SubmitButton pendingText="Freezing…">{freeze ? "Change the freeze to this" : "Freeze this design"}</SubmitButton>
                        </form>
                      </details>
                    )}
                  </article>
                );
              })}
              {!vs.length && (r.status === "queued" || r.status === "generating") &&
                <p className="muted small">Writing the brief and generating {r.variant_count} image(s)…</p>}
            </div>
          </section>
        );
      })}
      {!rounds?.length && <p className="muted">No concepts yet.{canRequest ? " Describe a direction above to get the first round." : ""}</p>}
    </main>
  );
}
