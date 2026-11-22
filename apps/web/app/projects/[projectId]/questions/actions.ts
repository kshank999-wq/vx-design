"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { fail, requireUser } from "@/lib/auth";

/** Answers a question raised by finished work: one of its choices, a written answer, the recommendation, or set aside. */
export async function answerQuestion(projectId: string, questionId: string, form: FormData) {
  const path = `/projects/${projectId}/questions`;
  const { supabase } = await requireUser();
  const choice = String(form.get("answer") ?? "");
  const custom = String(form.get("custom") ?? "").trim();
  const dismiss = choice === "__dismiss";
  if (choice === "__custom" && !custom) fail(path, "Write your answer first, or pick one of the choices.");
  // Text typed in the box wins (Enter in the box submits with the first button, which may be a choice).
  const answer: string | null = choice === "__recommended" || dismiss ? null : custom || choice || null;
  const { error } = await supabase.rpc("answer_question", { p_question: questionId, p_answer: answer, p_dismiss: dismiss });
  if (error) fail(path, error);
  revalidatePath(path);
  revalidatePath(`/projects/${projectId}/workspace`);
  redirect(`${path}?notice=${encodeURIComponent(dismiss ? "Question set aside." : "Saved: the next steps will follow your answer.")}`);
}

/** Takes VX Design's recommendation for every open question at once. */
export async function acceptAllRecommendations(projectId: string) {
  const path = `/projects/${projectId}/questions`;
  const { supabase } = await requireUser();
  const { data: open } = await supabase.from("project_questions").select("id").eq("project_id", projectId).eq("status", "open");
  let n = 0;
  for (const q of open ?? []) {
    const { error } = await supabase.rpc("answer_question", { p_question: q.id, p_answer: null, p_dismiss: false });
    if (error) fail(path, error);
    n++;
  }
  revalidatePath(path);
  revalidatePath(`/projects/${projectId}/workspace`);
  redirect(`${path}?notice=${encodeURIComponent(`${n} recommendation(s) accepted. You can change any answer below.`)}`);
}
