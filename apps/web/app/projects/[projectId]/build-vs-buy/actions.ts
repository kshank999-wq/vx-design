"use server";
import { redirect } from "next/navigation";
import { buildVsBuyStudy, matchModules, rankOptions, suggestModules } from "@vx/planning";
import { fail, requireUser } from "@/lib/auth";
import { addConfirmedSuggestions, catalogModules, readNeed } from "@/lib/build-vs-buy";
import { getModel } from "@/lib/model";

const FIELDS = ["title", "kind", "interfaces", "radios", "supply_v", "max_x", "max_y", "max_z", "regions", "quantity", "requirements"];
const back = (projectId: string, form: FormData, extra: Record<string, string> = {}) => {
  const q = new URLSearchParams();
  for (const k of FIELDS) { const v = String(form.get(k) ?? "").trim(); if (v) q.set(k, v); }
  for (const [k, v] of Object.entries(extra)) q.set(k, v);
  return `/projects/${projectId}/build-vs-buy?${q}`;
};

/** Asks the model for candidate modules; only part numbers a distributor confirms are added to the catalog (as drafts). */
export async function findModules(projectId: string, form: FormData) {
  const need = readNeed((k) => (form.get(k) as string | null));
  if (!need.title) fail(back(projectId, form), "Say what the subsystem is first.");
  const { supabase } = await requireUser();
  const { data: project } = await supabase.from("projects").select("name, description").eq("id", projectId).single();
  let r: Awaited<ReturnType<typeof addConfirmedSuggestions>>;
  try {
    const { suggestions } = await suggestModules({ ...need, context: `${project?.name ?? ""}: ${project?.description ?? ""}` }, getModel(projectId).model);
    r = await addConfirmedSuggestions(supabase, need, suggestions);
  } catch (e) { fail(back(projectId, form), e); }
  const msg = [r.added.length && `Added to the catalog as drafts: ${r.added.join(", ")}.`, r.existing.length && `Already in the catalog: ${r.existing.join(", ")}.`,
    r.unconfirmed.length && `Not found at the distributors, so left out: ${r.unconfirmed.join(", ")}.`, r.errors.length && `Not saved: ${r.errors.join("; ")}.`]
    .filter(Boolean).join(" ") || "No candidates.";
  redirect(`${back(projectId, form)}&notice=${encodeURIComponent(msg)}`);
}

/** A trade study of the fitting catalog modules against a custom design, scored and ranked. */
export async function compareBuildVsBuy(projectId: string, form: FormData) {
  const need = readNeed((k) => (form.get(k) as string | null));
  if (!need.title) fail(back(projectId, form), "Say what the subsystem is first.");
  const { supabase } = await requireUser();
  const study = buildVsBuyStudy(need, matchModules(need, await catalogModules(supabase)));
  const { data: id, error } = await supabase.rpc("create_trade_study", { p_project: projectId, p_question: study.question, p_criteria: study.criteria,
    p_options: study.options, p_stage: "S2", p_decision_class: "component_selection" });
  if (error) fail(back(projectId, form), error);
  const { error: e2 } = await supabase.rpc("save_trade_study", { p_id: id, p_question: study.question, p_context: study.context,
    p_requirement_refs: need.requirement_refs ?? [], p_criteria: study.criteria, p_options: study.options, p_scores: study.scores,
    p_result: rankOptions(study.criteria, study.options, study.scores) });
  if (e2) fail(back(projectId, form), e2);
  redirect(`/projects/${projectId}/trades/${id}?notice=${encodeURIComponent(`Build vs buy: ${study.options.length - 1} module(s) against a custom design. ` +
    "Fill from catalog for current prices, edit the estimates, then decide.")}`);
}
