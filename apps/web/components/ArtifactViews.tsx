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

interface DrcItem { description: string; pos?: { x: number; y: number } }
interface DrcEntry { severity: string; type: string; description: string; excluded?: boolean; items?: DrcItem[] }
interface DrcReport {
  kicad_version?: string; date?: string;
  violations?: DrcEntry[]; unconnected_items?: DrcEntry[]; schematic_parity?: DrcEntry[];
}

function DrcTable({ rows }: { rows: DrcEntry[] }) {
  return (
    <table>
      <thead><tr><th>Severity</th><th>Rule</th><th>Description</th><th>Where</th></tr></thead>
      <tbody>{rows.map((v, i) => (
        <tr key={i}>
          <td><span className={`pill pill-check-${v.excluded ? "pass" : v.severity === "error" ? "fail" : "warning"}`}>{v.excluded ? "waived" : v.severity}</span></td>
          <td className="mono">{v.type}</td><td>{v.description}</td>
          <td className="small">{(v.items ?? []).map((it, j) => <div key={j}>{it.description}{it.pos ? ` @ (${it.pos.x}, ${it.pos.y}) mm` : ""}</div>)}</td>
        </tr>
      ))}</tbody>
    </table>
  );
}

export function DrcView({ report }: { report: DrcReport }) {
  const all = [...(report.violations ?? []), ...(report.unconnected_items ?? []), ...(report.schematic_parity ?? [])];
  const live = all.filter((v) => !v.excluded);
  const errors = live.filter((v) => v.severity === "error").length;
  const unrouted = (report.unconnected_items ?? []).filter((v) => !v.excluded).length;
  const parity = (report.schematic_parity ?? []).filter((v) => !v.excluded).length;
  const waived = all.length - live.length;
  return (
    <section>
      <h2>Design rules check</h2>
      <p className={errors ? "banner banner-error" : "banner banner-notice"} data-testid="drc-summary">
        KiCad {report.kicad_version ?? ""} DRC with schematic parity: {errors} error(s), {live.length - errors} warning(s),{" "}
        {unrouted} unrouted connection(s), {parity} schematic difference(s), {waived} waived.
        {live.length === 0 && " No violations."}
      </p>
      {(report.violations ?? []).length > 0 && <><h3>Rule violations</h3><DrcTable rows={report.violations!} /></>}
      {(report.unconnected_items ?? []).length > 0 && <><h3>Unrouted connections</h3><DrcTable rows={report.unconnected_items!} /></>}
      {(report.schematic_parity ?? []).length > 0 && <><h3>Differences from the schematic</h3><DrcTable rows={report.schematic_parity!} /></>}
    </section>
  );
}

interface ModelEntry { ref: string; footprint: string; model: string | null; status: string; source?: string; sha256?: string; error?: string }

export function ModelReportView({ models }: { models: ModelEntry[] }) {
  const parts = models.filter((m) => !(m.status === "none" && /^MountingHole:/.test(m.footprint)));
  const found = parts.filter((m) => m.status === "found").length;
  return (
    <section>
      <h2>3D models</h2>
      <p className="small muted">
        Each footprint&apos;s 3D model comes from KiCad&apos;s official 3D library (kicad-packages3D) at the KiCad version&apos;s tag. These are
        generic package shapes for fit and visual checks, not manufacturer CAD: confirm heights and connector bodies against the datasheet.
      </p>
      <p className="small" data-testid="model-counts">{found} of {parts.length} parts have a model.</p>
      <table>
        <thead><tr><th>Ref</th><th>Footprint</th><th>Model</th><th>Status</th></tr></thead>
        <tbody>{models.map((m, i) => (
          <tr key={i} data-ref={m.ref}>
            <td className="mono">{m.ref}</td><td className="mono small">{m.footprint}</td>
            <td className="mono small">{m.source ? <a href={m.source} target="_blank" rel="noreferrer">{m.model}</a> : (m.model ?? "—")}</td>
            <td>{m.status === "found" ? <span className="pill pill-check-pass">found</span>
              : m.status === "none" ? <span className="muted small">no model (mounting hole)</span>
              : <span className="pill pill-check-warning" title={m.error}>{m.status}</span>}</td>
          </tr>
        ))}</tbody>
      </table>
    </section>
  );
}

interface LayoutDoc {
  board: { width_mm: number; height_mm: number; corner_radius_mm: number; mounting_holes: { x_mm: number; y_mm: number; size: string }[] };
  fab_profile: string; ground_pour: string | null; rationale: string;
  placements: { ref: string; x_mm: number; y_mm: number; rotation_deg: number; side: string }[];
  assumptions: string[]; open_questions: string[];
  history?: { round: number; stage: string; problems: number }[];
}

export function LayoutView({ layout }: { layout: LayoutDoc }) {
  return (
    <section>
      <h2>Board layout</h2>
      <p>{layout.rationale}</p>
      <dl className="facts small card">
        <dt>Outline</dt><dd>{layout.board.width_mm} x {layout.board.height_mm} mm{layout.board.corner_radius_mm ? `, ${layout.board.corner_radius_mm} mm corners` : ""}</dd>
        <dt>Mounting holes</dt><dd>{layout.board.mounting_holes.map((h) => `${h.size} @ (${h.x_mm}, ${h.y_mm})`).join(", ") || "none"}</dd>
        <dt>Design rules</dt><dd className="mono">{layout.fab_profile}</dd>
        <dt>Ground pour</dt><dd>{layout.ground_pour ? `${layout.ground_pour}, both layers` : "none"}</dd>
        {layout.history && <><dt>Layout rounds</dt><dd>{layout.history.map((h) => `${h.round}: ${h.stage}${h.problems ? ` (${h.problems} problems)` : ""}`).join(" → ")}</dd></>}
      </dl>
      <div className="grid2">
        {layout.assumptions.length > 0 && <div className="card"><h3>Assumptions</h3><ul>{layout.assumptions.map((a, i) => <li key={i}>{a}</li>)}</ul></div>}
        {layout.open_questions.length > 0 && <div className="card"><h3>Open questions</h3><ul>{layout.open_questions.map((a, i) => <li key={i}>{a}</li>)}</ul></div>}
      </div>
      <h3>Placements</h3>
      <table className="small">
        <thead><tr><th>Ref</th><th>x (mm)</th><th>y (mm)</th><th>Rotation</th><th>Side</th></tr></thead>
        <tbody>{layout.placements.map((p) => (
          <tr key={p.ref}><td className="mono">{p.ref}</td><td>{p.x_mm}</td><td>{p.y_mm}</td><td>{p.rotation_deg}°</td><td>{p.side}</td></tr>
        ))}</tbody>
      </table>
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
