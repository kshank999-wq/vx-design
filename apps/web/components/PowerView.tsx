/** Power budget view: the tree, the calculator's findings, and the numbers behind them. */
import type { PowerReport, PowerTree } from "@vx/power";

const A = (a: number) => a >= 1 ? `${a.toFixed(3)} A` : `${(a * 1000).toFixed(a < 0.01 ? 2 : 1)} mA`;
const W = (w: number) => w >= 1 ? `${w.toFixed(2)} W` : `${(w * 1000).toFixed(1)} mW`;
const V = (v: { min: number; nom: number; max: number }) => v.min === v.max ? `${v.nom} V` : `${v.min}–${v.max} V`;
const pct = (x: number) => `${Math.round(x * 100)}%`;
/** Worst current over the three source-voltage corners (min/nom/max are voltage corners, not current bounds). */
const worst = (b: { min: number; nom: number; max: number } | undefined) => b ? Math.max(b.min, b.nom, b.max) : 0;
const SEV = { error: "fail", warning: "warning", info: "pass" } as const;

function Branch({ rail, report, tree, mode }: { rail: string; report: PowerReport; tree: PowerTree; mode: string }) {
  const r = report.rails.find((x) => x.id === rail);
  if (!r) return null;
  return (
    <ul className="tree">
      {r.loads.map((id) => {
        const l = tree.loads.find((x) => x.id === id)!;
        return <li key={id} className="tree-load"><strong>{l.label}</strong> <span className="muted">{A(l.current_a[mode] ?? 0)}{l.peak_a ? `, peak ${A(l.peak_a)}` : ""} · {l.basis.kind}</span></li>;
      })}
      {r.converters.map((id) => {
        const c = report.converters.find((x) => x.id === id)!;
        const out = report.rails.find((x) => x.id === c.output)!;
        return (
          <li key={id}>
            <span className="tree-conv">{c.label} <span className="mono">{c.kind.replace("_", "-")}</span></span>{" "}
            <span className="muted">{A(c.ioutA[mode] ?? 0)} out, {pct(c.utilization)} of rating{c.tjMaxC !== null ? `, Tj ${c.tjMaxC} °C` : ""}</span>
            <div className="tree-rail">→ <strong>{out.label}</strong> <span className="mono">{out.id}</span> {V(out.voltage)}</div>
            <Branch rail={c.output} report={report} tree={tree} mode={mode} />
          </li>
        );
      })}
    </ul>
  );
}

export function PowerView({ tree, report }: { tree: PowerTree; report: PowerReport }) {
  const mode = report.modes[0]?.id ?? "";
  const findings = report.findings.filter((f) => f.severity !== "info");
  return (
    <section>
      <h2>Power budget</h2>
      <p>{tree.summary}</p>
      <p className={report.counts.errors ? "banner banner-error" : report.counts.warnings ? "banner banner-warn" : "banner banner-notice"} data-testid="power-status">
        Power calculator: {report.counts.errors} error(s), {report.counts.warnings} warning(s). Checked at the minimum, nominal and maximum
        source voltage and {report.ambientC.max} °C ambient. Inputs: {Object.entries(report.basis).map(([k, n]) => `${n} ${k}`).join(", ")}.
      </p>
      {findings.length > 0 && (
        <ul className="checks" data-testid="power-findings">{findings.map((f, i) => (
          <li key={i}><span className={`pill pill-check-${SEV[f.severity]}`}>{f.severity}</span> <span className="mono">{f.subject}</span> {f.message}</li>
        ))}</ul>
      )}

      <h3>Power tree <span className="muted small">({report.modes.find((m) => m.id === mode)?.label ?? mode} mode)</span></h3>
      <div className="card power-tree" data-testid="power-tree">
        {report.sources.map((s) => (
          <div key={s.id}>
            <div><strong>{s.label}</strong> <span className="mono">{s.id}</span> {V(s.voltage)}{" "}
              <span className="muted">{A(worst(s.currentA[mode]))} worst case (at {s.voltage.min} V), peak {A(s.peakA)}{s.maxCurrentA !== null ? ` of ${A(s.maxCurrentA)} available` : ""}</span></div>
            <Branch rail={s.id} report={report} tree={tree} mode={mode} />
          </div>
        ))}
      </div>

      {report.runtime.length > 0 && <>
        <h3>Battery runtime</h3>
        <table className="small" data-testid="power-runtime">
          <thead><tr><th>Battery</th><th>Usable energy</th>{report.modes.map((m) => <th key={m.id}>{m.label}</th>)}<th>Daily profile</th></tr></thead>
          <tbody>{report.runtime.map((r) => (
            <tr key={r.source}><td className="mono">{r.source}</td><td>{r.energyWh} Wh</td>
              {r.perMode.map((m) => <td key={m.mode}>{m.hours === null ? "—" : `${m.hours} h`} <span className="muted">({W(m.powerW)})</span></td>)}
              <td>{r.days === null ? "—" : `${r.days} day(s)`} <span className="muted">({report.modes.map((m) => `${m.hoursPerDay} h ${m.id}`).join(" + ")} per day)</span></td></tr>
          ))}</tbody>
        </table>
      </>}

      <h3>Converters</h3>
      <table className="small">
        <thead><tr><th>Converter</th><th>In → out</th>{report.modes.map((m) => <th key={m.id}>I out {m.id}</th>)}<th>Peak</th><th>Of rating</th><th>Loss (max)</th><th>Tj (max)</th></tr></thead>
        <tbody>{report.converters.map((c) => (
          <tr key={c.id}><td>{c.label} <span className="mono muted">{c.kind}</span></td><td>{c.vin.min}–{c.vin.max} V → {c.vout.nom} V</td>
            {report.modes.map((m) => <td key={m.id}>{A(c.ioutA[m.id] ?? 0)}</td>)}<td>{A(c.ioutPeakA)}</td><td>{pct(c.utilization)}</td>
            <td>{W(c.pdissMaxW)}</td><td>{c.tjMaxC === null ? <span className="warn-text">no θJA</span> : `${c.tjMaxC} °C`}</td></tr>
        ))}</tbody>
      </table>

      <h3>Rails</h3>
      <table className="small">
        <thead><tr><th>Rail</th><th>Voltage</th>{report.modes.map((m) => <th key={m.id}>{m.label} (worst)</th>)}<th>Peak</th><th>Fed by</th></tr></thead>
        <tbody>{report.rails.map((r) => (
          <tr key={r.id}><td className="mono">{r.id}</td><td>{V(r.voltage)}</td>{report.modes.map((m) => <td key={m.id}>{A(worst(r.current[m.id]))}</td>)}
            <td>{A(r.peakA)}</td><td className="mono">{r.fedBy}</td></tr>
        ))}</tbody>
      </table>

      <h3>Efficiency</h3>
      <p className="small">{report.modes.map((m) => `${m.label}: ${report.efficiency[m.id] == null ? "—" : pct(report.efficiency[m.id]!)}`).join(" · ")}
        <span className="muted"> (load power ÷ source power at nominal voltage)</span></p>

      <h3>Where the numbers come from</h3>
      <table className="small">
        <thead><tr><th>Item</th><th>Basis</th></tr></thead>
        <tbody>{[...tree.sources.map((x) => [x.label, x.basis] as const), ...tree.converters.map((x) => [x.label, x.basis] as const),
                 ...tree.loads.map((x) => [x.label, x.basis] as const)].map(([label, b], i) => (
          <tr key={i}><td>{label}</td><td><span className={b.kind === "assumption" ? "warn-text" : ""}>{b.kind}</span>: {b.ref}</td></tr>
        ))}</tbody>
      </table>
      <div className="grid2">
        {tree.assumptions.length > 0 && <div className="card"><h3>Assumptions</h3><ul>{tree.assumptions.map((a, i) => <li key={i}>{a}</li>)}</ul></div>}
        {tree.open_questions.length > 0 && <div className="card"><h3>Open questions</h3><ul>{tree.open_questions.map((a, i) => <li key={i}>{a}</li>)}</ul></div>}
      </div>
    </section>
  );
}
