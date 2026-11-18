"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { fail, requireUser } from "@/lib/auth";

const page = (projectId: string) => `/projects/${projectId}/optimize`;
function done(projectId: string, notice: string): never {
  revalidatePath(page(projectId));
  redirect(`${page(projectId)}?notice=${encodeURIComponent(notice)}`);
}

export async function runAnalysis(projectId: string, form: FormData) {
  const { supabase } = await requireUser();
  const focus = Number(form.get("focus") ?? 100);
  const fee = String(form.get("fee") ?? "").trim();
  const settings: Record<string, unknown> = { focusBoards: focus };
  if (fee) { settings.assemblyFeePerUniquePart = Number(fee); settings.assemblyFeeSource = "entered on the optimization page"; }
  const { error } = await supabase.rpc("request_optimization", { p_project_id: projectId, p_settings: settings });
  if (error) fail(page(projectId), error);
  done(projectId, "Analysis requested: proposals appear here when the worker has priced the alternatives.");
}

export async function decide(projectId: string, proposalId: string, accept: boolean, form: FormData) {
  const { supabase } = await requireUser();
  const note = String(form.get("note") ?? "").trim() || null;
  const { error } = await supabase.rpc("decide_proposal", { p_proposal_id: proposalId, p_accept: accept, p_note: note,
                                                           p_review_acknowledged: form.get("reviewed") === "on" });
  if (error) fail(page(projectId), error);
  done(projectId, accept ? "Accepted: recorded as a decision for the next design revision." : "Rejected: it will not be proposed again.");
}
