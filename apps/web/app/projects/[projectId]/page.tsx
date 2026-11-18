import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Banner } from "@/components/Banner";
import { ScanBadge } from "@/components/ScanBadge";
import { SubmitButton } from "@/components/SubmitButton";
import { StagedFileInput } from "@/components/StagedFileInput";
import { requireUser } from "@/lib/auth";
import { createPlan, inviteMember, runExtraction, setRequirementStatus, uploadDocument } from "./actions";
import { confirmStandard, proposeStandard } from "@/app/knowledge/actions";
import { LicenseFlag, SourceForm } from "@/components/Knowledge";
import { APPLICABILITY, type License } from "@/lib/knowledge";

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

  const [{ data: project }, { data: docs }, { data: reqs }, { data: plans }, { data: me }, { data: runs }] = await Promise.all([
    supabase.from("projects").select("id, name, description").eq("id", projectId).maybeSingle(),
    supabase.from("documents").select("id, title, filename, storage_path, mime_type, extraction_status, extraction_report, created_at")
      .eq("project_id", projectId).order("created_at"),
    supabase.from("requirements").select("id, ref_code, kind, priority, status, text, source_section, source_page, source_excerpt, block_id, notes, document_id")
      .eq("project_id", projectId).order("ref_code"),
    supabase.from("plans").select("id, version, status, summary, created_at, generator").eq("project_id", projectId).order("version", { ascending: false }),
    supabase.from("project_members").select("role").eq("project_id", projectId).eq("user_id", userId).maybeSingle(),
    supabase.from("runs").select("id, name, status, mode, created_at, report, plans(version)").eq("project_id", projectId)
      .order("created_at", { ascending: false }).limit(10),
  ]);
  if (!project) notFound();
  // Clients work in the workspace: chat, results and approval stops, without the engineering internals.
  if (me?.role === "client") redirect(`/projects/${projectId}/workspace`);
  const isOwner = me?.role === "owner";
  const [{ data: members }, { data: invitations }, { data: projectStandards }, { data: allStandards }, { data: projectSources }] = await Promise.all([
    supabase.from("project_members").select("user_id, role").eq("project_id", projectId),
    isOwner ? supabase.from("project_invitations").select("id, email, role, created_at, accepted_at").eq("project_id", projectId).order("created_at")
            : Promise.resolve({ data: [] as never[] }),
    supabase.from("project_standards").select("id, applicability, rationale, status, confirmed_at, standards(identifier, title, edition, license, review_status)")
      .eq("project_id", projectId).order("created_at"),
    supabase.from("standards").select("id, identifier, title, domain").order("domain").order("identifier"),
    supabase.from("sources").select("id, title, identifier, publisher, license, status, indexed_chunks").eq("project_id", projectId).order("created_at"),
  ]);
  const roleCounts = Object.entries((members ?? []).reduce<Record<string, number>>((m, x) => ({ ...m, [x.role]: (m[x.role] ?? 0) + 1 }), {}));
  const { data: scans } = await supabase.from("file_scans").select("path, status, signature").eq("bucket", "project-files")
    .in("path", (docs ?? []).map((d) => d.storage_path));
  const scanOf = new Map((scans ?? []).map((x) => [x.path, x]));
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
      <p><Link href={`/projects/${projectId}/workspace`} className="btn">Open the workspace</Link>
        <span className="muted small"> Chat, results and approval stops: the view your client sees.</span>{" "}
        <Link href={`/projects/${projectId}/concepts`} className="btn">Concepts</Link>
        {me?.role && me.role !== "client" && <> <Link href={`/projects/${projectId}/rfqs`} className="btn">RFQs</Link>{" "}
          <Link href={`/projects/${projectId}/flux`} className="btn">Flux import</Link>{" "}
          <Link href={`/projects/${projectId}/optimize`} className="btn">Optimize</Link>{" "}
          <Link href={`/projects/${projectId}/dfm`} className="btn">Manufacturing fit</Link></>}{" "}
        <Link href={`/projects/${projectId}/trades`} className="btn">Trade studies</Link>{" "}
        <Link href={`/projects/${projectId}/validation`} className="btn">Validation</Link>{" "}
        <Link href={`/projects/${projectId}/compliance`} className="btn">Compliance</Link>{" "}
        <Link href={`/projects/${projectId}/releases`} className="btn">Releases</Link>{" "}
        <Link href={`/projects/${projectId}/production`} className="btn">Production</Link>{" "}
        <Link href={`/projects/${projectId}/lifecycle`} className="btn">Lifecycle</Link>{" "}
        <Link href={`/projects/${projectId}/stages`} className="btn">Stages</Link>{" "}
        <Link href={`/projects/${projectId}/risks`} className="btn">Intake and risks</Link></p>

      <section>
        <h2>1. Specification documents</h2>
        <table>
          <thead><tr><th>Document</th><th>Extraction</th><th /></tr></thead>
          <tbody>
            {(docs ?? []).map((d) => {
              const report = (d.extraction_report ?? {}) as ExtractionReport;
              return (
                <tr key={d.id}>
                  <td><strong>{d.title}</strong><div className="muted small">{d.filename} <ScanBadge status={scanOf.get(d.storage_path)?.status} signature={scanOf.get(d.storage_path)?.signature} /></div></td>
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
            <StagedFileInput name="file" bucket="project-files" prefix={`${projectId}/uploads`} accept=".docx,.pdf,.md,.txt" required ariaLabel="Specification file" />
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

      <section>
        <h2>4. Runs</h2>
        <ul className="list">
          {(runs ?? []).map((r) => (
            <li key={r.id}>
              <Link href={`/projects/${projectId}/runs/${r.id}`}><strong>{r.name || "Run"}</strong></Link>
              <span className={`pill pill-${r.status}`}>{r.status}</span>
              <span className="muted small"> plan v{(r.plans as unknown as { version: number }).version} · {r.mode} · {new Date(r.created_at).toLocaleString()}</span>
              {(r.report as { headline?: string } | null)?.headline && <div className="small">{(r.report as { headline: string }).headline}</div>}
            </li>
          ))}
          {!runs?.length && <li className="muted">No runs yet. Approve a plan, then authorize a run from the plan page.</li>}
        </ul>
      </section>

      <section>
        <h2>5. 3D model library</h2>
        <p className="small">Manufacturer STEP models for this project&apos;s parts, checked against their footprints and verified before layouts
          use them. <Link href={`/projects/${projectId}/models`}>Open the model library</Link></p>
      </section>

      <section>
        <h2>6. Standards and references</h2>
        <p className="small muted">Which standards apply to this product, and why. Engineers propose; an owner or reviewer confirms.
          The assistant and design tasks cite these. <Link href={`/knowledge?project=${projectId}`}>Search the knowledge base with this project&apos;s sources</Link></p>
        <table className="small" data-testid="project-standards">
          <thead><tr><th>Standard</th><th>Applicability</th><th>Why</th><th>Status</th></tr></thead>
          <tbody>
            {(projectStandards ?? []).map((ps) => {
              const st = ps.standards as unknown as { identifier: string; title: string; edition: string | null; license: License; review_status: string };
              return (
                <tr key={ps.id}>
                  <td><span className="mono">{st.identifier}</span> {st.title}
                    <div className="muted">{st.edition ? `edition ${st.edition}` : "edition unconfirmed"} <LicenseFlag license={st.license} /></div></td>
                  <td>{APPLICABILITY[ps.applicability]}</td>
                  <td>{ps.rationale}</td>
                  <td><span className={`pill pill-${ps.status === "confirmed" ? "complete" : "awaiting_approval"}`}>{ps.status}</span>
                    {ps.status === "proposed" && (me?.role === "owner" || me?.role === "reviewer") && (
                      <form action={confirmStandard.bind(null, projectId, ps.id)}><button className="btn btn-link" type="submit">Confirm</button></form>
                    )}</td>
                </tr>
              );
            })}
            {!projectStandards?.length && <tr><td colSpan={4} className="muted">No standards recorded for this project yet.</td></tr>}
          </tbody>
        </table>
        {canEdit && (
          <form action={proposeStandard.bind(null, projectId)} className="row upload">
            <select name="standard_id" required aria-label="Standard" defaultValue="">
              <option value="" disabled>Standard…</option>
              {(allStandards ?? []).map((s) => <option key={s.id} value={s.id}>{s.identifier} — {s.title.slice(0, 60)}</option>)}
            </select>
            <select name="applicability" aria-label="Applicability" defaultValue="applies">
              {Object.entries(APPLICABILITY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <input name="rationale" required placeholder="Why (market, product scope, a requirement)" aria-label="Why it applies" style={{ flex: 1, minWidth: 200 }} />
            <SubmitButton pendingText="Saving…">Propose</SubmitButton>
          </form>
        )}
        <h3>Project sources</h3>
        <ul className="list small" data-testid="project-sources">
          {(projectSources ?? []).map((s) => (
            <li key={s.id}><Link href={`/knowledge/sources/${s.id}`}><strong>{s.identifier ? `${s.identifier} — ` : ""}{s.title}</strong></Link>
              <span className="muted"> {s.publisher} · {s.indexed_chunks} excerpt(s)</span> <LicenseFlag license={s.license as License} />
              <span className={`pill pill-${s.status === "verified" ? "complete" : "awaiting_approval"}`}>{s.status}</span></li>
          ))}
          {!projectSources?.length && <li className="muted">Datasheets, licensed standards and NDA documents for this project only.</li>}
        </ul>
        {canEdit && <details><summary>Add a project source</summary><SourceForm projectId={projectId} heading="Add a source to this project" /></details>}
      </section>

      <section>
        <h2>7. People</h2>
        <p className="small muted">{roleCounts.map(([r, n]) => `${n} ${r}${n > 1 ? "s" : ""}`).join(" · ")}. Clients see the workspace only:
          requirements, the checklist, results and checks, and the chat. They approve or return work at approval stops, and never see
          runs, worker logs, costs or the audit trail.</p>
        {isOwner && (
          <>
            {!!invitations?.length && (
              <table className="small" data-testid="invitations">
                <thead><tr><th>Invited</th><th>Role</th><th>Status</th></tr></thead>
                <tbody>{invitations.map((i) => (
                  <tr key={i.id}><td>{i.email}</td><td>{i.role}</td><td>{i.accepted_at ? `joined ${new Date(i.accepted_at).toLocaleDateString()}` : "waiting for sign-up"}</td></tr>
                ))}</tbody>
              </table>
            )}
            <form action={inviteMember.bind(null, projectId)} className="row upload">
              <input type="email" name="email" required placeholder="name@company.com" aria-label="Email to invite" />
              <select name="role" aria-label="Role" defaultValue="client">
                <option value="client">Client</option>
                <option value="reviewer">Reviewer</option>
                <option value="engineer">Engineer</option>
                <option value="viewer">Viewer</option>
              </select>
              <SubmitButton pendingText="Inviting…">Invite</SubmitButton>
            </form>
          </>
        )}
      </section>
    </main>
  );
}
