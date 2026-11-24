"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { fail, requireUser } from "@/lib/auth";
import { askAndPost } from "@/lib/chat";
import { QREF } from "@/lib/question-ref";

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

/**
 * "I have a question about this": asks the design assistant about one open question before answering it. The
 * assistant gets the question, why it matters, the choices and the recommendation, and is asked to explain in plain
 * words; the exchange is kept in the project chat and shown under the question.
 */
export async function askAboutQuestion(projectId: string, questionId: string, form: FormData) {
  const path = `/projects/${projectId}/questions`;
  const { supabase, userId } = await requireUser();
  const ask = String(form.get("ask") ?? "").trim();
  if (ask.length < 2) fail(path, "Type what you would like to know first.");
  const { data: q } = await supabase.from("project_questions").select("id, question, why, recommendation, options").eq("id", questionId).eq("project_id", projectId).maybeSingle();
  if (!q) fail(path, "That question was not found.");
  const choices = ((q.options as string[] | null) ?? []).map((o) => `- ${o}`).join("\n");
  const message = `${QREF(questionId)} About the question "${q.question}"` +
    (q.why ? ` (why it matters: ${q.why})` : "") + `. VX Design recommends: ${q.recommendation}.` +
    (choices ? `\nThe choices are:\n${choices}` : "") +
    `\n\nMy question: ${ask}\n\nPlease explain in plain, everyday words what this means for the project, what each choice would lead to (cost, time, risk), and why the recommendation is suggested.`;
  const err = await askAndPost(supabase, userId, projectId, message.slice(0, 4000));
  if (err) fail(path, err);
  revalidatePath(path);
  redirect(`${path}?notice=${encodeURIComponent("Answered below the question.")}#q-${questionId}`);
}
