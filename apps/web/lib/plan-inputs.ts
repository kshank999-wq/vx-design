import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { routeLine, type Route } from "./manufacturing";
import { applyEdits, COMMITTED, planContext, priorWorkFromFluxAudit, type ChosenPart, type FluxAuditLike, type PlanChanges, type PlanInputs, type PlanInputSource, type PriorWork, type RegisterItem } from "@vx/planning";

export { ITEM_STATUS_LABEL, PART_FILE_KINDS, PART_STATUS, partFileKind, REFERENCE_KINDS, VISUAL_KINDS } from "./reference-kinds";
export const refCode = (n: number) => `REF-${n}`;
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];

/** A compact view of a stored Flux audit report, or null when it cannot be read. */
async function readAudit(supabase: SupabaseClient, path: string): Promise<FluxAuditLike | null> {
  const { data } = await supabase.storage.from("project-files").download(path);
  if (!data) return null;
  try { return JSON.parse(await data.text()) as FluxAuditLike; } catch { return null; }
}

export interface LoadedInputs {
  inputs: PlanInputs;
  context: string;
  sources: PlanInputSource[];
  /** Stored with the plan: which inputs it was built from. */
  record: { id: string; kind: string; label: string; ref?: string }[];
  priorWork: PriorWork[];
  /** The latest ready register, with people's corrections applied (null when none has been built). */
  register: { id: string; items: RegisterItem[]; created: string } | null;
  /** Register items every plan must address: selected, designed, laid out or verified. */
  mustAddress: { id: string; label: string }[];
  /** Every id a task's basis may cite: REF-n, PW-n, PR-n and PT-n. */
  inputIds: string[];
  /** What changed since the latest plan (null when there is no plan yet). */
  changes: PlanChanges | null;
}

type Supa = SupabaseClient;
const partCode = (n: number) => `PT-${n}`;
const MODEL_FILE = /\.(step|stp|iges|igs|stl|3mf|obj|wrl|f3d|sldprt|x_t)$/i;

/** The team's chosen parts, numbered PT-n in the order they were added. */
async function loadParts(supabase: Supa, projectId: string) {
  const [{ data: parts }, { data: files }] = await Promise.all([
    supabase.from("project_parts").select("id, mpn, manufacturer, role, subsystem, status, note, specs, summary, created_at, updated_at").eq("project_id", projectId).order("created_at").order("id"),
    supabase.from("project_references").select("part_id, filename, kind, created_at").eq("project_id", projectId).not("part_id", "is", null).order("ref_no"),
  ]);
  return (parts ?? []).map((p, n) => ({
    row: p as { id: string; mpn: string; created_at: string; updated_at: string; status: string; summary: string | null; role: string | null },
    files: (files ?? []).filter((f) => f.part_id === p.id) as { filename: string; kind: string; created_at: string }[],
    code: partCode(n + 1),
    part: {
      id: partCode(n + 1), mpn: p.mpn, manufacturer: p.manufacturer, summary: p.summary, role: p.role, subsystem: p.subsystem, status: p.status, note: p.note,
      specs: Array.isArray(p.specs) ? (p.specs as { name: string; value: string }[]) : [],
      files: (files ?? []).filter((f) => f.part_id === p.id).map((f) => `${f.filename} (${MODEL_FILE.test(f.filename) ? "3D model" : f.kind === "datasheet" ? "datasheet" : f.kind.replace(/_/g, " ")})`),
    } as ChosenPart,
  }));
}

const n = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;
const few = (xs: string[], max = 12) => `${xs.slice(0, max).join("; ")}${xs.length > max ? `; and ${xs.length - max} more` : ""}`;

/**
 * Everything added or changed in the project's inputs since its latest plan was made: specifications, requirements,
 * parts and their files, references, prior work, the register, manufacturing routes, setup, the design freeze and
 * standards. A new plan is told about each so it revises the old one rather than ignoring what is new.
 */
export async function planChanges(supabase: Supa, projectId: string, parts?: Awaited<ReturnType<typeof loadParts>>): Promise<PlanChanges | null> {
  const { data: plan } = await supabase.from("plans").select("id, version, created_at").eq("project_id", projectId).order("version", { ascending: false }).limit(1).maybeSingle();
  if (!plan) return null;
  const t = plan.created_at as string;
  const [{ data: tasks }, { data: docs }, { data: reqs }, { data: refs }, { data: audits }, { data: regs }, { data: routes }, { data: intake }, { data: freeze }, { data: stds }, ps] = await Promise.all([
    supabase.from("tasks").select("key, title, stage, status").eq("plan_id", plan.id).order("position"),
    supabase.from("documents").select("title").eq("project_id", projectId).gt("created_at", t).order("created_at"),
    supabase.from("requirements").select("ref_code, status, created_at").eq("project_id", projectId).gt("updated_at", t).order("ref_code"),
    supabase.from("project_references").select("ref_no, title, kind").eq("project_id", projectId).is("part_id", null).eq("use_in_plan", true).gt("created_at", t).order("ref_no"),
    supabase.from("flux_audits").select("audit_no, title").eq("project_id", projectId).eq("status", "ready").gt("completed_at", t),
    supabase.from("prior_work_registers").select("id").eq("project_id", projectId).eq("status", "ready").gt("completed_at", t).limit(1),
    supabase.from("part_routes").select("name, created_at").eq("project_id", projectId).gt("updated_at", t).order("name"),
    supabase.from("project_intake").select("project_id").eq("project_id", projectId).gt("updated_at", t).maybeSingle(),
    supabase.from("design_freezes").select("id").eq("project_id", projectId).gt("frozen_at", t).limit(1),
    supabase.from("project_standards").select("standards(identifier)").eq("project_id", projectId).eq("status", "confirmed").gt("confirmed_at", t),
    parts ? Promise.resolve(parts) : loadParts(supabase, projectId),
  ]);
  const items: string[] = [];
  const label = (p: (typeof ps)[number]) => { const what = p.row.summary || p.row.role; return `${p.code} ${p.row.mpn}${what ? ` (${what.slice(0, 80)})` : ""}`; };
  const addedParts = ps.filter((p) => p.row.created_at > t);
  const changedParts = ps.filter((p) => p.row.created_at <= t && (p.row.updated_at > t || p.files.some((f) => f.created_at > t)));
  if (addedParts.length) items.push(`${n(addedParts.length, "part")} added: ${few(addedParts.map(label))}`);
  if (changedParts.length) items.push(`${n(changedParts.length, "part")} changed or given new files: ${few(changedParts.map((p) => `${label(p)}, now ${p.row.status.replace("_", " ")}`))}`);
  if (docs?.length) items.push(`${n(docs.length, "specification")} added: ${few(docs.map((d) => d.title))}`);
  const newReqs = (reqs ?? []).filter((r) => r.created_at > t), changedReqs = (reqs ?? []).filter((r) => r.created_at <= t);
  if (newReqs.length) items.push(`${n(newReqs.length, "requirement")} added: ${few(newReqs.map((r) => r.ref_code), 30)}`);
  if (changedReqs.length) items.push(`${n(changedReqs.length, "requirement")} changed: ${few(changedReqs.map((r) => `${r.ref_code} (${r.status})`), 30)}`);
  if (refs?.length) items.push(`${n(refs.length, "reference")} added: ${few(refs.map((r) => `${refCode(r.ref_no)} ${r.title} (${String(r.kind).replace(/_/g, " ")})`))}`);
  if (audits?.length) items.push(`prior work imported: ${few(audits.map((a) => `Flux audit #${a.audit_no}: ${a.title}`))}`);
  if (regs?.length) items.push("the earlier-work register was rebuilt");
  if (routes?.length) items.push(`manufacturing routes added or changed: ${few(routes.map((r) => `${r.name}${r.created_at > t ? " (new)" : ""}`))}`);
  if (intake) items.push("the project setup (intended use, markets, quantity, cost, size, power, radios or standards) changed");
  if (freeze?.length) items.push("the industrial design freeze changed");
  if (stds?.length) items.push(`${n(stds.length, "standard")} confirmed: ${few(stds.map((s) => (s.standards as unknown as { identifier: string }).identifier))}`);
  return { version: plan.version as number, since: t, items, tasks: (tasks ?? []).map((x) => ({ key: x.key, title: x.title, stage: x.stage, status: x.status })) };
}

/** A register item in a few words, for validation messages and the plan page. */
export const itemLabel = (i: RegisterItem) => `${i.mpn ? `${i.mpn} ` : ""}${i.title} (${i.status.replace("_", " ")})`.slice(0, 160);

/**
 * Everything a plan is built from: the project, intake, the design freeze, confirmed standards, specification
 * documents, references marked for the plan, and completed Flux audits marked for the plan (as prior work).
 */
export async function loadPlanInputs(supabase: SupabaseClient, projectId: string): Promise<LoadedInputs> {
  const [{ data: project }, { data: intake }, { data: freeze }, { data: standards }, { data: docs }, { data: reqs }, { data: refs }, { data: audits }, { data: reg }, { data: routes }] = await Promise.all([
    supabase.from("projects").select("name, description").eq("id", projectId).single(),
    supabase.from("project_intake").select("intended_use, regions, quantity, target_unit_cost, currency, max_dimensions, power_source, radios, target_standards, notes").eq("project_id", projectId).maybeSingle(),
    supabase.from("current_design_freeze").select("envelope, cmf, note").eq("project_id", projectId).maybeSingle(),
    supabase.from("project_standards").select("applicability, status, standards(identifier, title)").eq("project_id", projectId).eq("status", "confirmed"),
    supabase.from("documents").select("id, title").eq("project_id", projectId).order("created_at"),
    supabase.from("requirements").select("document_id, status").eq("project_id", projectId),
    supabase.from("project_references").select("id, ref_no, kind, title, note, filename, part_id").eq("project_id", projectId).eq("use_in_plan", true).order("ref_no"),
    supabase.from("flux_audits").select("id, audit_no, title, report_path").eq("project_id", projectId).eq("status", "ready").eq("use_in_plan", true).order("audit_no"),
    supabase.from("prior_work_registers").select("id, items, edits, completed_at").eq("project_id", projectId).eq("status", "ready").order("completed_at", { ascending: false }).limit(1).maybeSingle(),
    supabase.from("part_routes").select("*").eq("project_id", projectId).order("name"),
  ]);
  const parts = await loadParts(supabase, projectId);
  const changes = await planChanges(supabase, projectId, parts);
  const list = (a: string[] | null | undefined) => (a?.length ? a.join(", ") : null);
  const i = intake;
  const env = freeze?.envelope as { length_mm?: number; width_mm?: number; height_mm?: number } | undefined;
  const cmf = Object.entries((freeze?.cmf ?? {}) as Record<string, unknown>).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join("; ");
  const priorWork: PriorWork[] = [];
  const auditOf = new Map<string, string>();
  for (const a of audits ?? []) {
    if (!a.report_path) continue;
    const report = await readAudit(supabase, a.report_path);
    if (!report) continue;
    const id = `PW-${priorWork.length + 1}`;
    priorWork.push(priorWorkFromFluxAudit(id, `Flux audit #${a.audit_no}: ${a.title}`, report));
    auditOf.set(id, a.id);
  }
  const inputs: PlanInputs = {
    project: { name: project?.name ?? "", description: project?.description },
    intake: i ? {
      intended_use: i.intended_use, markets: list(i.regions), first_production_quantity: i.quantity,
      target_unit_cost: i.target_unit_cost != null ? `${i.target_unit_cost} ${i.currency}` : null, maximum_dimensions: i.max_dimensions,
      power_source: i.power_source, radios: list(i.radios), target_standards: list(i.target_standards), notes: i.notes,
    } : null,
    freeze: freeze ? { envelope: env?.length_mm ? `${env.length_mm} × ${env.width_mm} × ${env.height_mm} mm` : null, cmf: cmf || null, note: freeze.note } : null,
    standards: (standards ?? []).map((s) => { const st = s.standards as unknown as { identifier: string; title: string }; return { identifier: st.identifier, title: st.title, applicability: s.applicability }; }),
    documents: (docs ?? []).map((d) => ({ title: d.title, requirements: (reqs ?? []).filter((r) => r.document_id === d.id && r.status !== "rejected").length })),
    // A part's files are listed with the part (PT-n), not as references.
    references: (refs ?? []).filter((r) => !r.part_id).map((r) => ({ id: refCode(r.ref_no), kind: r.kind, title: r.title, note: r.note, filename: r.filename })),
    priorWork,
  };
  const register = reg ? { id: reg.id as string, items: applyEdits((reg.items ?? []) as RegisterItem[], (reg.edits ?? {}) as Record<string, { status?: string; note?: string; excluded?: boolean }>), created: reg.completed_at as string } : null;
  if (register?.items.length) inputs.register = register.items;
  if (routes?.length) inputs.routes = (routes as Route[]).map(routeLine);
  // The team's chosen parts go to the planner directly, with their specifications and files, whether or not a register
  // has been built since they were added. One the register already lists is cross-referenced to its PR item.
  const live0 = register?.items ?? [];
  const norm = (x: string | null | undefined) => (x ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const chosen = parts.filter((p) => p.row.status !== "rejected");
  if (chosen.length) inputs.parts = chosen.map((p) => ({ ...p.part, register: live0.find((i) => i.mpn && norm(i.mpn) === norm(p.row.mpn))?.id ?? null }));
  if (changes) inputs.changes = changes;
  const { text, sources } = planContext(inputs);
  const record: LoadedInputs["record"] = sources.map((s) => ({
    id: s.id, kind: s.kind, label: s.label,
    ref: s.kind === "reference" ? (refs ?? []).find((r) => refCode(r.ref_no) === s.id)?.id : s.kind === "part" ? parts.find((p) => p.code === s.id)?.row.id : auditOf.get(s.id),
  }));
  const live = register?.items ?? [];
  const mustAddress = live.filter((i) => (COMMITTED as string[]).includes(i.status)).map((i) => ({ id: i.id, label: itemLabel(i) }));
  if (register && live.length) record.push(...live.map((i) => ({ id: i.id, kind: "register_item", label: itemLabel(i), ref: register.id })));
  // Every chosen part must be used (or its replacement argued) by some task.
  mustAddress.push(...(inputs.parts ?? []).map((p) => ({ id: p.id, label: `${p.mpn}${p.summary ? ` ${p.summary}` : ""} (${p.status.replace("_", " ")})`.slice(0, 160) })));
  return { inputs, context: text, sources, record, priorWork, register, mustAddress, inputIds: [...sources.map((s) => s.id), ...live.map((i) => i.id)], changes };
}
