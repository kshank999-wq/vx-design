import "server-only";
import { answer, loadContext, withKnowledge, type AssistantReply } from "@/lib/assistant";
import { signAssistantAnswer } from "@/lib/sign";
import type { createClient } from "@/lib/supabase/server";

type Supabase = Awaited<ReturnType<typeof createClient>>;
export const MAX_QUESTION = 4000;

export function questionProblem(question: string): string | null {
  if (!question) return "Type a message first.";
  if (question.length > MAX_QUESTION) return `Messages are limited to ${MAX_QUESTION} characters.`;
  return null;
}

/**
 * Answers a question and posts the exchange (signed, so only the web server can write assistant text). If the
 * assistant fails, the question is still posted with a short note, so nothing the member wrote is lost.
 * `onText` receives the reply as it is written. Returns an error message for the member, or null.
 */
export async function askAndPost(supabase: Supabase, userId: string, projectId: string, question: string,
                                 onText?: (delta: string) => void): Promise<string | null> {
  const ctx = await loadContext(supabase, projectId);
  if (!ctx) return "Project not found.";
  let reply: AssistantReply | null = null, failed: string | null = null;
  try {
    reply = await answer(await withKnowledge(supabase, ctx, question), question, onText);
  } catch (e) {
    failed = `I could not answer just now (${(e as Error).message.slice(0, 200)}). The team can still see your message.`;
  }
  const body = reply ? reply.answer : failed!;
  const data = JSON.stringify(reply
    ? { model: reply.label, offline: reply.offline, references: reply.references, suggested_requirement_change: reply.suggested_requirement_change,
        suggested_plan_change: reply.suggested_plan_change, citations: reply.citations }
    : { error: true });
  const { error } = await supabase.rpc("post_message", { p_project_id: projectId, p_question: question, p_answer: body, p_data: data,
    ...signAssistantAnswer({ projectId, userId, question, answer: body, data }) });
  return error ? error.message : null;
}
