import Link from "next/link";
import { notFound } from "next/navigation";
import { Banner } from "@/components/Banner";
import { SubmitButton } from "@/components/SubmitButton";
import { requireUser } from "@/lib/auth";
import { READING_MODELS } from "@/lib/model";
import { compareModels, setReadingModel } from "./actions";

export const maxDuration = 300;

/** Which model reads specifications and datasheets, and comparisons of models on one specification. */
export default async function ComparePage({ params, searchParams }: { params: Promise<{ projectId: string }>; searchParams: Promise<{ error?: string; notice?: string }> }) {
  const { projectId } = await params;
  const { error, notice } = await searchParams;
  const { supabase, userId } = await requireUser();
  const [{ data: project }, { data: me }, { data: docs }, { data: past }] = await Promise.all([
    supabase.from("projects").select("name, reading_model").eq("id", projectId).maybeSingle(),
    supabase.from("project_members").select("role").eq("project_id", projectId).eq("user_id", userId).maybeSingle(),
    supabase.from("documents").select("id, title, filename, extraction_status").eq("project_id", projectId).eq("extraction_status", "done").order("created_at"),
    supabase.from("model_comparisons").select("id, created_at, results").eq("project_id", projectId).order("created_at", { ascending: false }).limit(20),
  ]);
  if (!project || !me || me.role === "client") notFound();
  const canEdit = me.role === "owner" || me.role === "engineer";
  const { data: counts } = await supabase.from("requirements").select("document_id").eq("project_id", projectId).eq("origin", "extracted");
  const n = (id: string) => (counts ?? []).filter((c) => c.document_id === id).length;

  return (
    <main>
      <p className="crumbs"><Link href="/projects">Projects</Link> / <Link href={`/projects/${projectId}`}>{project.name}</Link> / <Link href={`/projects/${projectId}/usage`}>AI usage</Link> /</p>
      <h1>Reading model</h1>
      <p className="muted">The model that reads specifications into requirements and identifies parts from datasheets (when the parts catalog and the
        distributors do not know them). Planning keeps its own model. Compare cheaper models on one of your specifications before switching.</p>
      <Banner error={error} notice={notice} />

      <section className="card">
        <h2>This project reads with</h2>
        <form action={setReadingModel.bind(null, projectId)} className="row" data-testid="reading-model">
          <select name="reading_model" defaultValue={project.reading_model ?? ""} aria-label="Reading model" disabled={!canEdit}>
            <option value="">Default (Claude Opus 5.5)</option>
            {READING_MODELS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select>
          {canEdit && <SubmitButton variant="secondary" pendingText="Saving…">Save</SubmitButton>}
        </form>
      </section>

      {canEdit && (
        <section className="card">
          <h2>Compare models on a specification</h2>
          <p className="small muted">Each model reads the specification again; nothing is saved as requirements. The results are set against the requirements
            already read from it. A smaller specification is quicker (the page waits up to five minutes).</p>
          <form action={compareModels.bind(null, projectId)} className="stack" data-testid="compare-form">
            <label>Specification<select name="document" required aria-label="Specification to compare on">
              {(docs ?? []).map((d) => <option key={d.id} value={d.id}>{d.title} ({d.filename}, {n(d.id)} requirements)</option>)}</select></label>
            <fieldset className="row"><legend className="small">Models</legend>
              {READING_MODELS.map(([id, label]) => (
                <label key={id} className="inline small"><input type="checkbox" name="model" value={id} defaultChecked={id !== "claude-opus-5-5"} aria-label={`Compare ${label.split(" (")[0]}`} /> {label}</label>
              ))}</fieldset>
            <div><SubmitButton pendingText="Reading with each model… (a minute or a few)">Compare</SubmitButton></div>
          </form>
        </section>
      )}

      <section>
        <h2>Comparisons</h2>
        <ul className="list small" data-testid="comparisons">{(past ?? []).map((c) => {
          const r = c.results as { document: string; models: Record<string, { requirements: unknown[]; cost_usd: number }> };
          return <li key={c.id}><Link href={`/projects/${projectId}/compare/${c.id}`}>{r.document}</Link> · {new Date(c.created_at).toLocaleString()} ·{" "}
            {Object.entries(r.models).map(([m, x]) => `${m.replace("claude-", "")}: ${x.requirements.length}`).join(", ")}</li>;
        })}{!past?.length && <li className="muted">None yet.</li>}</ul>
      </section>
    </main>
  );
}
