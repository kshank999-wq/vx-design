import "server-only";
import { answer, loadContext, withKnowledge, type AssistantReply, type ProjectContext } from "@/lib/assistant";
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
                                 onText?: (delta: string) => void,
                                 opts: { ctx?: ProjectContext; pause?: boolean; extra?: Record<string, unknown> } = {}): Promise<string | null> {
  const ctx = opts.ctx ?? await loadContext(supabase, projectId);
  if (!ctx) return "Project not found.";
  let reply: AssistantReply | null = null, failed: string | null = null;
  try {
    reply = await answer(await withKnowledge(supabase, ctx, question), question, onText);
  } catch (e) {
    failed = `I could not answer just now (${(e as Error).message.slice(0, 200)}). The team can still see your message.`;
  }
  // New information that changes the plan: the work stops where it is (nothing more is built on the old plan) until the
  // member confirms the updated plan or says to carry on. Only owners and engineers can pause; for others it is noted.
  let paused: string[] = [];
  const changes = reply ? [reply.suggested_plan_change, ...(reply.more_plan_changes ?? [])].filter(Boolean) : [];
  if (opts.pause !== false && reply?.new_information && (changes.length || (reply.discrepancies ?? []).length)) {
    const { data: going } = await supabase.from("runs").select("id").eq("project_id", projectId).in("status", ["running", "pending"]);
    for (const r of going ?? []) {
      const { error: pe } = await supabase.rpc("control_run", { p_run_id: r.id, p_action: "pause" });
      if (!pe) paused.push(r.id);
    }
    if (paused.length) paused = [...new Set(paused)];
  }
  const body = reply ? reply.answer + (paused.length ? "\n\n(I have paused the work so nothing more is built on the old plan. Press \"Yes, update the plan\" to draft it, or \"No, carry on\" to resume.)" : "") : failed!;
  const data = JSON.stringify(reply
    ? { model: reply.label, offline: reply.offline, references: reply.references, suggested_requirement_change: reply.suggested_requirement_change,
        suggested_plan_change: reply.suggested_plan_change, more_plan_changes: reply.more_plan_changes ?? [], new_information: !!reply.new_information,
        discrepancies: reply.discrepancies ?? [], paused_runs: paused, citations: reply.citations, ...(opts.extra ?? {}) }
    : { error: true });
  const { error } = await supabase.rpc("post_message", { p_project_id: projectId, p_question: question, p_answer: body, p_data: data,
    ...signAssistantAnswer({ projectId, userId, question, answer: body, data }) });
  return error ? error.message : null;
}

/**
 * Before a plan is approved: the agent compares every task brief of that plan with the concept look, the design freeze and
 * the mock-ups, and posts the differences (with the plan update it proposes) in the chat. Returns how many it found, or an
 * error. The plan is checked once; the message is marked with the plan's id.
 */
export async function checkPlanAgainstConcepts(supabase: Supabase, userId: string, projectId: string, planId: string): Promise<{ found: number; error: string | null }> {
  const ctx = await loadContext(supabase, projectId);
  if (!ctx) return { found: 0, error: "Project not found." };
  const [{ data: plan }, { data: tasks }, { data: refs }] = await Promise.all([
    supabase.from("plans").select("version, summary").eq("id", planId).single(),
    supabase.from("tasks").select("id, key, title, discipline, status, blocker_reason, stage, plain_summary, description").eq("plan_id", planId).order("position"),
    supabase.from("project_references").select("ref_no, title, note, kind").eq("project_id", projectId).in("kind", ["mockup", "sketch", "render", "photo", "drawing"]).order("ref_no"),
  ]);
  if (!plan) return { found: 0, error: "Plan not found." };
  // The plan being checked stands in for the approved one, with every brief shown (none is complete in the planner's eyes).
  const checked: ProjectContext = { ...ctx, plan: { version: plan.version, summary: plan.summary },
    tasks: (tasks ?? []).map((t) => ({ ...t, status: t.status === "complete" ? "ready" : t.status })) };
  const mocks = (refs ?? []).map((r) => `- REF-${r.ref_no} (${r.kind}) "${r.title}"${r.note ? `: ${r.note}` : ""}`).join("\n");
  const question = `Before plan v${plan.version} is approved, check it: compare every task brief in TASKS with the CONCEPTS look, the design freeze, ` +
    `the requirements and these mock-ups and reference images:\n${mocks || "- (no mock-ups recorded)"}\n` +
    `Treat any brief that contradicts them (a material, a construction method, a part, a shape or a size) as new information: list each one in ` +
    `discrepancies, propose the task changes that would fix them, and ask whether that is correct. If everything agrees, say so plainly.`;
  const before = (await supabase.from("project_messages").select("id").eq("project_id", projectId).order("id", { ascending: false }).limit(1)).data?.[0]?.id ?? 0;
  const err = await askAndPost(supabase, userId, projectId, question, undefined, { ctx: checked, pause: false, extra: { concept_check_plan: planId } });
  if (err) return { found: 0, error: err };
  const { data: posted } = await supabase.from("project_messages").select("data").eq("project_id", projectId).eq("author_kind", "assistant").gt("id", before).order("id", { ascending: false }).limit(1);
  const d = (posted?.[0]?.data ?? {}) as { discrepancies?: unknown[] };
  return { found: (d.discrepancies ?? []).length, error: null };
}
