import Link from "next/link";
import { notFound } from "next/navigation";
import { Banner } from "@/components/Banner";
import { SubmitButton } from "@/components/SubmitButton";
import { requireUser } from "@/lib/auth";
import { createPlan, runExtraction, setRequirementStatus, uploadDocument } from "./actions";

export const maxDuration = 300;

interface ExtractionReport {
  model?: string;
  offline?: boolean;
  requirements?: number;
  dropped?: { statement: string; reason: string }[];
  open_questions?: { question: string; blockId: string | null }[];
  error?: string;
}

const STATUS_LABEL: Record<string, string> = {
  draft: "Draft", awaiting_approval: "Awaiting approval", approved: "Approved baseline", superseded: "Superseded",
};

export default async function ProjectPage({ params, searchParams }: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const { projectId } = await params;
  const { error, notice } = await searchParams;
  const { supabase, userId } = await requireUser();

  const [{ data: project }, { data: docs }, { data: reqs }, { data: plans }, { data: me }] = await Promise.all([
    supabase.from("projects").select("id, name, description").eq("id", projectId).maybeSingle(),
    supabase.from("documents").select("id, title, filename, mime_type, extraction_status, extraction_report, created_at")
      .eq("project_id", projectId).order("created_at"),
    supabase.from("requirements").select("id, ref_code, kind, priority, status, text, source_section, source_page, source_excerpt, block_id, notes, document_id")
      .eq("project_id", projectId).order("ref_code"),
    supabase.from("plans").select("id, version, status, summary, created_at, generator").eq("project_id", projectId).order("version", { ascending: false }),
    supabase.from("project_members").select("role").eq("project_id", projectId).eq("user_id", userId).maybeSingle(),
  ]);
  if (!project) notFound();
  const canEdit = me?.role === "owner" || me?.role === "engineer";
  const docTitle = new Map((docs ?? []).map((d) => [d.id, d.title]));
  const counts = { total: reqs?.length ?? 0, rejected: reqs?.filter((r) => r.status === "rejected").length ?? 0,
    ambiguous: reqs?.filter((r) => r.status === "ambiguous").length ?? 0, confirmed: reqs?.filter((r) => r.status === "confirmed").length ?? 0 };

  return (
    <main>
      <p className="crumbs"><Link href="/projects">Projects</Link> /</p>
      <h1>{project.name}</h1>
      {project.description && <p className="muted">{project.description}</p>}
      <Banner error={error} notice={notice} />

      <section>
        <h2>1. Specification documents</h2>
        <table>
          <thead><tr><th>Document</th><th>Extraction</th><th /></tr></thead>
          <tbody>
            {(docs ?? []).map((d) => {
              const report = (d.extraction_report ?? {}) as ExtractionReport;
              return (
                <tr key={d.id}>
                  <td><strong>{d.title}</strong><div className="muted small">{d.filename}</div></td>
                  <td>
                    <span className={`pill pill-${d.extraction_status}`}>{d.extraction_status}</span>
                    {d.extraction_status === "done" && (
                      <div className="small muted">
                        {report.requirements} requirements · {report.model}
                        {report.dropped?.length ? ` · ${report.dropped.length} dropped (citation not verifiable)` : ""}
                      </div>
                    )}
                    {report.error && <div className="small error-text">{report.error}</div>}
                  </td>
                  <td className="right">
                    {canEdit && (
                      <form action={runExtraction.bind(null, projectId, d.id)}>
                        <SubmitButton variant="secondary" pendingText="Extracting… (can take a few minutes)">
                          {d.extraction_status === "pending" ? "Extract requirements" : "Re-extract"}
                        </SubmitButton>
                      </form>
                    )}
                  </td>
                </tr>
              );
            })}
            {!docs?.length && <tr><td colSpan={3} className="muted">Upload the product specification to begin.</td></tr>}
          </tbody>
        </table>
        {canEdit && (
          <form action={uploadDocument.bind(null, projectId)} className="row upload">
            <input type="file" name="file" accept=".docx,.pdf,.md,.txt" required aria-label="Specification file" />
            <SubmitButton pendingText="Uploading…">Upload</SubmitButton>
          </form>
        )}
        {(docs ?? []).flatMap((d) => ((d.extraction_report ?? {}) as ExtractionReport).open_questions ?? []).length > 0 && (
          <details className="card">
            <summary>Open questions raised during extraction</summary>
            <ul>{(docs ?? []).flatMap((d) => (((d.extraction_report ?? {}) as ExtractionReport).open_questions ?? [])
              .map((q, i) => <li key={`${d.id}-${i}`}>{q.question}{q.blockId && <span className="muted small"> [{q.blockId}]</span>}</li>))}</ul>
          </details>
        )}
      </section>

      <section>
        <h2>2. Requirements</h2>
        <p className="muted small">
          {counts.total} total · {counts.confirmed} confirmed · {counts.ambiguous} ambiguous · {counts.rejected} rejected.
          Every requirement links to the exact text it came from.
        </p>
        <table className="reqs">
          <thead><tr><th>Ref</th><th>Requirement</th><th>Source</th><th>Status</th></tr></thead>
          <tbody>
            {(reqs ?? []).map((r) => (
              <tr key={r.id} className={r.status === "rejected" ? "rejected" : ""}>
                <td className="mono">{r.ref_code}<div className="muted small">{r.kind} · {r.priority}</div></td>
                <td>{r.text}{r.notes && <div className="small warn-text">Open: {r.notes}</div>}</td>
                <td className="small">
                  <details>
                    <summary>{docTitle.get(r.document_id)} § {r.source_section}{r.source_page ? `, p.${r.source_page}` : ""}</summary>
                    <blockquote>{r.source_excerpt}</blockquote>
                    <span className="muted mono">{r.block_id}</span>
                  </details>
                </td>
                <td>
                  <span className={`pill pill-${r.status}`}>{r.status}</span>
                  {canEdit && (
                    <div className="row tight">
                      {r.status !== "confirmed" && (
                        <form action={setRequirementStatus.bind(null, projectId, r.id, "confirmed")}>
                          <button className="btn btn-link" type="submit">Confirm</button>
                        </form>
                      )}
                      {r.status !== "rejected" && (
                        <form action={setRequirementStatus.bind(null, projectId, r.id, "rejected")}>
                          <button className="btn btn-link" type="submit">Reject</button>
                        </form>
                      )}
                    </div>
                  )}
                </td>
              </tr>
            ))}
            {!reqs?.length && <tr><td colSpan={4} className="muted">No requirements yet.</td></tr>}
          </tbody>
        </table>
      </section>

      <section>
        <h2>3. Plans</h2>
        <ul className="list">
          {(plans ?? []).map((p) => (
            <li key={p.id}>
              <Link href={`/projects/${projectId}/plans/${p.id}`}><strong>Plan v{p.version}</strong></Link>
              <span className={`pill pill-${p.status}`}>{STATUS_LABEL[p.status] ?? p.status}</span>
              <span className="muted small"> {(p.generator as { model?: string })?.model}</span>
              {p.summary && <div className="muted small">{p.summary}</div>}
            </li>
          ))}
          {!plans?.length && <li className="muted">No plans yet.</li>}
        </ul>
        {canEdit && (
          <form action={createPlan.bind(null, projectId)}>
            <SubmitButton disabled={counts.total - counts.rejected === 0} pendingText="Generating plan… (can take a few minutes)">
              Generate plan from requirements
            </SubmitButton>
          </form>
        )}
      </section>
    </main>
  );
}
