import Link from "next/link";
import { notFound } from "next/navigation";
import { Banner } from "@/components/Banner";
import { SubmitButton } from "@/components/SubmitButton";
import { requireUser } from "@/lib/auth";
import { RISK_CATEGORIES, RISK_STATUSES, STAGE_NAME, STAGES } from "@/lib/stages";
import { addRisk, runFeasibility, saveIntake, updateRisk } from "./actions";

const SCALE = [1, 2, 3, 4, 5];
const ORDER = { critical: 0, high: 1, medium: 2, low: 3 } as Record<string, number>;

export default async function RisksPage({ params, searchParams }: {
  params: Promise<{ projectId: string }>; searchParams: Promise<{ error?: string; notice?: string; show?: string }>;
}) {
  const { projectId } = await params;
  const { error, notice, show } = await searchParams;
  const { supabase, userId } = await requireUser();
  const [{ data: project }, { data: me }, { data: intake }, { data: risks }] = await Promise.all([
    supabase.from("projects").select("name").eq("id", projectId).maybeSingle(),
    supabase.from("project_members").select("role").eq("project_id", projectId).eq("user_id", userId).maybeSingle(),
    supabase.from("project_intake").select("*").eq("project_id", projectId).maybeSingle(),
    supabase.from("risks").select("*").eq("project_id", projectId).order("risk_no"),
  ]);
  if (!project) notFound();
  const role = me?.role ?? "viewer";
  const canEdit = role === "owner" || role === "engineer";
  const canRisk = canEdit || role === "reviewer";
  const all = risks ?? [];
  const live = all.filter((r) => r.status === "open" || r.status === "mitigating")
    .sort((a, b) => (ORDER[a.level] ?? 9) - (ORDER[b.level] ?? 9) || b.score - a.score || a.risk_no - b.risk_no);
  const settled = all.filter((r) => r.status === "accepted" || r.status === "closed");
  const shown = show === "all" ? [...live, ...settled] : live;
  const counts = live.reduce<Record<string, number>>((a, r) => ({ ...a, [r.level]: (a[r.level] ?? 0) + 1 }), {});
  const gaps = (intake?.feasibility_gaps ?? []) as string[];
  const i = intake ?? {} as Record<string, never>;

  return (
    <main>
      <p className="crumbs"><Link href="/projects">Projects</Link> / <Link href={`/projects/${projectId}`}>{project.name}</Link> /</p>
      <h1>Intake and risks</h1>
      <p className="muted">S0: what the product is for, where it is sold, how many and at what cost, and what could stop it. The feasibility
        check reads the intake and the requirements with fixed rules (no model) and files what it finds as risks, citing the text each
        came from. High and critical risks hold up their stage's sign-off until they are mitigated, closed, or accepted by the owner.</p>
      <Banner error={error} notice={notice} />

      <section>
        <h2>Intake</h2>
        <form action={saveIntake.bind(null, projectId)} className="card stack" data-testid="intake">
          <fieldset disabled={!canEdit} className="stack">
            <label>Intended use<input name="intended_use" defaultValue={i.intended_use ?? ""} placeholder="Who uses it, where, for what" /></label>
            <div className="grid2">
              <label>Target markets<input name="regions" defaultValue={(i.regions ?? []).join(", ")} placeholder="US, EU, UK" /></label>
              <label>Target standards<input name="target_standards" defaultValue={(i.target_standards ?? []).join(", ")} placeholder="FCC Part 15B, EN 55032" /></label>
              <label>First production quantity<input name="quantity" inputMode="numeric" defaultValue={i.quantity ?? ""} /></label>
              <label>Target unit cost<input name="target_unit_cost" inputMode="decimal" defaultValue={i.target_unit_cost ?? ""} /></label>
              <label>Currency<input name="currency" defaultValue={i.currency ?? "USD"} /></label>
              <label>Maximum dimensions<input name="max_dimensions" defaultValue={i.max_dimensions ?? ""} placeholder="120 × 80 × 25 mm" /></label>
              <label>Power source<input name="power_source" defaultValue={i.power_source ?? ""} placeholder="Li-ion 1S with USB-C charging" /></label>
              <label>Radios<input name="radios" defaultValue={(i.radios ?? []).join(", ")} placeholder="Bluetooth LE" /></label>
            </div>
            <label>Notes<input name="notes" defaultValue={i.notes ?? ""} /></label>
          </fieldset>
          {canEdit && <div><SubmitButton pendingText="Saving…">Save intake</SubmitButton></div>}
        </form>
      </section>

      <section>
        <div className="row spread"><h2>Risk register</h2>
          {canEdit && <form action={runFeasibility.bind(null, projectId)}><SubmitButton pendingText="Checking…">Run feasibility check</SubmitButton></form>}</div>
        <p className="small" data-testid="risk-summary">
          {intake?.feasibility_checked_at ? `Feasibility checked ${new Date(intake.feasibility_checked_at).toLocaleString()}.` : "The feasibility check has not run yet."}{" "}
          {live.length} open: {["critical", "high", "medium", "low"].map((l) => `${counts[l] ?? 0} ${l}`).join(", ")}; {settled.length} accepted or closed
          {" "}(<Link href={`?show=${show === "all" ? "open" : "all"}`}>{show === "all" ? "show open only" : "show all"}</Link>).
          {gaps.length > 0 && <> Missing from the intake: {gaps.join(", ")}.</>}
        </p>
        <ul className="list" data-testid="risks">
          {shown.map((r) => (
            <li key={r.id} id={`risk-${r.id}`} className="card" data-risk={`RISK-${String(r.risk_no).padStart(3, "0")}`} data-level={r.level} data-status={r.status}>
              <div className="row spread">
                <strong>RISK-{String(r.risk_no).padStart(3, "0")} {r.title}</strong>
                <span className="row tight">
                  <span className={`pill pill-risk-${r.level}`}>{r.level} · {r.likelihood}×{r.impact}</span>
                  <span className="pill">{r.stage}</span><span className="pill">{r.category}</span>
                  <span className={`pill pill-${r.status === "closed" || r.status === "accepted" ? "complete" : "awaiting_approval"}`}>{r.status}</span>
                </span>
              </div>
              {r.description && <p className="small">{r.description}</p>}
              {r.mitigation && <p className="small"><strong>Mitigation:</strong> {r.mitigation}</p>}
              {r.decision_note && <p className="small"><strong>{r.status === "accepted" ? "Accepted" : "Note"}:</strong> {r.decision_note}</p>}
              {(r.evidence as { ref: string; excerpt: string }[]).length > 0 && (
                <details className="small"><summary>Based on {(r.evidence as unknown[]).length} passage(s){r.source === "feasibility" ? " (feasibility check)" : ""}</summary>
                  <ul>{(r.evidence as { ref: string; excerpt: string }[]).map((e, n) => <li key={n}><span className="mono">{e.ref}</span>: “{e.excerpt}”</li>)}</ul>
                </details>
              )}
              {canRisk && (
                <details><summary>Update</summary>
                  <form action={updateRisk.bind(null, projectId, r.id)} className="stack">
                    <div className="grid2">
                      <label>Status<select name="status" defaultValue={r.status} aria-label={`Status of RISK-${String(r.risk_no).padStart(3, "0")}`}>
                        {RISK_STATUSES.map((s) => <option key={s}>{s}</option>)}</select></label>
                      <label>Stage<select name="stage" defaultValue={r.stage}>{STAGES.map((s) => <option key={s} value={s}>{s} {STAGE_NAME[s]}</option>)}</select></label>
                      <label>Likelihood (1–5)<select name="likelihood" defaultValue={r.likelihood}>{SCALE.map((n) => <option key={n}>{n}</option>)}</select></label>
                      <label>Impact (1–5)<select name="impact" defaultValue={r.impact}>{SCALE.map((n) => <option key={n}>{n}</option>)}</select></label>
                    </div>
                    <label>Mitigation<input name="mitigation" defaultValue={r.mitigation ?? ""} /></label>
                    <label>Note (required to accept or close)<input name="note" aria-label={`Note for RISK-${String(r.risk_no).padStart(3, "0")}`} /></label>
                    <div><SubmitButton variant="secondary" pendingText="Saving…">Update risk</SubmitButton></div>
                  </form>
                </details>
              )}
            </li>
          ))}
          {!shown.length && <li className="muted">No open risks.</li>}
        </ul>
        {canRisk && (
          <details className="card"><summary>Add a risk</summary>
            <form action={addRisk.bind(null, projectId)} className="stack">
              <label>Title<input name="title" required /></label>
              <label>Description<input name="description" /></label>
              <div className="grid2">
                <label>Category<select name="category" defaultValue="technical">{RISK_CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select></label>
                <label>Stage<select name="stage" defaultValue="S2">{STAGES.map((s) => <option key={s} value={s}>{s} {STAGE_NAME[s]}</option>)}</select></label>
                <label>Likelihood (1–5)<select name="likelihood" defaultValue={3}>{SCALE.map((n) => <option key={n}>{n}</option>)}</select></label>
                <label>Impact (1–5)<select name="impact" defaultValue={3}>{SCALE.map((n) => <option key={n}>{n}</option>)}</select></label>
              </div>
              <label>Mitigation<input name="mitigation" /></label>
              <label>Requirements (comma-separated)<input name="requirement_refs" placeholder="REQ-PWR-001" /></label>
              <div><SubmitButton pendingText="Adding…">Add risk</SubmitButton></div>
            </form>
          </details>
        )}
      </section>
    </main>
  );
}
