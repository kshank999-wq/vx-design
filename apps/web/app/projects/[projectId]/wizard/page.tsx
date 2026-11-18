import Link from "next/link";
import { notFound } from "next/navigation";
import { IP_RATINGS, POWER_SOURCES, SETTINGS, WIZARD_STEPS, wizardRequirements, type WizardAnswers } from "@vx/planning";
import { Banner } from "@/components/Banner";
import { SubmitButton } from "@/components/SubmitButton";
import { requireUser } from "@/lib/auth";
import { applyWizard, saveStep } from "./actions";

const MARKETS = ["US", "CA", "EU", "UK", "AU/NZ", "JP"];
const RADIOS = ["Bluetooth LE", "Wi-Fi 2.4 GHz", "Wi-Fi 5 GHz", "LoRa", "Cellular (LTE-M / NB-IoT)", "NFC", "GPS / GNSS"];
const WIRED = ["USB-C", "Ethernet", "CAN", "RS-485", "Audio jack", "HDMI", "microSD card"];
const Check = ({ name, value, on, label }: { name: string; value: string; on: boolean; label?: string }) => (
  <label className="inline" style={{ display: "inline-flex", marginRight: 12 }}><input type="checkbox" name={name} value={value} defaultChecked={on} />{" "}{label ?? value}</label>
);

export default async function WizardPage({ params, searchParams }: {
  params: Promise<{ projectId: string }>; searchParams: Promise<{ step?: string; error?: string; notice?: string }>;
}) {
  const { projectId } = await params;
  const { step: s, error, notice } = await searchParams;
  const { supabase, userId } = await requireUser();
  const [{ data: project }, { data: me }, { data: intake }, { data: existing }] = await Promise.all([
    supabase.from("projects").select("name").eq("id", projectId).maybeSingle(),
    supabase.from("project_members").select("role").eq("project_id", projectId).eq("user_id", userId).maybeSingle(),
    supabase.from("project_intake").select("wizard, wizard_updated_at").eq("project_id", projectId).maybeSingle(),
    supabase.from("requirements").select("ref_code, text, acceptance_criteria, priority, status, wizard_key, task_requirements(task_id)").eq("project_id", projectId).eq("origin", "wizard"),
  ]);
  if (!project) notFound();
  const role = me?.role ?? "viewer";
  const canAnswer = ["owner", "engineer", "client"].includes(role);
  const canApply = role === "owner" || role === "engineer";
  const a = (intake?.wizard ?? {}) as WizardAnswers;
  const step = Math.min(WIZARD_STEPS.length, Math.max(0, Number(s ?? 0) || 0));
  const save = saveStep.bind(null, projectId, step);
  const p = a.product ?? {}, m = a.markets ?? {}, pw = a.power ?? {}, c = a.connectivity ?? {}, ph = a.physical ?? {}, x = a.extras ?? {};
  const nav = (
    <div className="row tight">
      {step > 0 && <button className="btn" type="submit" name="back" value="1">← Back</button>}
      <SubmitButton pendingText="Saving…">{step === WIZARD_STEPS.length - 1 ? "Save and review" : "Save and continue"}</SubmitButton>
    </div>
  );
  const fieldset = (children: React.ReactNode) => (
    <form action={save} className="stack card" data-testid={`step-${WIZARD_STEPS[step]?.key}`}><fieldset disabled={!canAnswer} className="stack">{children}</fieldset>{canAnswer && nav}</form>
  );
  const review = step === WIZARD_STEPS.length;
  const reqs = review ? wizardRequirements(a) : [];
  const byKey = new Map((existing ?? []).map((r) => [r.wizard_key as string, r]));

  return (
    <main>
      <p className="crumbs"><Link href="/projects">Projects</Link> / <Link href={`/projects/${projectId}`}>{project.name}</Link> /</p>
      <h1>Requirement wizard</h1>
      <p className="muted">Plain questions about the product, for when there is no written specification yet (or to fill its gaps). The answers
        become the project&apos;s intake facts and draft requirements, each with acceptance criteria and the answer it came from. Nothing is
        guessed: a blank answer gives no requirement. The team confirms each requirement before work is planned against it.</p>
      <Banner error={error} notice={notice} />
      <ol className="row tight small" data-testid="wizard-steps" style={{ listStyle: "none", padding: 0 }}>
        {[...WIZARD_STEPS, { key: "review", title: "Review" }].map((w, i) => (
          <li key={w.key}><Link href={`/projects/${projectId}/wizard?step=${i}`} className={`pill ${i === step ? "pill-complete" : ""}`}>{i + 1}. {w.title}</Link></li>
        ))}
      </ol>
      {intake?.wizard_updated_at && <p className="small muted">Answers last saved {new Date(intake.wizard_updated_at).toLocaleString()}.</p>}

      {step === 0 && fieldset(<>
        <h2>Product and use</h2>
        <label>What should the product do, in a sentence or two?<textarea name="purpose" rows={2} defaultValue={p.purpose ?? ""} aria-label="Purpose" /></label>
        <label>Who uses it?<input name="users" defaultValue={p.users ?? ""} aria-label="Users" placeholder="e.g. camera crews, nurses, hobbyists" /></label>
        <div>Where is it used?<div>{Object.entries(SETTINGS).map(([k, l]) => <Check key={k} name="settings" value={k} label={l} on={(p.settings ?? []).includes(k)} />)}</div></div>
        <div className="grid2">
          <label>First production quantity<input name="quantity" type="number" min={1} defaultValue={p.quantity ?? ""} aria-label="Quantity" /></label>
          <label>Target unit cost<input name="unit_cost" type="number" step="0.01" min={0} defaultValue={p.unit_cost ?? ""} aria-label="Target unit cost" /></label>
          <label>Currency<input name="currency" defaultValue={p.currency ?? "USD"} aria-label="Currency" /></label>
          <label>Expected product lifetime (years)<input name="lifetime_years" type="number" min={0} defaultValue={p.lifetime_years ?? ""} aria-label="Lifetime" /></label>
        </div>
      </>)}

      {step === 1 && fieldset(<>
        <h2>Markets</h2>
        <div>Where will it be sold?<div>{MARKETS.map((r) => <Check key={r} name="regions" value={r} on={(m.regions ?? []).includes(r)} />)}</div></div>
        <label>Other markets<input name="other" defaultValue={m.other ?? ""} aria-label="Other markets" /></label>
      </>)}

      {step === 2 && fieldset(<>
        <h2>Power</h2>
        <label>How is it powered?<select name="source" defaultValue={pw.source ?? ""} aria-label="Power source"><option value="">(not decided)</option>
          {Object.entries(POWER_SOURCES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        <div className="grid2">
          <label>Battery life wanted (hours)<input name="battery_hours" type="number" min={0} step="0.5" defaultValue={pw.battery_hours ?? ""} aria-label="Battery hours" /></label>
          <label>Hours of use per day<input name="active_hours_per_day" type="number" min={0} max={24} step="0.5" defaultValue={pw.active_hours_per_day ?? ""} aria-label="Hours per day" /></label>
          <label>Standby wanted (days)<input name="standby_days" type="number" min={0} defaultValue={pw.standby_days ?? ""} aria-label="Standby days" /></label>
        </div>
        <Check name="usb_c_charging" value="on" on={!!pw.usb_c_charging} label="Charges from USB-C" />
      </>)}

      {step === 3 && fieldset(<>
        <h2>Connectivity and controls</h2>
        <div>Wireless<div>{RADIOS.map((r) => <Check key={r} name="radios" value={r} on={(c.radios ?? []).includes(r)} />)}</div></div>
        <label>Other wireless (comma separated)<input name="radios_other" defaultValue={(c.radios ?? []).filter((r) => !RADIOS.includes(r)).join(", ")} aria-label="Other radios" /></label>
        <label>Wireless range needed (m)<input name="radio_range_m" type="number" min={0} defaultValue={c.radio_range_m ?? ""} aria-label="Radio range" /></label>
        <Check name="phone_app" value="on" on={!!c.phone_app} label="Works with a phone app" />
        <div>Wired connections<div>{WIRED.map((w) => <Check key={w} name="wired" value={w} on={(c.wired ?? []).includes(w)} />)}</div></div>
        <label>Other wired (comma separated)<input name="wired_other" defaultValue={(c.wired ?? []).filter((w) => !WIRED.includes(w)).join(", ")} aria-label="Other wired" /></label>
        <div className="grid2">
          <label>Display<select name="display" defaultValue={c.display ?? "none"} aria-label="Display">
            {[["none", "none"], ["leds", "status LEDs only"], ["LED segment", "LED segment"], ["LCD", "LCD"], ["OLED", "OLED"], ["touchscreen", "touchscreen"], ["e-paper", "e-paper"]]
              .map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
          <label>Display size (inches)<input name="display_size_in" type="number" min={0} step="0.1" defaultValue={c.display_size_in ?? ""} aria-label="Display size" /></label>
          <label>Physical buttons<input name="buttons" type="number" min={0} defaultValue={c.buttons ?? ""} aria-label="Buttons" /></label>
          <label>Sound<select name="audio" defaultValue={c.audio ?? "none"} aria-label="Audio">{["none", "buzzer", "speaker"].map((v) => <option key={v}>{v}</option>)}</select></label>
        </div>
      </>)}

      {step === 4 && fieldset(<>
        <h2>Size and environment</h2>
        <div className="grid2">
          <label>Maximum length (mm)<input name="max_l_mm" type="number" min={0} defaultValue={ph.max_l_mm ?? ""} aria-label="Max length" /></label>
          <label>Maximum width (mm)<input name="max_w_mm" type="number" min={0} defaultValue={ph.max_w_mm ?? ""} aria-label="Max width" /></label>
          <label>Maximum height (mm)<input name="max_h_mm" type="number" min={0} defaultValue={ph.max_h_mm ?? ""} aria-label="Max height" /></label>
          <label>Maximum weight (g)<input name="max_weight_g" type="number" min={0} defaultValue={ph.max_weight_g ?? ""} aria-label="Max weight" /></label>
          <label>Coldest it must work at (°C)<input name="temp_min_c" type="number" defaultValue={ph.temp_min_c ?? ""} aria-label="Min temperature" /></label>
          <label>Hottest it must work at (°C)<input name="temp_max_c" type="number" defaultValue={ph.temp_max_c ?? ""} aria-label="Max temperature" /></label>
          <label>Dust and water protection<select name="ip" defaultValue={ph.ip ?? ""} aria-label="IP rating"><option value="">(not decided)</option>
            {IP_RATINGS.map((r) => <option key={r} value={r}>{r === "none" ? "none needed" : r}</option>)}</select></label>
          <label>Drop it must survive (m)<input name="drop_m" type="number" min={0} step="0.1" defaultValue={ph.drop_m ?? ""} aria-label="Drop height" /></label>
          <label>How it is held or mounted<select name="mounting" defaultValue={ph.mounting ?? ""} aria-label="Mounting"><option value="">(not decided)</option>
            {["handheld", "desktop", "wall_mounted", "DIN_rail", "vehicle_mounted", "worn"].map((v) => <option key={v} value={v}>{v.replace(/_/g, " ")}</option>)}</select></label>
          <label>Colour and finish<input name="finish" defaultValue={ph.finish ?? ""} aria-label="Finish" placeholder="e.g. matte black, soft-touch" /></label>
        </div>
      </>)}

      {step === 5 && fieldset(<>
        <h2>Anything else</h2>
        <label>Standards it must meet, if known (one per line)<textarea name="standards" rows={2} defaultValue={(x.standards ?? []).join("\n")} aria-label="Standards" /></label>
        <label>Other needs, one per line (each becomes a requirement, worded as you write it)<textarea name="needs" rows={4} defaultValue={x.needs ?? ""} aria-label="Other needs" /></label>
      </>)}

      {review && (
        <section>
          <h2>Review</h2>
          <p className="small">{reqs.length} requirement(s) from the answers. New ones are added as drafts; changed ones are updated and go back to draft;
            ones the plan already uses are left as they are.</p>
          <table className="small" data-testid="wizard-review">
            <thead><tr><th>Requirement</th><th>Acceptance</th><th>From</th><th>On the project</th></tr></thead>
            <tbody>{reqs.map((r) => {
              const e = byKey.get(r.key);
              const state = !e ? "new" : e.text === r.text && e.acceptance_criteria === r.acceptance_criteria && e.priority === r.priority ? `${e.ref_code}, unchanged`
                : (e.task_requirements as unknown[]).length ? `${e.ref_code}, changed but used by the plan: kept` : `${e.ref_code}, will be updated`;
              return <tr key={r.key} data-key={r.key}><td><span className="pill">{r.priority}</span> {r.text}</td><td>{r.acceptance_criteria}</td>
                <td className="muted">{r.basis}</td><td>{state}</td></tr>;
            })}{!reqs.length && <tr><td colSpan={4} className="muted">No answers yet.</td></tr>}</tbody>
          </table>
          {canApply ? reqs.length > 0 && (
            <form action={applyWizard.bind(null, projectId)} className="row tight">
              <SubmitButton pendingText="Creating…">Create and update requirements</SubmitButton>
              <span className="small muted">Also saves the intake (markets, power, radios, size…) used by the feasibility check and compliance suggestions.</span>
            </form>
          ) : <p className="small muted">The engineering team turns these answers into requirements.</p>}
        </section>
      )}
    </main>
  );
}
