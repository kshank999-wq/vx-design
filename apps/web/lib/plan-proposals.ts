import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Where each plan change the design agent proposed in the chat stands. Worked out from the database every time, so a
 * decision made on one screen (workspace, run page, corner chat, questions) shows the same on all of them:
 * - open: nobody has decided yet;
 * - drafted: "Yes, update the plan" made a plan version (its status says whether it is approved);
 * - declined: someone pressed "Not needed";
 * - outdated: a plan was approved after the proposal, or the draft it made was based on a plan that has since been
 *   replaced, so acting on it would undo newer decisions.
 */
export interface ProposalState {
  state: "open" | "drafted" | "declined" | "outdated";
  planId?: string; planVersion?: number; planStatus?: string; note?: string;
}

interface Msg { id: number; author_kind: string; created_at?: string; data: unknown }

export function hasProposal(data: unknown): boolean {
  const d = (data ?? {}) as { suggested_plan_change?: unknown; more_plan_changes?: unknown[]; discrepancies?: unknown[] };
  return !!d.suggested_plan_change || !!d.more_plan_changes?.length || !!d.discrepancies?.length;
}

export async function proposalStates(supabase: SupabaseClient, projectId: string, messages: Msg[]): Promise<Record<string, ProposalState>> {
  const mine = messages.filter((m) => m.author_kind === "assistant" && hasProposal(m.data));
  if (!mine.length) return {};
  const [{ data: plans }, { data: declined }] = await Promise.all([
    supabase.from("plans").select("id, version, status, created_at, approved_at, revised_from_id, generator").eq("project_id", projectId),
    supabase.from("plan_proposal_decisions").select("message_id").eq("project_id", projectId),
  ]);
  const all = plans ?? [];
  const baseline = all.filter((p) => p.status === "approved").sort((a, b) => b.version - a.version)[0] ?? null;
  const byId = new Map(all.map((p) => [p.id as string, p]));
  const fromChat = new Map(all.filter((p) => (p.generator as { chat_message_id?: string } | null)?.chat_message_id)
    .map((p) => [String((p.generator as { chat_message_id: string }).chat_message_id), p]));
  const no = new Set((declined ?? []).map((d) => String(d.message_id)));
  // Messages loaded without their date: look them up.
  const missing = mine.filter((m) => !m.created_at).map((m) => m.id);
  const { data: dates } = missing.length ? await supabase.from("project_messages").select("id, created_at").in("id", missing) : { data: [] };
  const dateOf = new Map([...mine.map((m) => [m.id, m.created_at] as const), ...(dates ?? []).map((d) => [d.id as number, d.created_at as string] as const)]);
  const out: Record<string, ProposalState> = {};
  for (const m of mine) {
    const k = String(m.id);
    const p = fromChat.get(k);
    if (p) {
      const base = p.revised_from_id ? byId.get(p.revised_from_id as string) : null;
      // A draft made before the plan now in use was approved is out of date: approving it would undo that approval.
      const stale = ["draft", "awaiting_approval"].includes(p.status) && !!baseline?.approved_at
        && new Date(baseline.approved_at as string) > new Date(p.created_at as string);
      out[k] = stale
        ? { state: "outdated", planId: p.id, planVersion: p.version, planStatus: p.status,
            note: `drafted as plan v${p.version}${base ? ` from v${base.version}` : ""}, but v${baseline!.version} was approved after that, so this draft is out of date` }
        : { state: "drafted", planId: p.id, planVersion: p.version, planStatus: p.status };
      continue;
    }
    if (no.has(k)) { out[k] = { state: "declined" }; continue; }
    const at = dateOf.get(m.id);
    if (baseline?.approved_at && at && new Date(at) < new Date(baseline.approved_at as string)) {
      out[k] = { state: "outdated", note: `plan v${baseline.version} was approved after this was proposed` };
      continue;
    }
    out[k] = { state: "open" };
  }
  return out;
}
