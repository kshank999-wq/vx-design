import Link from "next/link";
import { SubmitButton } from "@/components/SubmitButton";
import { addSource } from "@/app/knowledge/actions";
import { LICENSES, SOURCE_KINDS, type KnowledgeHit } from "@/lib/knowledge";

/** Search snippets mark matched words with «»; render those as <mark> without trusting any markup in the text. */
export function Snippet({ text }: { text: string }) {
  const parts = text.split(/(«[^»]*»)/g);
  return <>{parts.map((p, i) => p.startsWith("«") && p.endsWith("»") ? <mark key={i}>{p.slice(1, -1)}</mark> : <span key={i}>{p}</span>)}</>;
}

export function LicenseFlag({ license }: { license: keyof typeof LICENSES }) {
  const l = LICENSES[license];
  return <span className={`pill pill-license-${l.excerpts ? "text" : "meta"}`} title={l.help}>{l.label}</span>;
}

export function HitList({ hits }: { hits: KnowledgeHit[] }) {
  if (!hits.length) return <p className="muted">No matches. Standards are found by identifier ("IPC 2152") or topic; documents by their text.</p>;
  return (
    <ol className="hits" data-testid="results">
      {hits.map((h, i) => (
        <li key={`${h.result_kind}-${h.source_id ?? h.standard_id}-${i}`} className="hit" data-kind={h.result_kind}>
          <div className="row">
            <span className="pill">{h.result_kind === "standard" ? "standard" : h.result_kind === "excerpt" ? "excerpt" : h.kind.replace("_", " ")}</span>
            {h.source_id && h.result_kind !== "standard"
              ? <Link href={`/knowledge/sources/${h.source_id}`}><strong>{h.identifier ? `${h.identifier} — ` : ""}{h.title}</strong></Link>
              : <strong>{h.identifier ? `${h.identifier} — ` : ""}{h.title}</strong>}
            {h.project_id && <span className="pill pill-awaiting_approval">this project only</span>}
          </div>
          <div className="small citation">
            {h.publisher}{h.locator && <> · <span className="mono">{h.locator}</span></>} ·{" "}
            {h.edition ? <>edition {h.edition}</> : <span className="warn-text">edition unconfirmed</span>} ·{" "}
            <LicenseFlag license={h.license} /> ·{" "}
            {(h.result_kind === "standard" ? h.status === "reviewed" : h.status === "verified")
              ? <span>{h.result_kind === "standard" ? "reviewed" : "verified"}{h.last_verified_at && ` ${new Date(h.last_verified_at).toLocaleDateString()}`}</span>
              : <span className="warn-text">{h.result_kind === "standard" ? "not yet reviewed" : "unverified"}</span>}
            {h.status === "superseded" && <span className="warn-text"> · superseded</span>}
            {h.official_url && <> · <a href={h.official_url} target="_blank" rel="noreferrer">official source</a></>}
          </div>
          {h.snippet && (h.result_kind === "excerpt"
            ? <blockquote className="small"><Snippet text={h.snippet} /></blockquote>
            : <p className="small muted">{h.snippet}</p>)}
          {!h.excerpt_allowed && <p className="small muted">No text is held for this source: open the official source or your licensed copy.</p>}
        </li>
      ))}
    </ol>
  );
}

export function SourceForm({ projectId, heading }: { projectId: string | null; heading: string }) {
  const options = Object.entries(LICENSES).filter(([k]) => projectId || k !== "licensed_copy");
  return (
    <form action={addSource} className="card stack" data-testid="source-form">
      <h3>{heading}</h3>
      {projectId && <input type="hidden" name="project_id" value={projectId} />}
      <div className="grid2">
        <label>Title<input name="title" placeholder="From the file if left empty" /></label>
        <label>Publisher<input name="publisher" required placeholder="Texas Instruments, IPC, …" /></label>
        <label>Identifier<input name="identifier" placeholder="Part number, document number or standard" /></label>
        <label>Edition / revision<input name="edition" placeholder="As printed, e.g. Rev. F" /></label>
        <label>Official URL<input name="official_url" type="url" placeholder="https://…" /></label>
        <label>Kind<select name="kind" defaultValue="datasheet">{SOURCE_KINDS.map((k) => <option key={k} value={k}>{k.replace("_", " ")}</option>)}</select></label>
      </div>
      <fieldset className="licenses">
        <legend>Licence: what may VX Design keep?</legend>
        {options.map(([k, l]) => (
          <label key={k} className="radio"><input type="radio" name="license" value={k} required defaultChecked={k === "unknown"} />
            <span><strong>{l.label}</strong> <span className="small muted">{l.help}</span></span></label>
        ))}
        <label>What the terms say<input name="license_note" placeholder="e.g. CC BY 4.0; or the clause in the vendor's terms" /></label>
      </fieldset>
      <label>Summary (your own words)<input name="summary" /></label>
      <label>File (PDF, DOCX, Markdown or text; only for licences that allow excerpts)<input type="file" name="file" accept=".pdf,.docx,.md,.txt" /></label>
      <div><SubmitButton pendingText="Adding…">Add source</SubmitButton></div>
    </form>
  );
}
