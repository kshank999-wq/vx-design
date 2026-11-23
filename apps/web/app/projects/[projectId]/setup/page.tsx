import Link from "next/link";
import { notFound } from "next/navigation";
import { Banner } from "@/components/Banner";
import { InputsUpload } from "@/components/InputsUpload";
import { SubmitButton } from "@/components/SubmitButton";
import { requireUser } from "@/lib/auth";
import { VISUAL_KINDS } from "@/lib/plan-inputs";
import { MARKETS, POWER, PRODUCT_CLASSES, RADIOS, SETUP_STEPS, setupState, STANDARDS } from "@/lib/setup";
import { createPlan } from "../actions";
import { runFeasibility } from "../risks/actions";
import { saveProject, saveSetupIntake } from "./actions";
import { deriveIntake } from "@/lib/intake-derive";

/** A chip: a checkbox or radio that looks like a pill (the choice is visible at a glance). */
function Chip({ name, value, label, checked, type = "checkbox" }: { name: string; value: string; label: string; checked: boolean; type?: "checkbox" | "radio" }) {
  return <label className="chip-opt"><input type={type} name={name} value={value} defaultChecked={checked} /><span>{label}</span></label>;
}

/** The guided start of a project: five steps, with how ready it is to plan and what has been entered so far. */
export default async function SetupPage({ params, searchParams }: {
  params: Promise<{ projectId: string }>; searchParams: Promise<{ step?: string; error?: string; notice?: string }>;
}) {
  const { projectId } = await params;
  const sp = await searchParams;
  const { supabase } = await requireUser();
  const st = await setupState(supabase, projectId);
  if (!st) notFound();
  const firstOpen = st.stepDone.findIndex((d) => !d);
  const step = Math.min(5, Math.max(1, Number(sp.step) || (firstOpen < 0 ? 5 : firstOpen + 1)));
  const saved = (st.intake ?? {}) as { intended_use?: string; regions?: string[]; quantity?: number; target_unit_cost?: number; currency?: string; max_dimensions?: string;
    power_source?: string; radios?: string[]; target_standards?: string[]; notes?: string };
  // Empty intake fields are filled from what the project already says (answers, requirements, freeze), labelled.
  const d = await deriveIntake(supabase, projectId);
  const filled: string[] = [];
  const pick = <T,>(have: T | undefined, derived: T | null, field: string, empty: (v: T) => boolean): T | undefined => {
    if (have !== undefined && have !== null && !empty(have)) return have;
    if (derived !== null && derived !== undefined && !empty(derived)) { filled.push(field); return derived; }
    return have;
  };
  const i = { ...saved,
    regions: pick(saved.regions, d.regions, "regions", (v) => !v.length),
    radios: pick(saved.radios, d.radios, "radios", (v) => !v.length),
    target_standards: pick(saved.target_standards, d.standards, "standards", (v) => !v.length),
    power_source: pick(saved.power_source, d.power.length ? d.power.join(" + ") : null, "power", (v) => !v),
    max_dimensions: pick(saved.max_dimensions, d.max_dimensions, "max_dimensions", (v) => !v),
    intended_use: pick(saved.intended_use, d.intended_use, "intended_use", (v) => !v),
  };
  const fromWhere = filled.map((f) => d.sources[f]).filter(Boolean);
  const dims = /^(\d+(?:\.\d+)?) × (\d+(?:\.\d+)?) × (\d+(?:\.\d+)?) mm$/.exec(i.max_dimensions ?? "");
  const other = (all: string[], chosen: string[] = []) => chosen.filter((x) => !all.includes(x)).join(", ");
  const powerChosen = (i.power_source ?? "").split(" + ").map((x) => x.trim()).filter(Boolean);
  const S = SETUP_STEPS[step - 1]!;
  const ring = 2 * Math.PI * 52;
  const c = st.counts;
  const manifest = [
    { label: "Identity", text: st.project.code ? `${st.project.name} · ${st.project.code}` : st.project.name, done: st.stepDone[0] },
    { label: "Mock-up", text: `${c.visuals} reference(s) · ${c.concepts} concept round(s)`, done: st.stepDone[1] },
    { label: "Intake", text: `${i.regions?.length ?? 0} market(s) · ${i.radios?.length ?? 0} radio(s)`, done: st.stepDone[2] },
    { label: "Inputs", text: `${c.specs} spec(s) · ${c.requirements} requirement(s) · ${c.parts} part(s)`, done: st.stepDone[3] },
    { label: "Plan", text: c.plans ? `${c.plans} version(s)` : "waiting on inputs", done: st.stepDone[4] },
  ];

  return (
    <main className="setup">
      <p className="crumbs"><Link href="/projects">Projects</Link> / <Link href={`/projects/${projectId}`}>{st.project.name}</Link> / setup</p>
      <div className="title-row"><h1>Set up the project</h1><span className="small muted mono">saved as you go</span></div>
      <Banner error={sp.error} notice={sp.notice} />
      <div className="setup-grid">
        <nav className="card setup-rail" aria-label="Setup steps">
          <h2 className="eyebrow">Sequence</h2>
          {SETUP_STEPS.map((s, k) => (
            <Link key={s.key} href={`/projects/${projectId}/setup?step=${k + 1}`} className={`setup-step${k + 1 === step ? " active" : ""}${st.stepDone[k] ? " done" : ""}`}
              aria-current={k + 1 === step ? "step" : undefined}>
              <span className="step-num">{st.stepDone[k] && k + 1 !== step ? "✓" : String(k + 1).padStart(2, "0")}</span>
              <span><strong>{s.title}</strong><small>{s.sub}</small></span>
            </Link>
          ))}
          <p className="small muted setup-hint">No written spec? Use the <Link href={`/projects/${projectId}/wizard`}>requirement wizard</Link> and the agent drafts requirements with you.</p>
        </nav>

        <section className="card setup-main" data-testid="setup-step" data-step={step}>
          <div className="row spread">
            <p className="eyebrow tech">Step {String(step).padStart(2, "0")} / 05</p>
            <div className="setup-progress"><span className="eyebrow">Readiness</span><span className="mono small">{st.readiness}%</span>
              <div className="progress"><span style={{ width: `${st.readiness}%` }} /></div></div>
          </div>
          <h2 className="setup-title">{["Name the project", "Show how it should look", "Fill in the intake", "Bring in the inputs", "Review and plan"][step - 1]}</h2>
          <p className="muted">{["Give it a name and a one-line purpose. Everything can change later.",
            "Sketches, renders, photos or a product you like: the concept rounds and the enclosure start from these.",
            "The facts the planner and the feasibility check work from.",
            "Specifications become requirements; parts already chosen and earlier work are built on, not redone.",
            "Check what is ready, then generate the plan."][step - 1]}</p>

          {step === 1 && (
            <form action={saveProject.bind(null, projectId)} className="stack">
              <div className="grid2">
                <label>Name<input name="name" required defaultValue={st.project.name} aria-label="Project name" /></label>
                <label>Project code<input name="code" defaultValue={st.project.code ?? ""} placeholder="VXS-001" aria-label="Project code" /></label>
                <label className="span2">Description<textarea name="description" rows={3} defaultValue={st.project.description ?? ""} aria-label="Project description"
                  placeholder="10-inch touchscreen timecode slate for film sets." /></label>
              </div>
              <fieldset className="chips"><legend>Product class</legend>
                {PRODUCT_CLASSES.map(([k, l]) => <Chip key={k} type="radio" name="product_class" value={k} label={l} checked={st.project.product_class === k} />)}</fieldset>
              <p className="small muted">Invite your team and clients from the <Link href={`/projects/${projectId}#members`}>project page</Link>.</p>
              <div className="setup-actions"><span /><SubmitButton pendingText="Saving…">Save and continue →</SubmitButton></div>
            </form>
          )}

          {step === 2 && <div className="stack">
            <p className="small">{c.visuals} reference(s) so far{c.concepts ? `, ${c.concepts} concept round(s)` : ""}. See them on <Link href={`/projects/${projectId}/inputs`}>Project inputs</Link>.</p>
            <InputsUpload projectId={projectId} mode="reference" kinds={VISUAL_KINDS} />
            <div className="callout row spread"><span>Generate concept images from the requirements and these references; the chosen one is frozen as the design.</span>
              <Link className="btn" href={`/projects/${projectId}/concepts`}>Open concepts</Link></div>
            <div className="setup-actions"><Link className="btn" href={`/projects/${projectId}/setup?step=1`}>← Back</Link>
              <Link className="btn btn-primary" href={`/projects/${projectId}/setup?step=3`}>Continue →</Link></div>
          </div>}

          {step === 3 && (
            <form action={saveSetupIntake.bind(null, projectId)} className="stack">
              {filled.length > 0 && <p className="banner" data-testid="intake-prefilled">Filled in from {[...new Set(fromWhere)].join(", ")} ({filled.map((f) => f.replace("_", " ")).join(", ")}). Check it and press Save to keep it.</p>}
              <label>Intended use<input name="intended_use" defaultValue={i.intended_use ?? ""} aria-label="Intended use"
                placeholder="Camera departments on film and TV sets: sync, slate and log takes." /></label>
              <fieldset className="chips"><legend>Target markets</legend>
                {MARKETS.map((m) => <Chip key={m} name="regions" value={m} label={m} checked={!!i.regions?.includes(m)} />)}
                <input name="regions_other" defaultValue={other(MARKETS, i.regions)} placeholder="Others, comma separated" aria-label="Other markets" /></fieldset>
              <div className="grid3">
                <label>First production quantity<input name="quantity" inputMode="numeric" defaultValue={i.quantity ?? ""} aria-label="Quantity" /></label>
                <label>Target unit cost<span className="row tight"><input name="target_unit_cost" inputMode="decimal" defaultValue={i.target_unit_cost ?? ""} aria-label="Target unit cost" style={{ flex: 1, minWidth: 0 }} />
                  <select name="currency" defaultValue={i.currency ?? "USD"} aria-label="Currency">{["USD", "EUR", "GBP", "CAD", "AUD", "JPY"].map((x) => <option key={x}>{x}</option>)}</select></span></label>
                <label>Maximum size (mm)<span className="row tight">
                  {["l", "w", "h"].map((k, n) => <input key={k} name={`dim_${k}`} inputMode="decimal" placeholder={k.toUpperCase()} defaultValue={dims?.[n + 1] ?? ""} aria-label={`Maximum ${["length", "width", "height"][n]}`} style={{ width: "33%", minWidth: 0 }} />)}</span></label>
              </div>
              <fieldset className="chips"><legend>Power source</legend>
                {POWER.map((p) => <Chip key={p} name="power" value={p} label={p} checked={powerChosen.includes(p)} />)}
                <input name="power_other" defaultValue={powerChosen.filter((x) => !POWER.includes(x)).join(" + ")} placeholder="Other (e.g. 2S 3000 mAh)" aria-label="Other power" /></fieldset>
              <fieldset className="chips"><legend>Radios</legend>
                {RADIOS.map((r) => <Chip key={r} name="radios" value={r} label={r} checked={!!i.radios?.includes(r)} />)}
                <input name="radios_other" defaultValue={other(RADIOS, i.radios)} placeholder="Others" aria-label="Other radios" /></fieldset>
              <fieldset className="chips"><legend>Target standards</legend>
                {STANDARDS.map((s) => <Chip key={s} name="target_standards" value={s} label={s} checked={!!i.target_standards?.includes(s)} />)}
                <input name="target_standards_other" defaultValue={other(STANDARDS, i.target_standards)} placeholder="Others" aria-label="Other standards" /></fieldset>
              <label>Notes<textarea name="notes" rows={2} defaultValue={i.notes ?? ""} aria-label="Intake notes" /></label>
              <div className="setup-actions"><Link className="btn" href={`/projects/${projectId}/setup?step=2`}>← Back</Link>
                <SubmitButton pendingText="Saving…">Save and continue →</SubmitButton></div>
            </form>
          )}
          {step === 3 && (
            <form action={runFeasibility.bind(null, projectId)} className="callout row spread">
              <span>⚠ Run a feasibility check: its findings become risks in the register.</span>
              <SubmitButton variant="secondary" pendingText="Checking…">Run feasibility check</SubmitButton></form>
          )}

          {step === 4 && <div className="stack">
            <div className="tiles">
              <Link className="tile" href={`/projects/${projectId}/inputs`}><strong>{c.specs}</strong> specification(s)<span className="muted small">{c.requirements} requirement(s) extracted</span></Link>
              <Link className="tile" href={`/projects/${projectId}/inputs`}><strong>{c.parts}</strong> part(s) already chosen<span className="muted small">datasheets and STEP models</span></Link>
              <Link className="tile" href={`/projects/${projectId}/inputs`}><strong>{c.prior}</strong> imported design(s)<span className="muted small">{c.registerReady ? "earlier-work list built" : "earlier-work list not built"}</span></Link>
            </div>
            <h3>Add specifications</h3>
            <InputsUpload projectId={projectId} mode="specification" />
            <p className="small muted">Extract requirements, add parts and prior work, and build the earlier-work list on <Link href={`/projects/${projectId}/inputs`}>Project inputs</Link>.</p>
            <div className="setup-actions"><Link className="btn" href={`/projects/${projectId}/setup?step=3`}>← Back</Link>
              <Link className="btn btn-primary" href={`/projects/${projectId}/setup?step=5`}>Continue →</Link></div>
          </div>}

          {step === 5 && <div className="stack">
            <ul className="checklist" data-testid="readiness-checks">{st.checks.map((x) => (
              <li key={x.key} className={`check check-${x.done ? "complete" : "pending"}`}><span className="check-icon">{x.done ? "✓" : "○"}</span>
                <span>{x.label} {!x.done && <Link className="small" href={`/projects/${projectId}/setup?step=${x.step + 1}`}>fill in</Link>}</span></li>))}</ul>
            <form action={createPlan.bind(null, projectId, "inputs")} className="setup-actions">
              <Link className="btn" href={`/projects/${projectId}/setup?step=4`}>← Back</Link>
              <div className="row"><Link className="btn" href={`/projects/${projectId}/workspace`}>Open the workspace</Link>
                <SubmitButton disabled={!c.requirements} pendingText="Starting…">Generate the plan</SubmitButton></div>
            </form>
            {!c.requirements && <p className="small muted">Extract requirements first (step 4).</p>}
          </div>}
        </section>

        <aside className="setup-side">
          <div className="card readiness" data-testid="readiness">
            <h2 className="eyebrow">Readiness</h2>
            <svg viewBox="0 0 120 120" className="ring" role="img" aria-label={`${st.readiness}% ready to plan`}>
              <circle cx="60" cy="60" r="52" className="ring-track" />
              <circle cx="60" cy="60" r="52" className="ring-fill" strokeDasharray={`${(ring * st.readiness) / 100} ${ring}`} transform="rotate(-90 60 60)" />
              <text x="60" y="62" textAnchor="middle" className="ring-num">{st.readiness}%</text>
              <text x="60" y="80" textAnchor="middle" className="ring-label">TO PLAN</text>
            </svg>
          </div>
          <div className="card">
            <h2 className="eyebrow">Manifest</h2>
            <ul className="manifest">{manifest.map((m) => <li key={m.label} className={m.done ? "done" : ""}><span className="mdot" /><span><strong>{m.label}</strong><small>{m.text}</small></span></li>)}</ul>
          </div>
          <div className="card">
            <h2 className="eyebrow">Activity</h2>
            <ul className="syslog mono">{st.log.length ? st.log.map((l, k) => <li key={k}><span>{k === 0 ? "›" : "✓"}</span> {l.text}</li>) : <li>· nothing yet</li>}</ul>
          </div>
        </aside>
      </div>
    </main>
  );
}
