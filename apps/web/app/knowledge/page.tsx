import Link from "next/link";
import { Banner } from "@/components/Banner";
import { HitList, LicenseFlag, SourceForm } from "@/components/Knowledge";
import { SubmitButton } from "@/components/SubmitButton";
import { requireUser } from "@/lib/auth";
import { searchKnowledge, type KnowledgeHit, type License } from "@/lib/knowledge";
import { reviewStandard } from "./actions";

export default async function KnowledgePage({ searchParams }: {
  searchParams: Promise<{ q?: string; project?: string; error?: string; notice?: string }>;
}) {
  const { q = "", project = "", error, notice } = await searchParams;
  const { supabase, userId } = await requireUser();
  const [{ data: projects }, { data: editor }, { data: standards }, { data: library }] = await Promise.all([
    supabase.from("projects").select("id, name").order("name"),
    supabase.from("knowledge_editors").select("user_id").eq("user_id", userId).maybeSingle(),
    supabase.from("standards").select("id, identifier, title, issuing_body, domain, region, edition, edition_note, license, publisher_url, review_status, reviewed_at, notes")
      .order("domain").order("identifier"),
    supabase.from("sources").select("id, kind, title, identifier, publisher, edition, license, status, indexed_chunks, official_url")
      .is("project_id", null).neq("status", "withdrawn").order("created_at", { ascending: false }).limit(100),
  ]);
  const projectId = (projects ?? []).some((p) => p.id === project) ? project : null;
  let hits: KnowledgeHit[] = [];
  let searchError: string | null = null;
  if (q.trim()) {
    try { hits = await searchKnowledge(supabase, q, projectId, 20); } catch (e) { searchError = (e as Error).message; }
  }
  const domains = [...new Set((standards ?? []).map((s) => s.domain))];
  const isEditor = !!editor;

  return (
    <main>
      <p className="crumbs"><Link href="/projects">Projects</Link> /</p>
      <h1>Knowledge base</h1>
      <p className="muted">Standards, regulations, datasheets and application notes, each with its official link, edition and licence.
        Text is held only where the licence allows it; everything else is a pointer to the official copy.
        {" "}<Link href="/knowledge/modules">Modules catalog</Link> (radio modules, SoMs, dev boards).</p>
      <Banner error={error ?? searchError ?? undefined} notice={notice} />

      <form className="row card" role="search">
        <input name="q" defaultValue={q} placeholder="IPC 2152, battery charging temperature, guard ring…" aria-label="Search" style={{ flex: 1, minWidth: 220 }} />
        <select name="project" defaultValue={projectId ?? ""} aria-label="Include a project's private sources">
          <option value="">Shared library only</option>
          {(projects ?? []).map((p) => <option key={p.id} value={p.id}>Shared + {p.name}</option>)}
        </select>
        <button className="btn btn-primary" type="submit">Search</button>
      </form>
      {q.trim() && <section><h2>Results</h2><HitList hits={hits} /></section>}

      <section id="standards">
        <h2>Standards registry</h2>
        <p className="small muted">Starting references, not proof of applicability. Which ones apply is decided per project, with a reason, and
          confirmed by an owner or reviewer. Editions stay unconfirmed until a knowledge editor checks them with the issuing body.</p>
        {domains.map((d) => (
          <details key={d} className="card" open={domains.length <= 3}>
            <summary><strong>{d}</strong> <span className="muted small">({(standards ?? []).filter((s) => s.domain === d).length})</span></summary>
            <table className="small">
              <thead><tr><th>Identifier</th><th>Title</th><th>Edition</th><th>Licence</th><th>Review</th></tr></thead>
              <tbody>
                {(standards ?? []).filter((s) => s.domain === d).map((s) => (
                  <tr key={s.id} data-standard={s.identifier}>
                    <td className="mono">{s.publisher_url ? <a href={s.publisher_url} target="_blank" rel="noreferrer">{s.identifier}</a> : s.identifier}
                      <div className="muted">{s.issuing_body}{s.region?.length ? ` · ${s.region.join(", ")}` : ""}</div></td>
                    <td>{s.title}{s.notes && <div className="muted">{s.notes}</div>}</td>
                    <td>{s.edition ?? <span className="warn-text">unconfirmed</span>}{s.edition_note && <div className="muted">{s.edition_note}</div>}</td>
                    <td><LicenseFlag license={s.license as License} /></td>
                    <td>{s.review_status === "reviewed" ? `reviewed ${new Date(s.reviewed_at!).toLocaleDateString()}` : s.review_status}
                      {isEditor && (
                        <details><summary>Review</summary>
                          <form action={reviewStandard.bind(null, s.id)} className="stack">
                            <input name="edition" placeholder="Edition, as published" defaultValue={s.edition ?? ""} aria-label={`Edition of ${s.identifier}`} />
                            <input name="edition_note" placeholder="How it was confirmed" aria-label={`How the edition of ${s.identifier} was confirmed`} />
                            <select name="status" defaultValue="reviewed" aria-label="Review status"><option value="reviewed">Reviewed</option><option value="superseded">Superseded</option></select>
                            <SubmitButton pendingText="Saving…">Save review</SubmitButton>
                          </form>
                        </details>
                      )}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        ))}
      </section>

      <section>
        <h2>Shared library</h2>
        <ul className="list small">
          {(library ?? []).map((s) => (
            <li key={s.id}>
              <Link href={`/knowledge/sources/${s.id}`}><strong>{s.identifier ? `${s.identifier} — ` : ""}{s.title}</strong></Link>
              <span className="muted"> {s.publisher}{s.edition ? `, ${s.edition}` : ""} · {s.indexed_chunks} excerpt(s)</span>
              <LicenseFlag license={s.license as License} />
              <span className={`pill pill-${s.status === "verified" ? "complete" : "awaiting_approval"}`}>{s.status}</span>
            </li>
          ))}
          {!library?.length && <li className="muted">Nothing in the shared library yet.</li>}
        </ul>
        {isEditor
          ? <SourceForm projectId={null} heading="Add to the shared library" />
          : <p className="small muted">Knowledge editors curate the shared library. Licensed copies and project datasheets are added on the project page and stay with that project.</p>}
      </section>
    </main>
  );
}
