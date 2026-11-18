"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { KIND_CODES, WIZARD_STEPS, wizardIntake, wizardRequirements, type WizardAnswers } from "@vx/planning";
import { fail, requireUser } from "@/lib/auth";

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const num = (f: FormData, k: string) => { const s = str(f, k); return s === "" || !Number.isFinite(Number(s)) ? null : Number(s); };
const many = (f: FormData, k: string) => [...f.getAll(k).map(String), ...str(f, `${k}_other`).split(/[,;]/)].map((x) => x.trim()).filter(Boolean);
const base = (projectId: string) => `/projects/${projectId}/wizard`;

/** Reads one step's form into the answers. */
function readStep(step: string, f: FormData): Partial<WizardAnswers> {
  switch (step) {
    case "product": return { product: { purpose: str(f, "purpose"), users: str(f, "users"), settings: f.getAll("settings").map(String), quantity: num(f, "quantity"),
      unit_cost: num(f, "unit_cost"), currency: str(f, "currency") || "USD", lifetime_years: num(f, "lifetime_years") } };
    case "markets": return { markets: { regions: f.getAll("regions").map(String), other: str(f, "other") } };
    case "power": return { power: { source: str(f, "source"), battery_hours: num(f, "battery_hours"), active_hours_per_day: num(f, "active_hours_per_day"),
      standby_days: num(f, "standby_days"), usb_c_charging: f.get("usb_c_charging") === "on" } };
    case "connectivity": return { connectivity: { radios: many(f, "radios"), radio_range_m: num(f, "radio_range_m"), wired: many(f, "wired"),
      phone_app: f.get("phone_app") === "on", display: str(f, "display") || "none", display_size_in: num(f, "display_size_in"), buttons: num(f, "buttons"),
      audio: str(f, "audio") || "none" } };
    case "physical": return { physical: { max_l_mm: num(f, "max_l_mm"), max_w_mm: num(f, "max_w_mm"), max_h_mm: num(f, "max_h_mm"), max_weight_g: num(f, "max_weight_g"),
      temp_min_c: num(f, "temp_min_c"), temp_max_c: num(f, "temp_max_c"), ip: str(f, "ip") || "", drop_m: num(f, "drop_m"), mounting: str(f, "mounting"), finish: str(f, "finish") } };
    case "extras": return { extras: { standards: str(f, "standards").split(/[;\n]/).map((s) => s.trim()).filter(Boolean), needs: str(f, "needs") } };
    default: return {};
  }
}

export async function saveStep(projectId: string, step: number, form: FormData) {
  const key = WIZARD_STEPS[step]?.key;
  if (!key) fail(base(projectId), "Unknown step.");
  const { supabase } = await requireUser();
  const { data: intake } = await supabase.from("project_intake").select("wizard").eq("project_id", projectId).maybeSingle();
  const answers = { ...((intake?.wizard ?? {}) as WizardAnswers), ...readStep(key, form) };
  const { error } = await supabase.rpc("save_wizard_answers", { p_project: projectId, p_answers: answers });
  if (error) fail(`${base(projectId)}?step=${step}`, error);
  revalidatePath(base(projectId));
  const next = form.get("back") ? step - 1 : step + 1;
  redirect(`${base(projectId)}?step=${Math.max(0, next)}`);
}

export async function applyWizard(projectId: string) {
  const path = `${base(projectId)}?step=${WIZARD_STEPS.length}`;
  const { supabase } = await requireUser();
  const { data: intake } = await supabase.from("project_intake").select("wizard").eq("project_id", projectId).maybeSingle();
  const answers = (intake?.wizard ?? {}) as WizardAnswers;
  const reqs = wizardRequirements(answers).map((r) => ({ ...r, code: KIND_CODES[r.kind] }));
  if (!reqs.length) fail(path, "Answer some questions first.");
  const { data, error } = await supabase.rpc("apply_wizard", { p_project: projectId, p_intake: wizardIntake(answers), p_requirements: reqs });
  if (error) fail(path, error);
  const r = data as { added: string[]; updated: string[]; in_use: string[]; unchanged: number; no_longer_answered: string[] };
  const parts = [`${r.added.length} requirement(s) added`, `${r.updated.length} updated`, `${r.unchanged} unchanged`];
  if (r.in_use.length) parts.push(`left as they are because the plan uses them: ${r.in_use.join(", ")}`);
  if (r.no_longer_answered.length) parts.push(`no longer in the answers (reject them on the project page if they no longer apply): ${r.no_longer_answered.join(", ")}`);
  revalidatePath(`/projects/${projectId}`);
  redirect(`/projects/${projectId}?notice=${encodeURIComponent(`Wizard applied: ${parts.join("; ")}. The intake is updated; review and confirm the new requirements below.`)}`);
}
