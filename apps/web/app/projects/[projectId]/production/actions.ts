"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { fail, requireUser } from "@/lib/auth";

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const num = (f: FormData, k: string) => (str(f, k) === "" ? null : Number(str(f, k)));
const base = (projectId: string, lotId?: string) => `/projects/${projectId}/production${lotId ? `/${lotId}` : ""}`;
function go(path: string, notice: string): never {
  revalidatePath(path);
  redirect(`${path}?notice=${encodeURIComponent(notice)}`);
}

export async function createLot(projectId: string, form: FormData) {
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc("create_lot", {
    p_project: projectId, p_kind: str(form, "kind") || "pilot", p_release: str(form, "release"), p_quantity: num(form, "quantity"),
    p_sample_size: num(form, "sample_size"), p_accept_max: num(form, "accept_max") ?? 0, p_procedure: str(form, "procedure") || null,
    p_manufacturer: str(form, "manufacturer") || null, p_built_by: str(form, "built_by") || null, p_notes: str(form, "notes") || null,
  });
  if (error) fail(base(projectId), error);
  go(base(projectId, data as string), "Lot planned: register its units by serial number when they are built.");
}

export async function addUnits(projectId: string, lotId: string, form: FormData) {
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc("add_lot_units", { p_lot: lotId, p_prefix: str(form, "prefix"), p_start: num(form, "start"),
    p_count: num(form, "count"), p_digits: num(form, "digits") ?? 4 });
  if (error) fail(base(projectId, lotId), error);
  go(base(projectId, lotId), `${data} unit(s) registered.`);
}

/** Findings are typed one per line as "defect, count" (count defaults to 1). */
export async function recordInspection(projectId: string, lotId: string, form: FormData) {
  const path = base(projectId, lotId);
  const findings = str(form, "findings").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
    const m = l.match(/^(.*?)[,;\t]\s*(\d+)\s*$/);
    return m ? { defect: m[1]!.trim(), count: Number(m[2]) } : { defect: l, count: 1 };
  });
  const listed = findings.reduce((s, f) => s + f.count, 0);
  const defects = num(form, "defects") ?? listed;
  if (findings.length && listed !== defects) fail(path, `The findings add up to ${listed} defect(s) but the count says ${defects}.`);
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc("record_lot_inspection", { p_lot: lotId, p_stage: str(form, "stage"), p_inspected: num(form, "inspected"),
    p_defects: defects, p_findings: findings, p_notes: str(form, "notes") || null });
  if (error) fail(path, error);
  const { data: row } = await supabase.from("lot_inspections").select("verdict").eq("id", data as string).single();
  go(path, `Inspection recorded: ${row?.verdict === "accept" ? "meets the sampling plan" : row?.verdict === "reject" ? "fails the sampling plan" : "sample not complete yet"}.`);
}

export async function setLotStatus(projectId: string, lotId: string, form: FormData) {
  const { supabase } = await requireUser();
  const status = str(form, "status");
  const { error } = await supabase.rpc("set_lot_status", { p_lot: lotId, p_status: status, p_note: str(form, "note") || null });
  if (error) fail(base(projectId, lotId), error);
  go(base(projectId, lotId), `Lot ${status.replace("_", " ")}.`);
}

export async function setDelivery(projectId: string, lotId: string, form: FormData) {
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("set_lot_delivery", { p_lot: lotId, p_promised_on: str(form, "promised_on") || null, p_delivered_on: str(form, "delivered_on") || null });
  if (error) fail(base(projectId, lotId), error);
  go(base(projectId, lotId), "Delivery dates saved.");
}
