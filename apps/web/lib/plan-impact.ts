import "server-only";
import { z } from "zod";
import { ClaudeModel, MeteredModel } from "@vx/planning";
import { projectCostSink, projectSpendGuard } from "@/lib/model";
import type { createClient } from "./supabase/server";

type Supabase = Awaited<ReturnType<typeof createClient>>;

/**
 * What a new plan version means for the work already done, in plain words.
 *
 * Steps are compared with the plan in use by key: removed, added, changed (their own brief changed) and affected (their
 * brief is the same but a step they build on changed). Affected steps used to be redone automatically; the design agent
 * now reviews each one: would the change alter what this step produces? Only those that would are redone; the others keep
 * their finished work (keep_finished_work on approval). The result is stored per plan, so every screen shows the same.
 */
export const ImpactReview = z.object({
  summary: z.string().describe("Two or three plain sentences for someone who is not an engineer: what changes and what it means for the work"),
  steps: z.array(z.object({
    key: z.string(),
    redo: z.boolean().describe("true when the change could alter what this step produces, so it must be done again"),
    why: z.string().describe("One plain sentence, no jargon: why it is redone or why its finished work stays valid"),
  })),
});
export type ImpactReview = z.infer<typeof ImpactReview>;

export interface Impact {
  removed: { key: string; title: string }[];
  added: { key: string; title: string }[];
  changed: { key: string; title: string; was: string; brief: string | null }[];
  affected: { key: string; title: string; because: string[] }[];
  unchanged: number;
  /** Steps that will be done again, in the order the work runs (dependencies first). */
  redoOrder: { key: string; title: string; reason: string }[];
  kept: { key: string; title: string; why: string }[];
  review: (ImpactReview & { model?: string }) | null;
}

type T = { id: string; key: string; title: string; description: string | null; discipline: string; acceptance_tests: unknown; position?: number;
  task_dependencies?: unknown };

const sameBrief = (a: T, b: T) => a.title === b.title && (a.description ?? "") === (b.description ?? "") && a.discipline === b.discipline
  && JSON.stringify(a.acceptance_tests ?? []) === JSON.stringify(b.acceptance_tests ?? []);

/** Classify the steps of `next` against `base` (pure, no AI). */
export function classify(next: T[], base: T[]) {
  const old = new Map(base.map((t) => [t.key, t]));
  const keys = new Set(next.map((t) => t.key));
  const byId = new Map(next.map((t) => [t.id, t]));
  const removed = base.filter((t) => !keys.has(t.key)).map((t) => ({ key: t.key, title: t.title }));
  const added = next.filter((t) => !old.has(t.key));
  const changed = next.filter((t) => old.has(t.key) && !sameBrief(t, old.get(t.key)!));
  const direct = new Set([...added, ...changed].map((t) => t.key));
  // What each step builds on, and which changed steps reach it.
  const ups = new Map(next.map((t) => [t.key, ((t.task_dependencies as { depends_on_task_id: string }[] | null) ?? []).map((d) => byId.get(d.depends_on_task_id)?.key).filter((k): k is string => !!k)]));
  const reach = new Map<string, Set<string>>();
  const sources = (k: string, seen = new Set<string>()): Set<string> => {
    if (reach.has(k)) return reach.get(k)!;
    const out = new Set<string>();
    for (const u of ups.get(k) ?? []) {
      if (seen.has(u)) continue;
      seen.add(u);
      if (direct.has(u)) out.add(u);
      for (const x of sources(u, seen)) out.add(x);
    }
    reach.set(k, out);
    return out;
  };
  const affected = next.filter((t) => !direct.has(t.key) && sources(t.key).size > 0)
    .map((t) => ({ key: t.key, title: t.title, because: [...sources(t.key)] }));
  return {
    removed, added: added.map((t) => ({ key: t.key, title: t.title })),
    changed: changed.map((t) => ({ key: t.key, title: t.title, was: old.get(t.key)!.title, brief: t.description })),
    affected, unchanged: next.length - added.length - changed.length - affected.length,
  };
}

/** The stored review for a plan, applied to the classification. */
export function withReview(next: T[], c: ReturnType<typeof classify>, review: Impact["review"], forceRedo: string[] = []): Impact {
  const decided = new Map((review?.steps ?? []).map((s) => [s.key, s]));
  const keepOf = (k: string) => !forceRedo.includes(k) && decided.get(k)?.redo === false;
  const title = new Map(next.map((t) => [t.key, t.title]));
  const reason = new Map<string, string>([
    ...c.added.map((t) => [t.key, "new step"] as [string, string]),
    ...c.changed.map((t) => [t.key, "its instructions changed"] as [string, string]),
    ...c.affected.map((t) => [t.key, keepOf(t.key) ? "" : decided.get(t.key)?.why ?? `builds on ${t.because.map((k) => title.get(k) ?? k).join(", ")}, which changed`] as [string, string]),
  ]);
  const redo = new Set([...c.added.map((t) => t.key), ...c.changed.map((t) => t.key), ...c.affected.filter((t) => !keepOf(t.key)).map((t) => t.key)]);
  return {
    ...c,
    redoOrder: next.filter((t) => redo.has(t.key)).map((t) => ({ key: t.key, title: t.title, reason: reason.get(t.key) ?? "" })),
    kept: c.affected.filter((t) => keepOf(t.key)).map((t) => ({ key: t.key, title: t.title, why: decided.get(t.key)!.why })),
    review,
  };
}

const SYSTEM = `You review a change to a product design plan before the owner approves it. The owner is usually not an engineer.
Some steps changed (their instructions are given old and new). Other steps were not changed but build on a changed step.
For each of those, decide whether the change could alter what that step produces. Redo it only if it could: for example a
casing material change does not change a circuit board's schematic or layout, but a new board size or connector position
does change the casing. When unsure, redo it. Write every explanation in one short plain sentence without jargon.`;

/** Runs (or returns the stored) impact review for a draft plan against the plan in use. */
export async function reviewPlanImpact(supabase: Supabase, projectId: string, planId: string): Promise<{ impact: Impact | null; error: string | null }> {
  const sel = "id, key, title, description, discipline, acceptance_tests, position, task_dependencies!task_dependencies_task_id_fkey(depends_on_task_id)";
  const [{ data: next }, { data: baseline }, { data: stored }] = await Promise.all([
    supabase.from("tasks").select(sel).eq("plan_id", planId).order("position"),
    supabase.from("plans").select("id, version").eq("project_id", projectId).eq("status", "approved").neq("id", planId).maybeSingle(),
    supabase.from("plan_impact_reviews").select("review").eq("plan_id", planId).maybeSingle(),
  ]);
  if (!baseline || !next) return { impact: null, error: null };
  const { data: base } = await supabase.from("tasks").select(sel).eq("plan_id", baseline.id).order("position");
  const c = classify(next as T[], (base ?? []) as T[]);
  if (stored?.review) return { impact: withReview(next as T[], c, stored.review as Impact["review"]), error: null };
  if (!c.affected.length) return { impact: withReview(next as T[], c, null), error: null };
  if (process.env.VX_LLM === "offline" || !process.env.ANTHROPIC_API_KEY) {
    // Without the agent every affected step is redone (the safe choice), said plainly.
    return { impact: withReview(next as T[], c, null), error: null };
  }
  const oldBrief = new Map((base ?? []).map((t) => [t.key, t]));
  const text = [
    `Changed steps:`,
    ...c.changed.map((t) => `- ${t.key} "${t.title}"\n  BEFORE: ${(oldBrief.get(t.key) as T | undefined)?.description ?? ""}\n  AFTER: ${t.brief ?? ""}`),
    ...c.added.map((t) => `- ${t.key} "${t.title}" (new step): ${(next as T[]).find((x) => x.key === t.key)?.description ?? ""}`),
    ...c.removed.map((t) => `- ${t.key} "${t.title}" (removed)`),
    ``, `Steps that build on them (decide each):`,
    ...c.affected.map((t) => `- ${t.key} "${t.title}": ${(next as T[]).find((x) => x.key === t.key)?.description ?? ""} (builds on ${t.because.join(", ")})`),
  ].join("\n");
  try {
    const model = new MeteredModel(new ClaudeModel({ effort: "low", maxTokens: 6000, model: process.env.VX_ASSISTANT_MODEL }), projectCostSink(projectId), projectSpendGuard(projectId));
    const { output, usage } = await model.generate({ purpose: "plan_impact_review", system: SYSTEM, messages: [{ role: "user", content: text }], schema: ImpactReview });
    const keys = new Set(c.affected.map((t) => t.key));
    const review = { ...output, steps: output.steps.filter((s) => keys.has(s.key)), model: usage.model };
    await supabase.from("plan_impact_reviews").upsert({ plan_id: planId, project_id: projectId, review });
    return { impact: withReview(next as T[], c, review), error: null };
  } catch (e) {
    return { impact: withReview(next as T[], c, null), error: `The design agent could not review the change (${(e as Error).message}); every step that builds on a change will be redone.` };
  }
}
