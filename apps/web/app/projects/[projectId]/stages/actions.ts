"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { fail, requireUser } from "@/lib/auth";
import { STAGES } from "@/lib/stages";

const back = (projectId: string, msg: string) => {
  revalidatePath(`/projects/${projectId}/stages`);
  redirect(`/projects/${projectId}/stages?notice=${encodeURIComponent(msg)}`);
};

export async function signOffStage(projectId: string, stage: string, form: FormData) {
  const path = `/projects/${projectId}/stages`;
  if (!STAGES.includes(stage as never)) fail(path, "Unknown stage.");
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("sign_off_stage", {
    p_project: projectId, p_stage: stage, p_note: String(form.get("note") ?? "").trim() || null, p_waive: form.get("waive") === "on",
  });
  if (error) fail(path, error);
  back(projectId, `${stage} signed off.`);
}

export async function reopenStage(projectId: string, stage: string, form: FormData) {
  const path = `/projects/${projectId}/stages`;
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("reopen_stage", { p_project: projectId, p_stage: stage, p_reason: String(form.get("reason") ?? "") });
  if (error) fail(path, error);
  back(projectId, `${stage} reopened: later stages' tasks wait until it is signed off again.`);
}

export async function setStageGates(projectId: string, on: boolean) {
  const path = `/projects/${projectId}/stages`;
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("set_stage_gates", { p_project: projectId, p_on: on });
  if (error) fail(path, error);
  back(projectId, on ? "Stage gates on: work waits for each stage's sign-off." : "Stage gates off: runs work through the plan without stopping at stages.");
}
