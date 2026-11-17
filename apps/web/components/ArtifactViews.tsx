/** Readable views of engineering outputs. Raw files stay downloadable on every artifact page. */

interface ErcReport {
  kicad_version?: string;
  date?: string;
  sheets?: { path: string; violations: { severity: string; type: string; description: string;
             items?: { description: string; pos?: { x: number; y: number } }[] }[] }[];
}

export function ErcView({ report }: { report: ErcReport }) {
  const violations = (report.sheets ?? []).flatMap((s) => s.violations.map((v) => ({ ...v, sheet: s.path })));
  const errors = violations.filter((v) => v.severity === "error").length;
  return (
    <section>
      <h2>Electrical rules check</h2>
      <p className={errors ? "banner banner-error" : "banner banner-notice"} data-testid="erc-summary">
        KiCad {report.kicad_version ?? ""} ERC: {errors} error(s), {violations.length - errors} warning(s).
        {violations.length === 0 && " No violations."}
      </p>
      {violations.length > 0 && (
        <table>
          <thead><tr><th>Severity</th><th>Rule</th><th>Description</th><th>Where</th></tr></thead>
          <tbody>{violations.map((v, i) => (
            <tr key={i}>
              <td><span className={`pill pill-check-${v.severity === "error" ? "fail" : "warning"}`}>{v.severity}</span></td>
              <td className="mono">{v.type}</td><td>{v.description}</td>
              <td className="small">{(v.items ?? []).map((it, j) => <div key={j}>{it.description}{it.pos ? ` @ (${it.pos.x}, ${it.pos.y}) mm` : ""}</div>)}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
    </section>
  );
}

interface Evidence {
  method: string;
  counts: Record<string, number>;
  components: {
    ref: string; value: string; symbol: string; footprint: string; mpn: string | null; manufacturer: string | null; purpose: string;
    library: { symbol_found: boolean; footprint_found: boolean; pads_match: boolean | null; fp_filter_match: boolean | null; description: string | null };
    datasheet: null | { url: string; status: string; error?: string; pages?: number;
      mpn: { value: string | null; found: string; matched?: string };
      claims: { parameter: string; value: string; found: boolean; excerpt: string | null }[] };
    status: "verified" | "partial" | "unverified" | "generic";
  }[];
}

const EVIDENCE_LABEL = { verified: "verified", partial: "partly verified", unverified: "unverified", generic: "generic part" } as const;
const EVIDENCE_PILL = { verified: "pill-check-pass", partial: "pill-check-warning", unverified: "pill-check-fail", generic: "" } as const;

export function EvidenceView({ evidence }: { evidence: Evidence }) {
  return (
    <section>
      <h2>Component evidence</h2>
      <p className="small muted">
        {evidence.method}. “Verified” means the datasheet was downloaded and the part number and every claimed rating appear
        in its text. That is a text match, not an engineering review: check the context in the excerpts.
      </p>
      <p className="small" data-testid="evidence-counts">
        {evidence.counts.verified} verified · {evidence.counts.partial} partly verified · {evidence.counts.unverified} unverified ·{" "}
        {evidence.counts.generic} generic passives
      </p>
      <table className="evidence">
        <thead><tr><th>Ref</th><th>Part</th><th>KiCad library</th><th>Datasheet</th><th>Evidence</th></tr></thead>
        <tbody>{evidence.components.map((c) => (
          <tr key={c.ref} data-ref={c.ref}>
            <td className="mono">{c.ref}</td>
            <td>{c.value}{c.mpn && <div className="small"><span className="mono">{c.mpn}</span>{c.manufacturer && ` · ${c.manufacturer}`}</div>}
              <div className="small muted">{c.purpose}</div></td>
            <td className="small">
              <div className="mono">{c.symbol}</div><div className="mono">{c.footprint}</div>
              <div>{c.library.symbol_found && c.library.footprint_found ? "found" : "missing"}
                {c.library.pads_match === true && " · every pin has a pad"}
                {c.library.pads_match === false && <span className="error-text"> · pins without pads</span>}
                {c.library.fp_filter_match === false && <span className="warn-text"> · footprint outside the symbol's filters</span>}</div>
            </td>
            <td className="small">
              {!c.datasheet ? <span className="muted">none given</span> : (
                <>
                  <a href={c.datasheet.url} target="_blank" rel="noreferrer">datasheet</a>
                  {c.datasheet.status !== "checked" && <div className="warn-text">not checked: {c.datasheet.error}</div>}
                  {c.datasheet.status === "checked" && (
                    <>
                      <div>{c.datasheet.pages} pages · part number {c.datasheet.mpn.found === "exact" ? "found" : c.datasheet.mpn.found === "base" ? `base ${c.datasheet.mpn.matched} found` : c.datasheet.mpn.found === "no" ? <span className="error-text">not found</span> : "not given"}</div>
                      <ul className="claims">{c.datasheet.claims.map((cl, i) => (
                        <li key={i} className={cl.found ? "" : "warn-text"}>
                          {cl.found ? "✓" : "✗"} {cl.parameter}: <strong>{cl.value}</strong>
                          {cl.excerpt && <div className="excerpt muted">“…{cl.excerpt}…”</div>}
                        </li>
                      ))}</ul>
                    </>
                  )}
                </>
              )}
            </td>
            <td>{c.status === "generic" ? <span className="muted small">generic</span> : <span className={`pill ${EVIDENCE_PILL[c.status]}`}>{EVIDENCE_LABEL[c.status]}</span>}</td>
          </tr>
        ))}</tbody>
      </table>
    </section>
  );
}

interface Design {
  title: string; summary: string;
  nets: { name: string; pins: string[]; driven_externally: boolean }[];
  no_connect: string[]; assumptions: string[]; open_questions: string[];
}

export function DesignView({ design }: { design: Design }) {
  return (
    <section>
      <h2>{design.title}</h2>
      <p>{design.summary}</p>
      <div className="grid2">
        {design.assumptions.length > 0 && <div className="card"><h3>Assumptions</h3><ul>{design.assumptions.map((a, i) => <li key={i}>{a}</li>)}</ul></div>}
        {design.open_questions.length > 0 && <div className="card"><h3>Open questions</h3><ul>{design.open_questions.map((a, i) => <li key={i}>{a}</li>)}</ul></div>}
      </div>
      <h3>Nets</h3>
      <table>
        <thead><tr><th>Net</th><th>Pins</th></tr></thead>
        <tbody>{design.nets.map((n) => (
          <tr key={n.name}><td className="mono">{n.name}{n.driven_externally && <span className="pill">external supply</span>}</td>
            <td className="mono small">{n.pins.join(", ")}</td></tr>
        ))}
        {design.no_connect.length > 0 && <tr><td className="muted">not connected</td><td className="mono small">{design.no_connect.join(", ")}</td></tr>}
        </tbody>
      </table>
    </section>
  );
}

/** Minimal CSV parser (quoted fields, doubled quotes). */
export function CsvTable({ csv }: { csv: string }) {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", q = false;
  for (let i = 0; i < csv.length; i++) {
    const ch = csv[i]!;
    if (q) {
      if (ch === '"' && csv[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && csv[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((x) => x !== "")) rows.push(row);
      row = [];
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [header, ...body] = rows;
  if (!header) return null;
  return (
    <table className="small">
      <thead><tr>{header.map((h, i) => <th key={i}>{h}</th>)}</tr></thead>
      <tbody>{body.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody>
    </table>
  );
}
