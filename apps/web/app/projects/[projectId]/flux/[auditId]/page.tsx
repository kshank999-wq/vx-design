import Link from "next/link";
import { notFound } from "next/navigation";
import { KIND_LABEL, type AuditReport, type FileKind } from "@vx/flux";
import { AutoRefresh } from "@/components/AutoRefresh";
import { Banner } from "@/components/Banner";
import { FluxUpload } from "@/components/FluxUpload";
import { ScanBadge } from "@/components/ScanBadge";
import { SubmitButton } from "@/components/SubmitButton";
import { requireUser } from "@/lib/auth";
import { removeFile, runAudit } from "../actions";

const SEV_PILL: Record<string, string> = { blocker: "failed", warning: "awaiting_approval", info: "" };
const mb = (n: number) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const short = (p: string) => p.split("!/").pop()!;

export default async function FluxAuditPage({ params, searchParams }: {
  params: Promise<{ projectId: string; auditId: string }>; searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const { projectId, auditId } = await params;
  const { error, notice } = await searchParams;
  const { supabase, userId } = await requireUser();
  const [{ data: audit }, { data: files }, { data: me }, { data: project }] = await Promise.all([
    supabase.from("flux_audits").select("*").eq("id", auditId).eq("project_id", projectId).maybeSingle(),
    supabase.from("flux_audit_files").select("id, revision_label, revision_date, name, storage_path, sha256, size_bytes, created_at").eq("audit_id", auditId).order("created_at"),
    supabase.from("project_members").select("role").eq("project_id", projectId).eq("user_id", userId).maybeSingle(),
    supabase.from("projects").select("name").eq("id", projectId).maybeSingle(),
  ]);
  if (!audit || !project) notFound();
  const canEdit = me?.role === "owner" || me?.role === "engineer";
  const { data: scans } = await supabase.from("file_scans").select("path, status, signature").eq("bucket", "project-files")
    .in("path", (files ?? []).map((f) => f.storage_path));
  const scanOf = new Map((scans ?? []).map((x) => [x.path, x]));
  const running = audit.status === "queued" || audit.status === "running";
  let report: AuditReport | null = null;
  const links: { md?: string; json?: string } = {};
  if (audit.status === "ready" && audit.report_path) {
    const { data } = await supabase.storage.from("project-files").download(audit.report_path);
    if (data) report = JSON.parse(await data.text()) as AuditReport;
    const signed = await supabase.storage.from("project-files").createSignedUrls([audit.report_md_path!, audit.report_path], 600);
    links.md = signed.data?.[0]?.signedUrl ?? undefined;
    links.json = signed.data?.[1]?.signedUrl ?? undefined;
  }
  const revs = [...new Set((files ?? []).map((f) => f.revision_label))];
  const cur = report?.current;

  return (
    <main>
      <p className="crumbs"><Link href="/projects">Projects</Link> / <Link href={`/projects/${projectId}`}>{project.name}</Link> / <Link href={`/projects/${projectId}/flux`}>Flux imports</Link> /</p>
      <div className="row spread"><h1>#{audit.audit_no} {audit.title}</h1>{running && <AutoRefresh intervalMs={2500} />}</div>
      <p><span className={`pill big pill-${audit.status === "ready" ? "complete" : audit.status === "failed" ? "failed" : "awaiting_approval"}`} data-testid="audit-status">{audit.status}</span></p>
      <Banner error={error} notice={notice} />
      {audit.error && <p className="banner banner-error">The audit failed: {audit.error}</p>}

      <section>
        <h2>Uploaded files</h2>
        <table data-testid="flux-files" className="small">
          <thead><tr><th>Revision</th><th>File</th><th>Size</th><th>sha256</th><th>Virus scan</th><th></th></tr></thead>
          <tbody>
            {(files ?? []).map((f) => (
              <tr key={f.id}><td>{f.revision_label}{f.revision_date && <div className="muted">{f.revision_date}</div>}</td><td>{f.name}</td><td>{mb(f.size_bytes)}</td>
                <td><code>{f.sha256.slice(0, 16)}</code></td><td><ScanBadge status={scanOf.get(f.storage_path)?.status} signature={scanOf.get(f.storage_path)?.signature} /></td>
                <td>{canEdit && !running && <form action={removeFile.bind(null, projectId, auditId, f.id)}><button className="btn btn-link" type="submit">Remove</button></form>}</td></tr>
            ))}
            {!files?.length && <tr><td colSpan={6} className="muted">Nothing uploaded yet.</td></tr>}
          </tbody>
        </table>
        {canEdit && !running && <FluxUpload projectId={projectId} auditId={auditId} revisions={revs} />}
        {canEdit && !running && !!files?.length && (
          <form action={runAudit.bind(null, projectId, auditId)} className="row">
            <SubmitButton pendingText="Requesting…">{audit.status === "ready" || audit.status === "failed" ? "Run the audit again" : "Run the audit"}</SubmitButton>
            <span className="small muted">Reads every file, checks the exports against each other and across revisions, and extracts earlier decisions and test claims.</span>
          </form>
        )}
        {running && <p className="small muted">A worker is reading the files…</p>}
      </section>

      {report && (
        <>
          <p className="banner banner-warn" data-testid="statement">{report.statement}</p>
          <div className="tiles" data-testid="summary">
            <div className="tile"><strong>{report.summary.blockers}</strong><span className="small">blocker(s)</span></div>
            <div className="tile"><strong>{report.summary.warnings}</strong><span className="small">warning(s)</span></div>
            <div className="tile"><strong>{report.summary.consistent} / {report.summary.components}</strong><span className="small">parts consistent across the exports</span></div>
            <div className="tile"><strong>{report.summary.claims_unverifiable} / {report.summary.claims}</strong><span className="small">claimed validations unverifiable</span></div>
            <div className="tile"><strong>{report.migration.length}</strong><span className="small">migration tasks</span></div>
          </div>
          <p className="small">Report: {links.md && <a href={links.md}>Markdown</a>} · {links.json && <a href={links.json}>JSON</a>} · sha256 <code>{audit.report_sha256?.slice(0, 16)}</code>
            {audit.history_model && <> · history read by {audit.history_model}{report.history.offline && !/not AI/.test(audit.history_model) ? " (offline stand-in, not AI)" : ""}</>}</p>

          <h2>Findings</h2>
          <ol className="list" data-testid="findings">
            {report.findings.map((f) => (
              <li key={f.id} data-severity={f.severity}>
                <span className={`pill pill-${SEV_PILL[f.severity]}`}>{f.severity}</span> <strong>{f.id} {f.title}</strong>{f.revision && <span className="muted small"> · {f.revision}</span>}
                {f.detail && <div className="small">{f.detail}</div>}
                {!!f.items?.length && <ul className="small">{f.items.slice(0, 50).map((i) => <li key={i}>{i}</li>)}{f.items.length > 50 && <li className="muted">… {f.items.length - 50} more</li>}</ul>}
                {!!f.evidence.length && <div className="small muted">Evidence: {f.evidence.map(short).join(", ")}</div>}
              </li>
            ))}
          </ol>

          <h2>Migration plan</h2>
          <table data-testid="migration" className="small">
            <thead><tr><th>#</th><th>Task</th><th>Discipline</th><th>Effort</th><th>Done when</th><th>Resolves</th></tr></thead>
            <tbody>{report.migration.map((m) => (
              <tr key={m.id}><td>{m.id}</td><td><strong>{m.title}</strong><div>{m.scope}</div></td><td>{m.discipline}</td><td>{m.effort}</td><td>{m.done_when}</td><td>{m.findings.join(", ") || "—"}</td></tr>
            ))}</tbody>
          </table>

          {cur && (
            <>
              <h2>Current state ({cur.revision})</h2>
              <div className="grid2">
                <dl className="facts card">
                  <dt>Board</dt><dd>{cur.enclosure.outline_mm ?? "outline unknown"}</dd>
                  <dt>Copper</dt><dd>{cur.board.copper_layers ?? "?"} layer(s){cur.board.layer_names?.length ? `: ${cur.board.layer_names.join(", ")}` : ""}</dd>
                  <dt>Min trace/space</dt><dd>{cur.board.min_trace_mm ?? "?"} / {cur.board.min_space_mm ?? "?"} mm</dd>
                  <dt>From</dt><dd>{cur.board.sources.join(", ") || "—"}</dd>
                  <dt>Nets</dt><dd>{cur.nets}</dd>
                </dl>
                <dl className="facts card">
                  <dt>Power rails</dt><dd>{cur.power_rails.map((p) => `${p.net} (${p.pins})`).join(", ") || "none recognised"}</dd>
                  <dt>Mounting</dt><dd>{cur.enclosure.mounting_holes.join(", ") || "none recognised"}</dd>
                  <dt>Edge</dt><dd>{cur.enclosure.edge_connectors.join("; ") || "none recognised"}</dd>
                  <dt>Heights</dt><dd className="muted">{cur.enclosure.tallest_parts_note}</dd>
                </dl>
              </div>
              <h3 style={{ marginTop: 16 }}>Connectors</h3>
              <ul className="small" data-testid="connectors">{cur.connectors.map((k) => (
                <li key={k.designator}><strong>{k.designator}</strong> {k.mpn ?? ""}{k.edge ? ` · ${k.edge}` : ""}: {k.pins.map((p) => `${p.pin}=${p.net}`).join(", ") || "no nets"}</li>
              ))}{!cur.connectors.length && <li className="muted">none recognised</li>}</ul>
              <h3 style={{ marginTop: 16 }}>Parts</h3>
              <table className="small" data-testid="parts">
                <thead><tr><th>Ref</th><th>Part number</th><th>Value</th><th>Package</th><th>Seen in</th><th>Status</th></tr></thead>
                <tbody>{cur.components.map((c) => (
                  <tr key={c.designator} data-ref={c.designator}><td>{c.designator}</td><td>{c.mpn ?? <span className="warn-text">none</span>}{c.manufacturer && <div className="muted">{c.manufacturer}</div>}</td>
                    <td>{c.value ?? "—"}</td><td>{c.package ?? "—"}</td><td>{c.sources.join(", ")}</td>
                    <td><span className={`pill pill-${c.status === "consistent" ? "complete" : "awaiting_approval"}`}>{c.status}</span>
                      {!!c.reasons.length && <div className="muted">{c.reasons.join("; ")}</div>}</td></tr>
                ))}</tbody>
              </table>
            </>
          )}

          {!!report.comparisons.length && (
            <>
              <h2>Revisions</h2>
              {report.comparisons.map((c) => (
                <details key={`${c.from}-${c.to}`} className="card small" open data-testid="comparison">
                  <summary><strong>{c.from} → {c.to}</strong>: {c.added.length} added, {c.removed.length} removed, {c.changed.length} changed, {c.nets_changed.length + c.nets_added.length + c.nets_removed.length} net change(s)</summary>
                  <ul>
                    {c.added.length > 0 && <li>Added: {c.added.join(", ")}</li>}
                    {c.removed.length > 0 && <li>Removed: {c.removed.join(", ")}</li>}
                    {c.changed.map((x, i) => <li key={i}>{x.designator} {x.field}: {x.from ?? "—"} → {x.to ?? "—"}</li>)}
                    {c.nets_added.length > 0 && <li>Nets added: {c.nets_added.join(", ")}</li>}
                    {c.nets_removed.length > 0 && <li>Nets removed: {c.nets_removed.join(", ")}</li>}
                    {c.nets_changed.map((n) => <li key={n.net}>Net {n.net}: {n.added.map((p) => `+${p}`).join(" ")} {n.removed.map((p) => `−${p}`).join(" ")}</li>)}
                    {c.board.map((b) => <li key={b}>Board: {b}</li>)}
                  </ul>
                </details>
              ))}
            </>
          )}

          {(report.history.decisions.length > 0 || report.history.claims.length > 0) && (
            <>
              <h2>Earlier decisions and claimed validations</h2>
              <p className="small muted">Read from the text and PDF exports by {report.history.model}{report.history.offline && !/not AI/.test(report.history.model ?? "") ? " (offline stand-in, not AI)" : ""}. Every quote below was
                found word for word in its file{report.history.dropped_quotes ? `; ${report.history.dropped_quotes} item(s) whose quote was not found were dropped` : ""}.</p>
              <ul className="list small" data-testid="history">
                {report.history.decisions.map((d, i) => (
                  <li key={`d${i}`}><span className="pill">decision</span> <span className="pill pill-awaiting_approval">unverifiable</span> {d.statement}
                    <div className="muted">“{d.quote}” — {short(d.file)}</div></li>
                ))}
                {report.history.claims.map((c, i) => (
                  <li key={`c${i}`} data-kind={c.kind}><span className="pill">claim: {c.kind.replace("_", " ")}</span>{" "}
                    <span className={`pill pill-${c.status === "unverifiable" ? "failed" : "awaiting_approval"}`}>{c.status === "unverifiable" ? "unverifiable" : "evidence file present, not re-run"}</span> {c.claim}
                    <div className="muted">“{c.quote}” — {short(c.file)}{c.evidence.length ? ` · see ${c.evidence.map(short).join(", ")}` : ""}</div></li>
                ))}
              </ul>
            </>
          )}

          <details className="card small">
            <summary>Inventory: {report.inventory.filter((f) => f.kind !== "archive").length} files in {report.revisions.length} revision(s)</summary>
            <table><thead><tr><th>File</th><th>Revision</th><th>Kind</th><th>Size</th></tr></thead>
              <tbody>{report.inventory.filter((f) => f.kind !== "archive").map((f) => (
                <tr key={`${f.revision}:${f.path}`}><td>{f.path}</td><td>{f.revision}</td><td>{KIND_LABEL[f.kind as FileKind]}</td><td>{mb(f.size)}</td></tr>
              ))}</tbody></table>
          </details>
        </>
      )}
    </main>
  );
}
