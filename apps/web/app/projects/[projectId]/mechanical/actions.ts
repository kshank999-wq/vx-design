"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { DEFAULT_H_W_M2K, enclosureStacks, gasket, GASKET_PRESETS, H_BASIS, stack, thermal, thermalFromReports,
         type Contributor, type GasketInput, type HeatSource, type StackInput, type ThermalInput } from "@vx/mech";
import { fail, requireUser } from "@/lib/auth";
import { formNum, formOpt, latestJson, MECH_VERSION, processTolerance, tol } from "@/lib/mech";

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const base = (projectId: string, id?: string) => `/projects/${projectId}/mechanical${id ? `/${id}` : ""}`;
function go(path: string, notice: string): never {
  revalidatePath(path);
  redirect(`${path}?notice=${encodeURIComponent(notice)}`);
}
type Kind = "tolerance_stack" | "gasket" | "thermal";

function compute(kind: Kind, inputs: unknown): { result: object; verdict: string; assumptions: number; problems: string[] } {
  if (kind === "tolerance_stack") {
    const r = stack(inputs as StackInput);
    return { result: r, verdict: r.verdict, assumptions: r.assumed.length, problems: r.problems };
  }
  if (kind === "gasket") {
    const g = inputs as GasketInput;
    const bad = [g.section.nominal, g.gap.nominal, g.min_pct, g.max_pct].some((x) => !Number.isFinite(x)) ? ["fill in the gasket size, gap and compression range"]
      : g.section.nominal <= 0 || g.gap.nominal <= 0 ? ["sizes must be above zero"] : [];
    if (bad.length) return { result: {}, verdict: "no_limit", assumptions: 0, problems: bad };
    const r = gasket(g);
    return { result: r, verdict: r.verdict, assumptions: 0, problems: [] };
  }
  const t = inputs as ThermalInput;
  const bad = [t.power_w, t.box_mm.x, t.box_mm.y, t.box_mm.z, t.h_w_m2k, t.ambient_max_c].some((x) => !Number.isFinite(x)) ? ["fill in the power, box size, coefficient and ambient"]
    : t.h_w_m2k <= 0 || t.box_mm.x <= 0 || t.box_mm.y <= 0 || t.box_mm.z <= 0 ? ["sizes and the coefficient must be above zero"] : [];
  if (bad.length) return { result: {}, verdict: "no_limit", assumptions: 0, problems: bad };
  const r = thermal(t);
  return { result: r, verdict: r.verdict, assumptions: t.h_w_m2k === DEFAULT_H_W_M2K ? 1 : 0, problems: [] };
}

async function save(projectId: string, id: string | null, kind: Kind, title: string, note: string | null, inputs: object) {
  const path = base(projectId, id ?? undefined);
  const c = compute(kind, inputs);
  if (c.problems.length) fail(path, c.problems.join("; "));
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc("save_mech_analysis", { p_project: projectId, p_id: id, p_kind: kind, p_title: title, p_note: note,
    p_inputs: inputs, p_result: c.result, p_verdict: c.verdict, p_assumptions: c.assumptions, p_calc_version: MECH_VERSION });
  if (error) fail(path, error);
  return data as string;
}

/** Starting points: stacks from the committed enclosure, a thermal estimate from the power budget, or a blank analysis. */
export async function addAnalysis(projectId: string, form: FormData) {
  const path = base(projectId);
  const { supabase } = await requireUser();
  const what = str(form, "what");
  if (what === "enclosure_stacks") {
    const fit = await latestJson(supabase, projectId, "fit-report");
    if (!fit) fail(path, "No committed enclosure fit report yet.");
    const proc = await processTolerance(supabase, fit.json.process?.name ?? "fdm");
    const stacks = enclosureStacks(fit.json, proc);
    for (const s of stacks) await save(projectId, null, "tolerance_stack", s.title, `${s.note} From ${fit.name} v${fit.version}.`, s.input);
    go(path, `${stacks.length} stack(s) added from ${fit.name} v${fit.version}. Replace the assumed tolerances with your suppliers' figures.`);
  }
  if (what === "thermal") {
    const [fit, power] = await Promise.all([latestJson(supabase, projectId, "fit-report"), latestJson(supabase, projectId, "power-budget")]);
    const input = fit && power ? thermalFromReports(power.json, fit.json) : null;
    if (!input) fail(path, "The thermal estimate needs a committed power budget and enclosure fit report.");
    const id = await save(projectId, null, "thermal", "Enclosure temperature rise", `From ${power!.name} v${power!.version} and ${fit!.name} v${fit!.version}.`, input);
    go(base(projectId, id), "Thermal estimate added from the power budget and enclosure.");
  }
  if (what === "gasket") {
    const p = GASKET_PRESETS[0]!;
    const input: GasketInput = { kind: p.kind, section: { nominal: 2, plus: 0.08, minus: 0.08 }, gap: { nominal: 1.5, plus: 0.05, minus: 0.05 },
      groove_width: { nominal: 2.8, plus: 0.05, minus: 0.05 }, min_pct: p.min_pct, max_pct: p.max_pct, max_fill_pct: p.max_fill_pct, basis: p.basis };
    const id = await save(projectId, null, "gasket", "Lid gasket", "Example sizes: replace with your gasket and groove.", input);
    go(base(projectId, id), "Gasket check added with example sizes: enter yours.");
  }
  const id = await save(projectId, null, "tolerance_stack", str(form, "title") || "New stack", null,
                        { contributors: [{ name: "Gap", nominal: 1, plus: 0.1, minus: 0.1, sign: 1, basis: "", assumed: true }], min_gap: 0, max_gap: null });
  go(base(projectId, id), "Stack added: enter the chain of dimensions.");
}

export async function saveStack(projectId: string, id: string, form: FormData) {
  const rows = [...new Set([...form.keys()].filter((k) => k.startsWith("c_name_")).map((k) => k.slice(7)))];
  const contributors: Contributor[] = rows.map((i) => ({
    name: str(form, `c_name_${i}`), nominal: formNum(form, `c_nominal_${i}`), plus: formNum(form, `c_plus_${i}`) || 0, minus: formNum(form, `c_minus_${i}`) || 0,
    sign: (str(form, `c_sign_${i}`) === "-1" ? -1 : 1) as 1 | -1, basis: str(form, `c_basis_${i}`), assumed: form.get(`c_assumed_${i}`) === "on",
  })).filter((c) => c.name || Number.isFinite(c.nominal) && c.nominal !== 0);
  await save(projectId, id, "tolerance_stack", str(form, "title"), str(form, "note") || null,
             { contributors, min_gap: formOpt(form, "min_gap"), max_gap: formOpt(form, "max_gap") });
  go(base(projectId, id), "Saved and recalculated.");
}

export async function saveGasket(projectId: string, id: string, form: FormData) {
  const preset = GASKET_PRESETS.find((p) => p.key === str(form, "preset"));
  const kind = (preset?.kind ?? str(form, "kind")) as "oring" | "foam";
  const width = tol(form, "width");
  const input: GasketInput = { kind, section: tol(form, "section"), gap: tol(form, "gap"),
    groove_width: kind === "oring" && Number.isFinite(width.nominal) ? width : null,
    min_pct: preset ? preset.min_pct : formNum(form, "min_pct"), max_pct: preset ? preset.max_pct : formNum(form, "max_pct"),
    max_fill_pct: preset ? preset.max_fill_pct : formOpt(form, "max_fill_pct"), basis: preset ? preset.basis : str(form, "basis") };
  await save(projectId, id, "gasket", str(form, "title"), str(form, "note") || null, input);
  go(base(projectId, id), preset ? `Saved with the ${preset.label} range.` : "Saved and recalculated.");
}

export async function saveThermal(projectId: string, id: string, form: FormData) {
  const rows = [...new Set([...form.keys()].filter((k) => k.startsWith("s_name_")).map((k) => k.slice(7)))];
  const sources: HeatSource[] = rows.map((i) => ({ name: str(form, `s_name_${i}`), watts: formNum(form, `s_watts_${i}`) || 0,
    theta_ja: formOpt(form, `s_theta_${i}`), tj_max: formOpt(form, `s_tjmax_${i}`), basis: str(form, `s_basis_${i}`) })).filter((s) => s.name);
  const h = formNum(form, "h_w_m2k");
  const input: ThermalInput = { power_w: formNum(form, "power_w"), box_mm: { x: formNum(form, "box_x"), y: formNum(form, "box_y"), z: formNum(form, "box_z") },
    h_w_m2k: h, ambient_max_c: formNum(form, "ambient_max_c"), air_limit_c: formOpt(form, "air_limit_c"), sources,
    basis: str(form, "basis") || (h === DEFAULT_H_W_M2K ? H_BASIS : "") };
  await save(projectId, id, "thermal", str(form, "title"), str(form, "note") || null, input);
  go(base(projectId, id), "Saved and recalculated.");
}

export async function reviewAnalysis(projectId: string, id: string, form: FormData) {
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("review_mech_analysis", { p_id: id, p_note: str(form, "review_note") });
  if (error) fail(base(projectId, id), error);
  go(base(projectId, id), "Reviewed.");
}

export async function deleteAnalysis(projectId: string, id: string) {
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("delete_mech_analysis", { p_id: id });
  if (error) fail(base(projectId, id), error);
  go(base(projectId), "Deleted.");
}
