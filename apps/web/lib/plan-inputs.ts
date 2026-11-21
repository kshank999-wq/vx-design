import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { applyEdits, COMMITTED, planContext, priorWorkFromFluxAudit, type FluxAuditLike, type PlanInputs, type PlanInputSource, type PriorWork, type RegisterItem } from "@vx/planning";

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
  /** Every id a task's basis may cite: REF-n, PW-n and PR-n. */
  inputIds: string[];
}

/** A register item in a few words, for validation messages and the plan page. */
export const itemLabel = (i: RegisterItem) => `${i.mpn ? `${i.mpn} ` : ""}${i.title} (${i.status.replace("_", " ")})`.slice(0, 160);

/**
 * Everything a plan is built from: the project, intake, the design freeze, confirmed standards, specification
 * documents, references marked for the plan, and completed Flux audits marked for the plan (as prior work).
 */
export async function loadPlanInputs(supabase: SupabaseClient, projectId: string): Promise<LoadedInputs> {
  const [{ data: project }, { data: intake }, { data: freeze }, { data: standards }, { data: docs }, { data: reqs }, { data: refs }, { data: audits }, { data: reg }] = await Promise.all([
    supabase.from("projects").select("name, description").eq("id", projectId).single(),
    supabase.from("project_intake").select("intended_use, regions, quantity, target_unit_cost, currency, max_dimensions, power_source, radios, target_standards, notes").eq("project_id", projectId).maybeSingle(),
    supabase.from("current_design_freeze").select("envelope, cmf, note").eq("project_id", projectId).maybeSingle(),
    supabase.from("project_standards").select("applicability, status, standards(identifier, title)").eq("project_id", projectId).eq("status", "confirmed"),
    supabase.from("documents").select("id, title").eq("project_id", projectId).order("created_at"),
    supabase.from("requirements").select("document_id, status").eq("project_id", projectId),
    supabase.from("project_references").select("id, ref_no, kind, title, note, filename, part_id").eq("project_id", projectId).eq("use_in_plan", true).order("ref_no"),
    supabase.from("flux_audits").select("id, audit_no, title, report_path").eq("project_id", projectId).eq("status", "ready").eq("use_in_plan", true).order("audit_no"),
    supabase.from("prior_work_registers").select("id, items, edits, completed_at").eq("project_id", projectId).eq("status", "ready").order("completed_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
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
    // A part's files are read into the register; without one they are listed so the plan knows they exist.
    references: (refs ?? []).filter((r) => !(reg && r.part_id)).map((r) => ({ id: refCode(r.ref_no), kind: r.kind, title: r.title, note: r.note, filename: r.filename })),
    priorWork,
  };
  const register = reg ? { id: reg.id as string, items: applyEdits((reg.items ?? []) as RegisterItem[], (reg.edits ?? {}) as Record<string, { status?: string; note?: string; excluded?: boolean }>), created: reg.completed_at as string } : null;
  if (register?.items.length) inputs.register = register.items;
  const { text, sources } = planContext(inputs);
  const record: LoadedInputs["record"] = sources.map((s) => ({
    id: s.id, kind: s.kind, label: s.label,
    ref: s.kind === "reference" ? (refs ?? []).find((r) => refCode(r.ref_no) === s.id)?.id : auditOf.get(s.id),
  }));
  const live = register?.items ?? [];
  const mustAddress = live.filter((i) => (COMMITTED as string[]).includes(i.status)).map((i) => ({ id: i.id, label: itemLabel(i) }));
  if (register && live.length) record.push(...live.map((i) => ({ id: i.id, kind: "register_item", label: itemLabel(i), ref: register.id })));
  return { inputs, context: text, sources, record, priorWork, register, mustAddress, inputIds: [...sources.map((s) => s.id), ...live.map((i) => i.id)] };
}
