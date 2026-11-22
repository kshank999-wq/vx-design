"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { checkFeasibility } from "@vx/planning";
import { fail, requireUser } from "@/lib/auth";
import { RISK_CATEGORIES, RISK_STATUSES, STAGES } from "@/lib/stages";

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const items = (f: FormData, k: string) => str(f, k).split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);
const back = (projectId: string, msg: string, hash = "", tab = "register") => {
  revalidatePath(`/projects/${projectId}/risks`);
  redirect(`/projects/${projectId}/risks?tab=${tab}&notice=${encodeURIComponent(msg)}${hash}`);
};

export async function saveIntake(projectId: string, form: FormData) {
  const path = `/projects/${projectId}/risks?tab=intake`;
  const { supabase } = await requireUser();
  const quantity = str(form, "quantity");
  const cost = str(form, "target_unit_cost");
  if (quantity && !/^\d+$/.test(quantity)) fail(path, "Quantity is a whole number.");
  if (cost && !/^\d+(\.\d+)?$/.test(cost)) fail(path, "Target unit cost is a number.");
  const { error } = await supabase.rpc("save_intake", { p_project: projectId, p_intake: {
    intended_use: str(form, "intended_use"), regions: items(form, "regions"), quantity, target_unit_cost: cost,
    currency: str(form, "currency"), max_dimensions: str(form, "max_dimensions"), power_source: str(form, "power_source"),
    radios: items(form, "radios"), target_standards: items(form, "target_standards"), notes: str(form, "notes"),
  } });
  if (error) fail(path, error);
  back(projectId, "Intake saved. Run the feasibility check to update the risks.", "", "intake");
}

/** Runs the deterministic feasibility rules over the intake and requirements and files the findings. */
export async function runFeasibility(projectId: string) {
  const path = `/projects/${projectId}/risks?tab=register`;
  const { supabase } = await requireUser();
  const [{ data: intake }, { data: reqs, error: e1 }] = await Promise.all([
    supabase.from("project_intake").select("*").eq("project_id", projectId).maybeSingle(),
    supabase.from("requirements").select("ref_code, kind, text, acceptance_criteria, status").eq("project_id", projectId).order("ref_code"),
  ]);
  if (e1) fail(path, e1);
  const { findings, gaps } = checkFeasibility(intake, reqs ?? []);
  const { data, error } = await supabase.rpc("record_feasibility", { p_project: projectId, p_findings: findings, p_gaps: gaps });
  if (error) fail(path, error);
  const r = data as { added: number; refreshed: number; closed: number };
  back(projectId, `Feasibility check: ${findings.length} finding(s): ${r.added} new, ${r.refreshed} already known, ${r.closed} closed as no longer detected.` +
    (gaps.length ? ` Missing from the intake: ${gaps.join(", ")}.` : ""));
}

export async function addRisk(projectId: string, form: FormData) {
  const path = `/projects/${projectId}/risks?tab=register`;
  const { supabase } = await requireUser();
  const category = str(form, "category"), stage = str(form, "stage");
  if (!RISK_CATEGORIES.includes(category as never) || !STAGES.includes(stage as never)) fail(path, "Choose a category and a stage.");
  const { error } = await supabase.rpc("add_risk", {
    p_project: projectId, p_title: str(form, "title"), p_category: category, p_stage: stage,
    p_likelihood: Number(str(form, "likelihood")), p_impact: Number(str(form, "impact")),
    p_description: str(form, "description") || null, p_mitigation: str(form, "mitigation") || null, p_requirement_refs: items(form, "requirement_refs"),
  });
  if (error) fail(path, error);
  back(projectId, "Risk added.");
}

export async function updateRisk(projectId: string, riskId: string, form: FormData) {
  const path = `/projects/${projectId}/risks?tab=register`;
  const { supabase } = await requireUser();
  const status = str(form, "status");
  if (!RISK_STATUSES.includes(status as never)) fail(path, "Choose a status.");
  const { error } = await supabase.rpc("update_risk", {
    p_risk: riskId, p_status: status, p_likelihood: Number(str(form, "likelihood")) || null, p_impact: Number(str(form, "impact")) || null,
    p_mitigation: str(form, "mitigation") || null, p_stage: str(form, "stage") || null, p_note: str(form, "note") || null,
  });
  if (error) fail(path, error);
  back(projectId, "Risk updated.", `#risk-${riskId}`);
}
