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

interface FabProblem { code: string; message: string }
interface FabCheck {
  project: string; revision: string; profile: string;
  drc: { errors: number; warnings: number; unconnected: number; parity: number; waived: number };
  gerbers: { ok: boolean; problems: FabProblem[]; warnings: FabProblem[]; layers: string[]; outline_mm: [number, number];
             drill_hits: { plated: number; nonplated: number }; min_drill_mm: number | null };
  assembly: { ok: boolean; problems: FabProblem[]; warnings: FabProblem[]; cpl_rows: number; bom_lines: number;
              lcsc_missing: string[]; rotation_corrections: { ref: string; board: number; cpl: number }[] };
  board: { width_mm: number; height_mm: number; copper_layers: number; holes: { plated: number; nonplated: number; vias: number };
           min_drill_mm: number | null; min_track_mm: number | null };
  parts: { ref: string; value: string; footprint: string; x: number; y: number; rotation: number; side: string; smd: boolean; lcsc: string }[];
  panel: { size_mm: [number, number]; boards: number } | null;
  manifest: Record<string, string>;
  exports?: { ok: boolean; files: Record<string, string>; labels: Record<string, string>; problems: FabProblem[];
              summary: { ipc2581?: { copper_layers: number; components: string[]; outline_mm: number[] | null };
                         odb?: { signal_layers: number; components: string[]; outline_mm: number[] | null };
                         ipcd356?: { nets: number; points: number }; dxf?: { outline_mm: number[] | null } } };
}

function CheckLine({ ok, warn, label, children }: { ok: boolean; warn?: boolean; label: string; children: React.ReactNode }) {
  return (
    <li><span className={`pill pill-check-${!ok ? "fail" : warn ? "warning" : "pass"}`}>{!ok ? "fail" : warn ? "warning" : "pass"}</span>{" "}
      <strong>{label}</strong>: {children}</li>
  );
}

export function FabCheckView({ check }: { check: FabCheck }) {
  const g = check.gerbers;
  const a = check.assembly;
  const drcOk = !check.drc.errors && !check.drc.unconnected && !check.drc.parity;
  return (
    <section>
      <h2>Fab package checks</h2>
      <p className="small muted">
        The Gerbers and drill files were re-read with gerbonara, independently of KiCad, and compared with the board. The
        pick-and-place file was compared with the board&apos;s footprint positions, and the BOM with its components.
      </p>
      <ul className="checks" data-testid="fab-checks">
        <CheckLine ok={drcOk} label="Release gate">
          KiCad DRC with schematic parity: {check.drc.errors} errors, {check.drc.unconnected} unrouted, {check.drc.parity} differences, {check.drc.waived} waived
        </CheckLine>
        <CheckLine ok={g.ok} warn={g.warnings.length > 0} label="Gerbers">
          {g.layers.length} layers; outline {g.outline_mm[0]} x {g.outline_mm[1]} mm; {g.drill_hits.plated} plated + {g.drill_hits.nonplated} non-plated
          holes; smallest drill {g.min_drill_mm} mm
          {[...g.problems, ...g.warnings].map((p, i) => <div key={i} className={g.problems.includes(p) ? "error-text" : "warn-text"}>{p.message}</div>)}
        </CheckLine>
        {check.exports && (() => {
          const x = check.exports, sm = x.summary;
          return (
            <CheckLine ok={x.ok} label="Exchange formats">
              read back and compared with the board:{" "}
              {[sm.ipc2581 && `IPC-2581 C, ${sm.ipc2581.copper_layers} copper layers, ${sm.ipc2581.components.length} components`,
                sm.odb && `ODB++, ${sm.odb.signal_layers} signal layers, ${sm.odb.components.length} components`,
                sm.ipcd356 && `IPC-D-356, ${sm.ipcd356.nets} nets / ${sm.ipcd356.points} test points`,
                sm.dxf?.outline_mm && `DXF outline ${sm.dxf.outline_mm.join(" x ")} mm`].filter(Boolean).join("; ")}
              {x.problems.map((p, i) => <div key={i} className="error-text">{p.message}</div>)}
            </CheckLine>
          );
        })()}
        {(a.cpl_rows > 0 || a.bom_lines > 0) && (
          <CheckLine ok={a.ok} warn={a.warnings.length > 0} label="Assembly files">
            {a.cpl_rows} pick-and-place rows, {a.bom_lines} BOM lines
            {[...a.problems, ...a.warnings].map((p, i) => <div key={i} className={a.problems.includes(p) ? "error-text" : "warn-text"}>{p.message}</div>)}
          </CheckLine>
        )}
      </ul>
      <h3>Parts</h3>
      <table className="small">
        <thead><tr><th>Ref</th><th>Value</th><th>Footprint</th><th>x, y (mm)</th><th>Rotation</th><th>Side</th><th>Type</th><th>LCSC</th></tr></thead>
        <tbody>{check.parts.map((p) => (
          <tr key={p.ref} data-ref={p.ref}><td className="mono">{p.ref}</td><td>{p.value}</td><td className="mono">{p.footprint}</td>
            <td>{p.x}, {p.y}</td><td>{p.rotation}°</td><td>{p.side}</td><td>{p.smd ? "SMD" : "through-hole"}</td>
            <td>{p.lcsc || <span className="warn-text">missing</span>}</td></tr>
        ))}</tbody>
      </table>
      <h3>Manifest</h3>
      <table className="small"><tbody>{Object.entries(check.manifest).map(([f, sha]) => (
        <tr key={f}><td className="mono">{f}</td><td className="mono muted">{sha}</td></tr>
      ))}</tbody></table>
    </section>
  );
}

interface BomOffer { provider: string; seller: string; sku: string | null; stock: number | null; moq: number | null; currency: string;
                    prices: { quantity: number; unitPrice: number }[]; url: string | null; observedAt: string; status: string }
interface BomLine {
  refs: string[]; quantityPerBoard: number; class: string;
  wanted: { mpn: string | null; manufacturer: string | null; value: string; footprint: string; package: string | null; requirements: string[] };
  selected: { mpn: string; manufacturer: string; description: string | null; lifecycle: string; datasheetUrl: string | null;
              productUrl: string | null; identity: string; providers: string[] } | null;
  lcsc: string | null; offers: BomOffer[];
  pricing: { boards: number; need: number; choice: { seller: string; sku: string | null; unitPrice: number; buyQty: number; extended: number } | null; note: string | null }[];
  alternates: { mpn: string; manufacturer: string; lcsc: string | null; stock: number | null }[];
  flags: { code: string; severity: string; message: string }[];
  attempts: { provider: string; outcome: string; results: number; error?: string }[];
}
interface SourcedBom {
  generatedAt: string; currency: string; quantities: number[]; dataStatus: string;
  providers: { id: string; label: string; role: string; configured: boolean; terms: string }[];
  lines: BomLine[]; totals: { boards: number; perBoard: number | null; total: number | null; missingLines: string[] }[];
  counts: { lines: number; sourced: number; unsourced: number; errors: number; warnings: number; withLcsc: number };
}

const money = (n: number | null | undefined, c: string) => n == null ? "—" : `${c === "USD" ? "$" : `${c} `}${n < 1 ? n.toFixed(4) : n.toFixed(2)}`;
const IDENTITY = { exact: "exact match", packaging_variant: "packaging variant", rule_selected: "chosen by rules: review" } as Record<string, string>;

export function SourcedBomView({ bom }: { bom: SourcedBom }) {
  const c = bom.counts;
  return (
    <section>
      <h2>Sourced BOM</h2>
      {bom.dataStatus === "live" ? (
        <p className="banner banner-notice" data-testid="bom-status">
          Live distributor data observed {new Date(bom.generatedAt).toLocaleString()}. Prices and stock change: re-run sourcing before ordering.
        </p>
      ) : (
        <p className="banner banner-warn" data-testid="bom-status">
          {bom.dataStatus === "fixture" ? "Fixture data from the offline stand-in: part numbers starting FX-, prices, stock and SKUs are invented."
                                        : `Data status: ${bom.dataStatus}.`}
        </p>
      )}
      <p className="small" data-testid="bom-counts">
        {c.sourced} of {c.lines} lines sourced · {c.withLcsc} with LCSC numbers · {c.errors} error(s) · {c.warnings} warning(s)
      </p>
      <p className="small muted">
        Providers: {bom.providers.map((p) => `${p.label} (${p.role.replace("_", " ")}${p.configured ? "" : ", not configured"})`).join(" · ")}
      </p>
      <h3>Cost per board</h3>
      <table className="small" data-testid="bom-totals">
        <thead><tr><th>Boards</th><th>Parts per board</th><th>Parts total</th><th>Missing lines</th></tr></thead>
        <tbody>{bom.totals.map((t) => (
          <tr key={t.boards}><td>{t.boards}</td><td>{money(t.perBoard, bom.currency)}</td><td>{money(t.total, bom.currency)}</td>
            <td>{t.missingLines.join("; ") || "none"}</td></tr>
        ))}</tbody>
      </table>
      <p className="small muted">Cheapest single offer per line with enough stock, honouring MOQ, multiples and price breaks. Shipping, duty and assembly are not included.</p>
      <h3>Lines</h3>
      <table className="small bom">
        <thead><tr><th>Refs</th><th>Part</th><th>Lifecycle</th><th>LCSC</th>{bom.quantities.map((q) => <th key={q}>@{q}</th>)}<th>Flags</th></tr></thead>
        <tbody>{bom.lines.map((l) => (
          <tr key={l.refs.join()} data-refs={l.refs.join(",")}>
            <td className="mono">{l.refs.join(", ")}<div className="muted">x{l.quantityPerBoard}</div></td>
            <td>
              {l.selected ? <>
                <span className="mono">{l.selected.mpn}</span> · {l.selected.manufacturer}
                <div className={l.selected.identity === "rule_selected" ? "warn-text" : "muted"}>{IDENTITY[l.selected.identity] ?? l.selected.identity}
                  {l.selected.datasheetUrl && <> · <a href={l.selected.datasheetUrl} target="_blank" rel="noreferrer">datasheet</a></>}</div>
              </> : <span className="error-text">not sourced</span>}
              <div className="muted">{l.wanted.value} · {l.wanted.footprint.split(":").pop()}</div>
              {l.wanted.requirements.map((r, i) => <div key={i} className="muted">needs: {r}</div>)}
              {l.alternates.length > 0 && <div className="muted">alternates: {l.alternates.map((a) => a.mpn).join(", ")}</div>}
              {l.offers.length > 0 && (
                <details><summary>{l.offers.length} offer(s)</summary>
                  <table className="small"><tbody>{l.offers.map((o, i) => (
                    <tr key={i}><td>{o.seller}</td><td className="mono">{o.sku}</td><td>{o.stock ?? "?"} in stock</td><td>MOQ {o.moq ?? 1}</td>
                      <td>{o.prices.map((b) => `${b.quantity}+: ${money(b.unitPrice, o.currency)}`).join(", ")}</td>
                      <td className="muted">{o.status}{o.status === "live" ? `, ${new Date(o.observedAt).toLocaleDateString()}` : ""}</td></tr>
                  ))}</tbody></table>
                </details>
              )}
            </td>
            <td>{l.selected?.lifecycle.replace(/_/g, " ") ?? "—"}</td>
            <td className="mono">{l.lcsc ?? <span className="warn-text">none</span>}</td>
            {l.pricing.map((p) => <td key={p.boards} title={p.note ?? undefined}>{p.choice ? money(p.choice.unitPrice, bom.currency) : "—"}
              {p.choice && <div className="muted">{p.choice.seller}</div>}</td>)}
            <td>{l.flags.filter((f) => f.severity !== "info").map((f, i) => (
              <div key={i} className={f.severity === "error" ? "error-text" : "warn-text"} title={f.message}>{f.code.replace(/_/g, " ")}</div>
            ))}</td>
          </tr>
        ))}</tbody>
      </table>
    </section>
  );
}

interface FitReport {
  ok: boolean; process: { name: string; label: string }; material: string;
  problems: { code: string; message: string }[]; warnings: { code: string; message: string }[];
  dimensions_mm: { x: number; y: number; z: number }; levels_mm: Record<string, number>;
  mounting: Record<string, { hole_mm: number; boss_od_mm: number }>;
  openings: { ref: string; kind: string; side?: string; shape?: string; diameter_mm?: number; width_mm?: number; height_mm?: number;
              depth_mm?: number; recess_mm?: number; error?: string }[];
  collisions: { part: string; ref: string; volume_mm3: number }[]; clearance_mm: Record<string, number>; missing_models: string[];
  mass_g: Record<string, number>; volume_cm3: Record<string, number>;
  board: { thickness_mm: number; holes: { ref: string; size: string; x: number; y: number }[]; parts_checked: string[]; parts: number };
  spec: { wall_mm: number; edge_gap_mm: number; top_clearance_mm: number; standoff_height_mm: number; fastening: string; rationale?: string };
}

export function FitReportView({ report }: { report: FitReport }) {
  const d = report.dimensions_mm;
  return (
    <section>
      <h2>Enclosure fit</h2>
      <p className={report.ok ? (report.warnings.length ? "banner banner-warn" : "banner banner-notice") : "banner banner-error"} data-testid="fit-status">
        {report.ok ? "Fits" : "Does not fit"}: {report.collisions.length} collision(s); {report.board.parts_checked.length} of {report.board.parts} parts
        checked against their 3D models{report.missing_models.length ? ` (no model: ${report.missing_models.join(", ")})` : ""}; {report.problems.length} problem(s),
        {" "}{report.warnings.length} warning(s).
      </p>
      {[...report.problems, ...report.warnings].length > 0 && (
        <ul className="checks">{report.problems.map((p, i) => <li key={`p${i}`}><span className="pill pill-check-fail">error</span> {p.message}</li>)}
          {report.warnings.map((w, i) => <li key={`w${i}`}><span className="pill pill-check-warning">warning</span> {w.message}</li>)}</ul>
      )}
      <dl className="facts small card" data-testid="fit-facts">
        <dt>Process</dt><dd>{report.process.label}, {report.material}</dd>
        <dt>Outside</dt><dd>{d.x} x {d.y} x {d.z} mm</dd>
        <dt>Wall / gaps</dt><dd>wall {report.spec.wall_mm} mm; board edge gap {report.spec.edge_gap_mm} mm; {report.spec.top_clearance_mm} mm above the tallest enclosed part</dd>
        <dt>Board mounting</dt><dd>{report.board.holes.length} standoff(s), {report.spec.standoff_height_mm} mm high, {report.spec.fastening.replace(/_/g, " ")}
          {Object.values(report.mounting)[0] && ` (hole ${Object.values(report.mounting)[0]!.hole_mm} mm, boss ${Object.values(report.mounting)[0]!.boss_od_mm} mm)`}</dd>
        <dt>Levels (Z)</dt><dd>floor {report.levels_mm.floor_top} mm · board {0}–{report.levels_mm.board_top} mm · split {report.levels_mm.split} mm · lid inside {report.levels_mm.lid_inner} mm</dd>
        <dt>Material</dt><dd>base {report.volume_cm3.base} cm³ (~{report.mass_g.base} g) · lid {report.volume_cm3.lid} cm³ (~{report.mass_g.lid} g)</dd>
      </dl>
      {report.spec.rationale && <p className="small">{report.spec.rationale}</p>}
      <h3>Openings</h3>
      <table className="small">
        <thead><tr><th>Part</th><th>Where</th><th>Size</th><th>Notes</th></tr></thead>
        <tbody>{report.openings.map((o, i) => (
          <tr key={i}><td className="mono">{o.ref}</td><td>{o.kind === "edge" ? `${o.side} wall` : "lid"}</td>
            <td>{o.diameter_mm ? `⌀ ${o.diameter_mm} mm` : o.kind === "edge" ? `${o.width_mm} x ${o.height_mm} mm` : `${o.width_mm} x ${o.depth_mm} mm`}</td>
            <td>{o.error ?? (o.recess_mm !== undefined ? `part sits ${o.recess_mm} mm behind the outer wall` : "")}</td></tr>
        ))}</tbody>
      </table>
      <h3>Clearance to the housing</h3>
      <p className="small">{Object.entries(report.clearance_mm).map(([r, c]) => `${r} ${c} mm`).join(" · ") || "—"}</p>
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
