/**
 * Plan check failures fixed in code, instead of a paid repair round with the model.
 *
 * The model's plan is checked by validatePlan; most failures are mechanical (a requirement left out, a link to a task
 * that does not exist, an earlier-work item not cited) and have one sensible fix that needs no judgment. Each fix is
 * listed, so the people approving the plan see exactly what was changed and can move anything placed by rule. Only
 * what code cannot decide (an empty plan, a replacement with no reason given) still goes back to the model.
 */
import { topologicalOrder } from "@vx/contracts";
import type { PlanOutput, RequirementInput } from "./plan.ts";

type Task = PlanOutput["tasks"][number];
type Disc = Task["discipline"];

/** Where a requirement of each kind belongs, best first. */
const HOME: Record<string, Disc[]> = {
  functional: ["architecture", "schematic", "components"],
  electrical: ["schematic", "pcb_layout", "components"],
  power: ["power", "schematic", "components"],
  mechanical: ["mechanical", "enclosure"],
  thermal: ["thermal", "mechanical", "power"],
  interface: ["schematic", "architecture", "components"],
  environmental: ["enclosure", "mechanical", "verification"],
  regulatory: ["verification", "documentation"],
  manufacturing: ["manufacturing", "pcb_layout", "enclosure"],
  cost: ["sourcing", "components", "architecture"],
  other: ["architecture", "documentation"],
};
/** Words in an earlier-work item or part that point to a discipline. */
const SUBSYSTEM: [RegExp, Disc[]][] = [
  [/power|battery|charger|regulator|ldo|buck|boost|pmic/i, ["power", "components"]],
  [/enclosure|housing|bezel|case|mechanical|bracket/i, ["enclosure", "mechanical"]],
  [/connector|header|socket|receptacle|cable/i, ["components", "schematic", "pcb_layout"]],
  [/display|touch|camera|sd card|storage|memory|usb|hub|radio|wi-?fi|bluetooth|timecode|oscillator|tcxo|compute|processor|mcu|module/i, ["components", "architecture", "schematic"]],
];

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "task";
const prefix = (ref: string) => ref.replace(/-\d+$/, "");

export interface AutoFixContext {
  requirements: RequirementInput[];
  inputIds: string[];
  mustAddress: { id: string; label: string }[];
}

export function autoFixPlan(input: PlanOutput, ctx: AutoFixContext): { plan: PlanOutput; fixes: string[] } {
  const plan: PlanOutput = structuredClone(input);
  const fixes: string[] = [];
  const active = ctx.requirements.filter((r) => r.status !== "rejected");
  const known = new Map(active.map((r) => [r.refCode, r]));
  const ids = new Set(ctx.inputIds);
  if (!plan.tasks.length) return { plan, fixes };

  // Keys: lowercase slugs, unique; links follow a renamed key.
  const renamed = new Map<string, string>();
  const used = new Set<string>();
  for (const t of plan.tasks) {
    let k = /^[a-z0-9][a-z0-9-]*$/.test(t.key) ? t.key : slug(t.key);
    if (k !== t.key) renamed.set(t.key, k);
    if (used.has(k)) { let n = 2; while (used.has(`${k}-${n}`)) n++; fixes.push(`Task key "${k}" was used twice; the second is now "${k}-${n}"`); k = `${k}-${n}`; }
    else if (k !== t.key) fixes.push(`Task key "${t.key}" is now "${k}"`);
    used.add(k);
    t.key = k;
  }
  const keys = new Set(plan.tasks.map((t) => t.key));
  for (const t of plan.tasks) {
    const before = t.upstream_keys;
    t.upstream_keys = [...new Set(before.map((u) => renamed.get(u) ?? u))].filter((u) => keys.has(u) && u !== t.key);
    const dropped = before.filter((u) => !t.upstream_keys.includes(renamed.get(u) ?? u));
    if (dropped.length) fixes.push(`"${t.key}": dropped link(s) to ${dropped.map((d) => `"${d}"`).join(", ")} (no such task, or itself)`);
    const unknown = t.requirement_refs.filter((r) => !known.has(r));
    if (unknown.length) { t.requirement_refs = t.requirement_refs.filter((r) => known.has(r)); fixes.push(`"${t.key}": dropped unknown requirement(s) ${unknown.join(", ")}`); }
    t.requirement_refs = [...new Set(t.requirement_refs)];
    if (!t.acceptance_tests.length) {
      t.acceptance_tests = [{ description: `An engineer reviews and accepts the result of: ${t.title}`, method: "human_review", validation_kind: null }];
      fixes.push(`"${t.key}": had no acceptance test; an engineer's review was added`);
    }
    // Basis: required when there are inputs; only real inputs cited; reuse/adapt needs a source.
    if (ids.size && !t.basis) { t.basis = { mode: "new", sources: [], reason: "No earlier work cited by the planner.", concerns: [], alternatives: [] }; fixes.push(`"${t.key}": had no basis; marked as new work`); }
    if (t.basis) {
      const bad = t.basis.sources.filter((s) => !ids.has(s));
      if (bad.length) { t.basis.sources = t.basis.sources.filter((s) => ids.has(s)); fixes.push(`"${t.key}": dropped unknown input(s) ${bad.join(", ")} from its basis`); }
      if (t.basis.mode !== "new" && t.basis.mode !== "replace" && !t.basis.sources.length) { fixes.push(`"${t.key}": said it ${t.basis.mode}s earlier work but cited none; marked as new work`); t.basis.mode = "new"; }
    }
  }

  // Boards: every schematic and layout task names its board; one board's tasks build on each other.
  fixBoards(plan.tasks, fixes);

  // Dependency loops: remove the link that closes each loop.
  for (let guard = 0; guard < plan.tasks.length * 2; guard++) {
    const back = findBackEdge(plan.tasks);
    if (!back) break;
    const t = plan.tasks.find((x) => x.key === back.from)!;
    t.upstream_keys = t.upstream_keys.filter((u) => u !== back.to);
    fixes.push(`Removed the link "${back.from}" → "${back.to}", which closed a dependency loop`);
  }

  // Deferrals of requirements that do not exist.
  const badDeferred = plan.deferred_requirements.filter((d) => !known.has(d.ref));
  if (badDeferred.length) { plan.deferred_requirements = plan.deferred_requirements.filter((d) => known.has(d.ref)); fixes.push(`Dropped deferral(s) of unknown requirement(s) ${badDeferred.map((d) => d.ref).join(", ")}`); }

  // Requirements the planner left out: into the task that holds their siblings, else the one for their kind.
  const covered = new Set(plan.tasks.flatMap((t) => t.requirement_refs));
  const deferred = new Set(plan.deferred_requirements.map((d) => d.ref));
  const placed = new Map<string, string[]>();
  for (const r of active) {
    if (covered.has(r.refCode) || deferred.has(r.refCode)) continue;
    const home = HOME[r.kind] ?? HOME.other!;
    let best: Task | null = null, score = -1;
    for (const t of plan.tasks) {
      const siblings = t.requirement_refs.filter((x) => prefix(x) === prefix(r.refCode)).length;
      const di = home.indexOf(t.discipline);
      const s = siblings * 3 + (di >= 0 ? (home.length - di) * 2 : 0);
      if (s > score) { best = t; score = s; }
    }
    best!.requirement_refs.push(r.refCode);
    covered.add(r.refCode);
    placed.set(best!.key, [...(placed.get(best!.key) ?? []), r.refCode]);
  }
  for (const [k, refs] of placed) fixes.push(`Placed by rule in "${k}" (the planner left them out; move them if another task fits better): ${refs.join(", ")}`);

  // Earlier work and chosen parts every plan must use: cited by the task that matches them.
  const cited = new Set(plan.tasks.flatMap((t) => t.basis?.sources ?? []));
  const added = new Map<string, string[]>();
  for (const m of ctx.mustAddress) {
    if (cited.has(m.id)) continue;
    const want = SUBSYSTEM.find(([re]) => re.test(m.label))?.[1] ?? ["architecture", "components"];
    const words = m.label.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3);
    let best: Task | null = null, score = -1;
    for (const t of plan.tasks) {
      const text = `${t.title} ${t.description}`.toLowerCase();
      const di = want.indexOf(t.discipline);
      const s = words.filter((w) => text.includes(w)).length * 3 + (di >= 0 ? (want.length - di) * 2 : 0) + (t.discipline === "architecture" ? 1 : 0);
      if (s > score) { best = t; score = s; }
    }
    const t = best!;
    t.basis ??= { mode: "adapt", sources: [], reason: "Continues earlier work.", concerns: [], alternatives: [] };
    if (t.basis.mode === "new") { t.basis.mode = "adapt"; t.basis.reason = `${t.basis.reason} Builds on the cited earlier work and chosen parts.`.trim(); }
    t.basis.sources.push(m.id);
    cited.add(m.id);
    added.set(t.key, [...(added.get(t.key) ?? []), m.id]);
  }
  for (const [k, srcs] of added) fixes.push(`Cited by rule in "${k}" (the planner did not use them): ${srcs.join(", ")}`);

  return { plan, fixes };
}

/** A link that closes a dependency loop, or null when there is none. */
function findBackEdge(tasks: Task[]): { from: string; to: string } | null {
  try { topologicalOrder(tasks.map((t) => ({ key: t.key, upstreamKeys: t.upstream_keys }) as never)); return null; } catch { /* a loop: find it */ }
  const up = new Map(tasks.map((t) => [t.key, t.upstream_keys]));
  const state = new Map<string, 1 | 2>();
  let found: { from: string; to: string } | null = null;
  const visit = (k: string) => {
    if (found) return;
    state.set(k, 1);
    for (const u of up.get(k) ?? []) {
      if (found) return;
      if (state.get(u) === 1) { found = { from: k, to: u }; return; }
      if (!state.has(u)) visit(u);
    }
    state.set(k, 2);
  };
  for (const t of tasks) if (!state.has(t.key)) visit(t.key);
  return found;
}

const BOARD_WORK = new Set<Disc>(["schematic", "pcb_layout"]);
const boardSlug = (b: string) => b.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/**
 * Board names and the links that let a board be built over several tasks: a schematic or layout task without a board
 * takes the board of the nearest upstream schematic or layout task (else the key's prefix shared with other board
 * tasks, else "main"); then per board, schematic tasks form a chain, each depends on the board's earlier power
 * tasks, and each layout task depends on the board's previous layout task and its last schematic task. Links only
 * ever point to tasks listed earlier, so no loop is created.
 */
export function fixBoards(tasks: Task[], fixes: string[]): void {
  const pos = new Map(tasks.map((t, i) => [t.key, i]));
  const byKey = new Map(tasks.map((t) => [t.key, t]));
  for (const t of tasks) if (t.board) t.board = boardSlug(t.board) || null;
  const prefixOf = (k: string) => k.split("-")[0]!;
  const prefixCount = new Map<string, number>();
  for (const t of tasks) if (BOARD_WORK.has(t.discipline)) prefixCount.set(prefixOf(t.key), (prefixCount.get(prefixOf(t.key)) ?? 0) + 1);
  for (const t of tasks) {
    if (!BOARD_WORK.has(t.discipline) || t.board) continue;
    let found: string | null = null;
    const seen = new Set<string>([t.key]);
    let frontier = [...t.upstream_keys];
    while (frontier.length && !found) {
      const ups = frontier.map((k) => byKey.get(k)).filter((u): u is Task => !!u && !seen.has(u.key))
        .sort((a, b) => pos.get(b.key)! - pos.get(a.key)!);
      for (const u of ups) { seen.add(u.key); if (BOARD_WORK.has(u.discipline) && u.board) { found = u.board; break; } }
      frontier = ups.flatMap((u) => u.upstream_keys);
    }
    const p = prefixOf(t.key);
    const how = found ? "from its upstream board work" : (prefixCount.get(p) ?? 0) >= 2 ? "from its key" : "the only board";
    t.board = found ?? ((prefixCount.get(p) ?? 0) >= 2 ? boardSlug(p) : "main");
    fixes.push(`"${t.key}": board set to "${t.board}" (${how})`);
  }
  // A power task named after a board ("main-sch-power") is that board's power tree.
  const boardNames = new Set(tasks.flatMap((t) => (BOARD_WORK.has(t.discipline) && t.board ? [t.board] : [])));
  for (const t of tasks) {
    if (t.discipline !== "power" || t.board || !boardNames.has(boardSlug(prefixOf(t.key)))) continue;
    t.board = boardSlug(prefixOf(t.key));
    fixes.push(`"${t.key}": board set to "${t.board}" (a power task named after the board)`);
  }
  const groups = new Map<string, Task[]>();
  for (const t of tasks) if (t.board) groups.set(t.board, [...(groups.get(t.board) ?? []), t]);
  for (const [board, list] of groups) {
    list.sort((a, b) => pos.get(a.key)! - pos.get(b.key)!);
    const added: string[] = [];
    const link = (t: Task, up: Task) => {
      if (up.key === t.key || pos.get(up.key)! >= pos.get(t.key)! || t.upstream_keys.includes(up.key)) return;
      t.upstream_keys.push(up.key);
      added.push(`${t.key} → ${up.key}`);
    };
    const sch = list.filter((t) => t.discipline === "schematic");
    const pcb = list.filter((t) => t.discipline === "pcb_layout");
    const pwr = list.filter((t) => t.discipline === "power");
    sch.forEach((t, i) => { if (i) link(t, sch[i - 1]!); for (const p of pwr) link(t, p); });
    const lastSch = sch[sch.length - 1];
    pcb.forEach((t, i) => {
      if (i) link(t, pcb[i - 1]!);
      if (lastSch && pos.get(lastSch.key)! < pos.get(t.key)!) link(t, lastSch);
      const later = sch.filter((x) => pos.get(x.key)! > pos.get(t.key)!);
      if (later.length) fixes.push(`Board "${board}": layout "${t.key}" comes before its schematic task(s) ${later.map((x) => `"${x.key}"`).join(", ")}; it will lay out the circuit as it is then`);
    });
    if (added.length) fixes.push(`Board "${board}": linked so each task builds on the board so far: ${added.join(", ")}`);
  }
}
