import { Fragment } from "react";
import Link from "next/link";
import { describeRule, PROCESSES, RULE_FIELDS, TEMPLATES, type Process } from "@vx/dfm";
import { SubmitButton } from "@/components/SubmitButton";
import { deleteProcessRules, saveProcessRules, verifyProcessRules } from "@/app/suppliers/[manufacturerId]/rules-actions";

interface RulesRow {
  id: string; process: Process; rules: Record<string, unknown>; source_url: string | null; source_note: string | null;
  checked_on: string | null; verified_at: string | null;
}

/** A manufacturer's process rules: what it states it can make, where that was read, and whether an editor checked it. */
export function ProcessRules({ manufacturerId, rows, editor, editProcess, template }: {
  manufacturerId: string; rows: RulesRow[]; editor: boolean; editProcess?: string; template?: string;
}) {
  const tpl = TEMPLATES.find((t) => t.key === template);
  const process = (tpl?.process ?? editProcess ?? "pcb_fab") as Process;
  const current = rows.find((r) => r.process === process);
  const values = (tpl?.rules ?? current?.rules ?? {}) as Record<string, unknown>;
  return (
    <section id="rules">
      <h2>Process rules</h2>
      <p className="small muted">What this manufacturer says it can make, per process, and where that was read. Projects check their board and
        enclosure against these on their Manufacturing fit page. Re-check the source before relying on it for an order.</p>
      {rows.length ? (
        <div className="stack" data-testid="process-rules">
          {rows.map((r) => (
            <div key={r.id} className="card" data-process={r.process}>
              <div className="row spread">
                <strong>{PROCESSES.find((p) => p.key === r.process)?.label}</strong>
                <span className={`pill pill-${r.verified_at ? "complete" : "awaiting_approval"}`}>{r.verified_at ? "verified" : "not verified"}</span>
              </div>
              <dl className="facts small">
                {RULE_FIELDS[r.process].filter((f) => r.rules[f.key] !== undefined).map((f) => (
                  <Fragment key={f.key}><dt>{f.label}</dt><dd>{describeRule(r.rules[f.key], f.kind)}{f.unit && f.kind !== "bool" && f.kind !== "texts" ? ` ${f.unit}` : ""}</dd></Fragment>
                ))}
                <dt>Source</dt><dd>{r.source_url ? <a href={r.source_url} rel="noreferrer" target="_blank">{r.source_url}</a> : r.source_note}
                  {r.checked_on && <span className="muted"> · read {r.checked_on}</span>}</dd>
              </dl>
              <div className="row tight">
                <Link href={`?edit=${r.process}#rules`} className="btn btn-secondary">Edit</Link>
                {editor && !r.verified_at && <form action={verifyProcessRules.bind(null, manufacturerId, r.id)}><SubmitButton variant="secondary" pendingText="…">Verify</SubmitButton></form>}
                <form action={deleteProcessRules.bind(null, manufacturerId, r.id)}><SubmitButton variant="secondary" pendingText="…">Remove</SubmitButton></form>
              </div>
            </div>
          ))}
        </div>
      ) : <p className="muted">No process rules recorded.</p>}

      <details className="card" open={!!editProcess || !!tpl || !rows.length}>
        <summary>Add or edit process rules</summary>
        <p className="small">Start from a published template: {TEMPLATES.map((t, i) => (
          <span key={t.key}>{i > 0 && " · "}<Link href={`?template=${t.key}#rules`}>{t.label}</Link></span>))}
          {tpl && <> <strong>(filled from {tpl.label}: check each value against <a href={tpl.source.startsWith("https://") ? tpl.source : undefined}>{tpl.source}</a>)</strong></>}</p>
        <form action={saveProcessRules.bind(null, manufacturerId)} className="stack" key={`${process}-${template ?? ""}`}>
          <input type="hidden" name="process" value={process} />
          <p className="small" data-testid="rules-process">Process: <strong>{PROCESSES.find((p) => p.key === process)!.label}</strong> · switch to {PROCESSES.filter((p) => p.key !== process).map((p, i) => (
            <span key={p.key}>{i > 0 && ", "}<Link href={`?edit=${p.key}#rules`}>{p.label}</Link></span>))}</p>
          <div className="grid2">
            {RULE_FIELDS[process].map((f) => (
              <label key={f.key}>{f.label}{f.unit ? ` (${f.unit})` : ""}
                <input name={f.key} defaultValue={values[f.key] === undefined ? "" : describeRule(values[f.key], f.kind)}
                       placeholder={f.kind === "bool" ? "yes / no" : f.kind === "dims2" ? "400 × 500" : f.kind === "dims3" ? "250 × 250 × 250" : f.kind === "numbers" || f.kind === "texts" ? "comma-separated" : f.kind === "passive" ? "0402" : ""} />
              </label>
            ))}
          </div>
          <div className="grid2">
            <label>Source URL<input name="source_url" type="url" defaultValue={tpl?.source.startsWith("https://") ? tpl.source : current?.source_url ?? ""} placeholder="https://… capability page" /></label>
            <label>Or a note<input name="source_note" defaultValue={current?.source_note ?? ""} placeholder="Quote email from …, 12 Nov" /></label>
            <label>Read on<input name="checked_on" type="date" defaultValue={current?.checked_on ?? ""} /></label>
          </div>
          <div><SubmitButton pendingText="Saving…">Save rules</SubmitButton></div>
        </form>
      </details>
    </section>
  );
}
