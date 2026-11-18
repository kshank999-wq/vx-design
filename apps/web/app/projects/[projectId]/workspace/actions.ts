"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { answer, loadContext, withKnowledge } from "@/lib/assistant";
import { fail, requireUser } from "@/lib/auth";
import { signAssistantAnswer } from "@/lib/sign";

const MAX_QUESTION = 4000;

export async function sendMessage(projectId: string, view: string | null, form: FormData) {
  const path = `/projects/${projectId}/workspace${view ? `?view=${view}` : ""}`;
  const { supabase, userId } = await requireUser();
  const question = String(form.get("message") ?? "").trim();
  if (!question) fail(path, "Type a message first.");
  if (question.length > MAX_QUESTION) fail(path, `Messages are limited to ${MAX_QUESTION} characters.`);
  const ctx = await loadContext(supabase, projectId);
  if (!ctx) fail(path, "Project not found.");
  let reply;
  try {
    reply = await answer(await withKnowledge(supabase, ctx, question), question);
  } catch (e) {
    // Keep the question; say the assistant could not answer instead of losing what the member wrote.
    const failed = `I could not answer just now (${(e as Error).message.slice(0, 200)}). The team can still see your message.`;
    const data = JSON.stringify({ error: true });
    const { error } = await supabase.rpc("post_message", { p_project_id: projectId, p_question: question, p_answer: failed, p_data: data,
      ...signAssistantAnswer({ projectId, userId, question, answer: failed, data }) });
    if (error) fail(path, error);
    revalidatePath(`/projects/${projectId}/workspace`);
    redirect(path);
  }
  const data = JSON.stringify({ model: reply.label, offline: reply.offline, references: reply.references,
                                suggested_requirement_change: reply.suggested_requirement_change, citations: reply.citations });
  const { error } = await supabase.rpc("post_message", {
    p_project_id: projectId, p_question: question, p_answer: reply.answer, p_data: data,
    ...signAssistantAnswer({ projectId, userId, question, answer: reply.answer, data }),
  });
  if (error) fail(path, error);
  revalidatePath(`/projects/${projectId}/workspace`);
  redirect(path);
}

export async function decideFromWorkspace(projectId: string, taskId: string, approve: boolean, form: FormData) {
  const path = `/projects/${projectId}/workspace`;
  const { supabase } = await requireUser();
  const note = String(form.get("note") ?? "").trim() || null;
  if (!approve && !note) fail(path, "Say what needs to change before returning the work.");
  const { error } = await supabase.rpc("decide_task", { p_task_id: taskId, p_approve: approve, p_note: note });
  if (error) fail(path, error);
  revalidatePath(path);
  redirect(`${path}?notice=${encodeURIComponent(approve ? "Approved. The team's next steps are unblocked." : "Returned to the team with your note.")}`);
}
