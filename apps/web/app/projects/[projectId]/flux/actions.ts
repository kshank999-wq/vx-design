"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { fail, requireUser } from "@/lib/auth";

const page = (projectId: string, auditId: string) => `/projects/${projectId}/flux/${auditId}`;
function done(path: string, notice: string): never {
  revalidatePath(path.split("?")[0]!);
  redirect(`${path}${path.includes("?") ? "&" : "?"}notice=${encodeURIComponent(notice)}`);
}

export async function createAudit(projectId: string, form: FormData) {
  const fromInputs = form.get("from") === "inputs";
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc("create_design_import", { p_project_id: projectId, p_title: String(form.get("title") ?? ""),
    p_source_tool: String(form.get("source_tool") ?? "other") });
  if (error) fail(fromInputs ? `/projects/${projectId}/inputs?step=4` : `/projects/${projectId}/flux`, error);
  if (fromInputs) done(`/projects/${projectId}/inputs?step=4`, "Import started. Add the files below, then run the import.");
  done(page(projectId, data as string), "Import created. Upload the files, then run the import.");
}

export async function removeFile(projectId: string, auditId: string, fileId: string) {
  const path = page(projectId, auditId);
  const { supabase } = await requireUser();
  const { data: storagePath, error } = await supabase.rpc("remove_flux_file", { p_file_id: fileId });
  if (error) fail(path, error);
  // The same bytes may be registered under another revision; delete the object only when nothing refers to it.
  const { count } = await supabase.from("flux_audit_files").select("id", { count: "exact", head: true }).eq("storage_path", storagePath as string);
  if (!count) await supabase.storage.from("project-files").remove([storagePath as string]);
  done(path, "File removed.");
}

export async function runAudit(projectId: string, auditId: string, from?: string) {
  const path = from === "inputs" ? `/projects/${projectId}/inputs?step=4` : page(projectId, auditId);
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("run_flux_audit", { p_audit_id: auditId });
  if (error) fail(path, error);
  // Native board files and 3D models also go to the KiCad worker to be converted and checked.
  const { data: queued } = await supabase.rpc("queue_import_conversions", { p_audit_id: auditId });
  if (Number(queued)) done(path, `Import requested: a worker reads the files, and ${queued} board or 3D file(s) are being converted and checked. This page updates when done.`);
  done(path, "Import requested: a worker reads the files; this page updates when the report is ready.");
}
