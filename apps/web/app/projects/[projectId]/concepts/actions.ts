"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { fail, requireUser } from "@/lib/auth";

const str = (form: FormData, k: string) => String(form.get(k) ?? "").trim();
const pagePath = (projectId: string, form: FormData) => `/projects/${projectId}/concepts${form.get("embed") === "1" ? "?embed=1" : ""}`;
const go = (path: string, notice: string) => redirect(`${path}${path.includes("?") ? "&" : "?"}notice=${encodeURIComponent(notice)}`);

export async function requestConcepts(projectId: string, parentVariantId: string | null, form: FormData) {
  const path = pagePath(projectId, form);
  const { supabase } = await requireUser();
  const refs = form.getAll("reference").map(String).filter(Boolean);
  const args = { p_project_id: projectId, p_direction: str(form, "direction"), p_count: Number(str(form, "count") || 3), p_parent_variant_id: parentVariantId };
  const { error } = refs.length
    ? await supabase.rpc("request_concepts_with_references", { ...args, p_reference_ids: refs })
    : await supabase.rpc("request_concepts", args);
  if (error) fail(path, error);
  revalidatePath(`/projects/${projectId}/concepts`);
  go(path, parentVariantId ? "Refinement requested: new variants appear here when they are ready." : "Concepts requested: they appear here when they are ready.");
}

export async function cancelConcepts(projectId: string, roundId: string, form: FormData) {
  const path = pagePath(projectId, form);
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("cancel_concepts", { p_round_id: roundId });
  if (error) fail(path, error);
  revalidatePath(`/projects/${projectId}/concepts`);
  go(path, "Canceled.");
}

export async function freezeDesign(projectId: string, variantId: string, form: FormData) {
  const path = pagePath(projectId, form);
  const { supabase } = await requireUser();
  const num = (k: string) => Number(str(form, k));
  const { error } = await supabase.rpc("freeze_design", {
    p_variant_id: variantId,
    p_envelope: { length_mm: num("length_mm"), width_mm: num("width_mm"), height_mm: num("height_mm"), basis: str(form, "basis") || "client sign-off" },
    p_cmf: { summary: str(form, "cmf") },
    p_note: str(form, "note") || null,
    p_change_reason: str(form, "change_reason") || null,
  });
  if (error) fail(path, error);
  revalidatePath(`/projects/${projectId}/concepts`);
  revalidatePath(`/projects/${projectId}/workspace`);
  go(path, "Design frozen: recorded as a decision that engineering now works to.");
}
