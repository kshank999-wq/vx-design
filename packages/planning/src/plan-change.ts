/**
 * Plan changes proposed in the workspace chat: add, change or remove one task. Applied to a copy of the current plan
 * to make a new draft version, which is reviewed and approved like any other plan; nothing changes the running plan
 * directly. Dependency order is kept: a new task goes after the one it depends on, and removing a task links its
 * dependants to its own dependencies.
 */
import { z } from "zod";

export const DISCIPLINES = ["architecture", "components", "sourcing", "schematic", "pcb_layout", "power", "thermal", "simulation",
  "mechanical", "enclosure", "verification", "manufacturing", "documentation"] as const;

export const PlanChange = z.object({
  action: z.enum(["add_task", "change_task", "remove_task"]),
  task_key: z.string().nullable().describe("Key of the task to change or remove, from TASKS; null when adding"),
  title: z.string().describe("Title of the new task, the changed title, or the title of the task being removed"),
  discipline: z.enum(DISCIPLINES).nullable().describe("Discipline of a new task (or a changed one); null to keep it"),
  description: z.string().describe("What the task does and how its result is accepted; empty to keep it when changing"),
  after_key: z.string().nullable().describe("For a new task: the key of the task it depends on, from TASKS, or null"),
  reason: z.string().describe("Why, in the member's words"),
});
export type PlanChange = z.infer<typeof PlanChange>;

export interface PlanTaskPayload {
  key: string; title: string; discipline: string; description: string | null; required_tools: string[]; acceptance_tests: unknown[];
  approval_required: boolean; approval_reason: string | null; risk_level: string; estimated_hours: number | null;
  upstream_keys: string[]; requirement_refs: string[];
  /** What the task builds on (plan inputs); kept through chat changes. */
  basis?: { mode: string; sources: string[]; reason: string } | null;
}

export function slugKey(title: string, taken: Set<string>): string {
  const base = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "task";
  let key = base, n = 2;
  while (taken.has(key)) key = `${base}-${n++}`;
  return key;
}

/** Applies a change to a copy of the plan's tasks (in plan order). Throws with a plain message when it cannot apply. */
export function applyPlanChange(tasks: PlanTaskPayload[], c: PlanChange): PlanTaskPayload[] {
  const out = tasks.map((t) => ({ ...t, upstream_keys: [...t.upstream_keys] }));
  const find = (key: string | null) => out.findIndex((t) => t.key === key);
  if (c.action === "add_task") {
    if (!c.title.trim()) throw new Error("the new task needs a title");
    const after = c.after_key ? find(c.after_key) : -1;
    if (c.after_key && after < 0) throw new Error(`there is no task ${c.after_key} to follow`);
    const task: PlanTaskPayload = { key: slugKey(c.title, new Set(out.map((t) => t.key))), title: c.title.trim(), discipline: c.discipline ?? "documentation",
      description: c.description.trim() || null, required_tools: [], acceptance_tests: [], approval_required: true,
      approval_reason: "Added from the workspace chat: review the result", risk_level: "medium", estimated_hours: null,
      upstream_keys: c.after_key ? [c.after_key] : [], requirement_refs: [] };
    out.splice(after >= 0 ? after + 1 : out.length, 0, task);
    return out;
  }
  const i = find(c.task_key);
  if (i < 0) throw new Error(`there is no task ${c.task_key ?? "(none named)"} in the plan`);
  if (c.action === "change_task") {
    const t = out[i]!;
    out[i] = { ...t, title: c.title.trim() || t.title, discipline: c.discipline ?? t.discipline, description: c.description.trim() || t.description };
    return out;
  }
  if (out.length === 1) throw new Error("a plan needs at least one task");
  const [gone] = out.splice(i, 1);
  for (const t of out) {
    if (t.upstream_keys.includes(gone!.key)) {
      t.upstream_keys = [...new Set([...t.upstream_keys.filter((k) => k !== gone!.key), ...gone!.upstream_keys])];
    }
  }
  return out;
}

export function describePlanChange(c: PlanChange): string {
  if (c.action === "add_task") return `Add a task: "${c.title}"${c.discipline ? ` (${c.discipline.replace("_", " ")})` : ""}${c.after_key ? `, after ${c.after_key}` : ""}`;
  if (c.action === "change_task") return `Change ${c.task_key}: ${[c.title && `title "${c.title}"`, c.discipline && `discipline ${c.discipline}`, c.description && "new description"].filter(Boolean).join(", ")}`;
  return `Remove ${c.task_key} ("${c.title}")`;
}
