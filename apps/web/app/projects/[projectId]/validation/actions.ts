"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { draftProcedures } from "@vx/planning";
import { fail, requireUser } from "@/lib/auth";

const base = (projectId: string) => `/projects/${projectId}/validation`;
const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
function go(path: string, notice: string): never {
  revalidatePath(path.split("?")[0]!);
  redirect(`${path}${path.includes("?") ? "&" : "?"}notice=${encodeURIComponent(notice)}`);
}

export async function addUnit(projectId: string, form: FormData) {
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("create_unit", {
    p_project_id: projectId, p_serial: str(form, "serial"), p_revision: str(form, "revision"), p_built_from: str(form, "built_from") || null,
    p_lot: str(form, "lot") || null, p_assembled_by: str(form, "assembled_by") || null, p_received_at: str(form, "received_at") || null,
    p_notes: str(form, "notes") || null,
  });
  if (error) fail(base(projectId), error);
  go(base(projectId), `Unit ${str(form, "serial")} registered.`);
}

export async function draftFromRequirements(projectId: string) {
  const { supabase } = await requireUser();
  const [{ data: reqs }, { data: procs }] = await Promise.all([
    supabase.from("requirements").select("ref_code, kind, text, acceptance_criteria").eq("project_id", projectId).neq("status", "rejected").order("ref_code"),
    supabase.from("test_procedures").select("requirement_refs, status").eq("project_id", projectId).neq("status", "superseded"),
  ]);
  const covered = new Set((procs ?? []).flatMap((p) => p.requirement_refs as string[]));
  const drafts = draftProcedures(reqs ?? [], covered);
  for (const d of drafts) {
    const { error } = await supabase.rpc("save_procedure", { p_project_id: projectId, p_id: null, p_title: d.title, p_stage: d.stage,
      p_requirement_refs: d.requirement_refs, p_setup: null, p_steps: d.steps, p_measurements: d.measurements });
    if (error) fail(base(projectId), error);
  }
  go(base(projectId), drafts.length ? `${drafts.length} draft procedure(s) written from the requirements: review the limits, then approve.`
                                    : "Every requirement already has a procedure.");
}

export async function newProcedure(projectId: string) {
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc("save_procedure", { p_project_id: projectId, p_id: null, p_title: "New procedure", p_stage: "functional",
    p_requirement_refs: [], p_setup: null, p_steps: null, p_measurements: [] });
  if (error) fail(base(projectId), error);
  redirect(`${base(projectId)}/procedures/${data}`);
}

export async function saveProcedure(projectId: string, procedureId: string, form: FormData) {
  const path = `${base(projectId)}/procedures/${procedureId}`;
  const { supabase } = await requireUser();
  const rows = form.getAll("m_key").map((k, i) => ({
    key: String(k).trim(), label: String(form.getAll("m_label")[i] ?? "").trim(), kind: String(form.getAll("m_kind")[i] ?? "numeric"),
    unit: String(form.getAll("m_unit")[i] ?? "").trim() || undefined, min: String(form.getAll("m_min")[i] ?? "").trim(),
    max: String(form.getAll("m_max")[i] ?? "").trim(), expected: String(form.getAll("m_expected")[i] ?? "").trim() || undefined,
    requirement_ref: String(form.getAll("m_req")[i] ?? "").trim() || undefined, basis: String(form.getAll("m_basis")[i] ?? "").trim() || undefined,
  })).filter((m) => m.key);
  const measurements = rows.map(({ min, max, ...m }) => ({ ...m, ...(min !== "" ? { min: Number(min) } : {}), ...(max !== "" ? { max: Number(max) } : {}),
                                                          label: m.label || m.key }));
  const { error } = await supabase.rpc("save_procedure", { p_project_id: projectId, p_id: procedureId, p_title: str(form, "title"),
    p_stage: str(form, "stage"), p_requirement_refs: form.getAll("requirement_refs").map(String), p_setup: str(form, "setup") || null,
    p_steps: str(form, "steps") || null, p_measurements: measurements });
  if (error) fail(path, error);
  go(path, "Saved.");
}

export async function approveProcedure(projectId: string, procedureId: string) {
  const path = `${base(projectId)}/procedures/${procedureId}`;
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("approve_procedure", { p_id: procedureId });
  if (error) fail(path, error);
  go(path, "Approved: this version is frozen and can be used to record tests.");
}

export async function reviseProcedure(projectId: string, procedureId: string) {
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc("revise_procedure", { p_id: procedureId });
  if (error) fail(`${base(projectId)}/procedures/${procedureId}`, error);
  redirect(`${base(projectId)}/procedures/${data}?notice=${encodeURIComponent("New draft version: edit, then approve it to replace the current one.")}`);
}

export async function recordRun(projectId: string, form: FormData) {
  const path = `${base(projectId)}/record?unit=${str(form, "unit")}&procedure=${str(form, "procedure")}`;
  const { supabase } = await requireUser();
  const values: Record<string, string> = {};
  // Pasted "key,value" lines (bench scripts, CSV exports) first; fields typed in the form win.
  for (const line of str(form, "paste").split(/\r?\n/)) {
    const [k, ...v] = line.split(/[,;\t]/);
    if (k && v.length && /^[a-z][a-z0-9_]*$/.test(k.trim())) values[k.trim()] = v.join(",").trim();
  }
  for (const [k, v] of form.entries()) if (k.startsWith("v_") && String(v).trim() !== "") values[k.slice(2)] = String(v).trim();
  const equipment = str(form, "equipment").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
    const [name, id, cal] = l.split(/[,;|]/).map((x) => x.trim());
    return { name, id: id || null, calibrated_until: cal || null };
  });
  const conditions = { temperature_c: str(form, "temperature_c") ? Number(str(form, "temperature_c")) : null,
                       supply_v: str(form, "supply_v") ? Number(str(form, "supply_v")) : null, firmware: str(form, "firmware") || null,
                       location: str(form, "location") || null, equipment };
  const { data, error } = await supabase.rpc("record_test_run", {
    p_unit_id: str(form, "unit"), p_procedure_id: str(form, "procedure"), p_performed_at: new Date(str(form, "performed_at") || Date.now()).toISOString(),
    p_conditions: conditions, p_values: values, p_notes: str(form, "notes") || null, p_supersedes: str(form, "supersedes") || null,
  });
  if (error) fail(path, error);
  go(`${base(projectId)}/runs/${data}`, "Recorded. Add scope captures, photos or logs below.");
}

export async function updateFault(projectId: string, faultId: string, form: FormData) {
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("update_fault", {
    p_fault_id: faultId, p_status: str(form, "status"), p_root_cause: str(form, "root_cause") || null,
    p_correction_kind: str(form, "correction_kind") || null, p_correction: str(form, "correction") || null,
    p_verified_by_run: str(form, "verified_by_run") || null, p_note: str(form, "note") || null,
  });
  if (error) fail(base(projectId), error);
  go(base(projectId), "Fault updated.");
}
