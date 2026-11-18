"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { fail, requireUser } from "@/lib/auth";

const page = (projectId: string, auditId: string) => `/projects/${projectId}/flux/${auditId}`;
function done(path: string, notice: string): never {
  revalidatePath(path);
  redirect(`${path}?notice=${encodeURIComponent(notice)}`);
}

export async function createAudit(projectId: string, form: FormData) {
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc("create_flux_audit", { p_project_id: projectId, p_title: String(form.get("title") ?? "") });
  if (error) fail(`/projects/${projectId}/flux`, error);
  done(page(projectId, data as string), "Import created. Upload the Flux export, then run the audit.");
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

export async function runAudit(projectId: string, auditId: string) {
  const path = page(projectId, auditId);
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("run_flux_audit", { p_audit_id: auditId });
  if (error) fail(path, error);
  done(path, "Audit requested: a worker reads the files; this page updates when the report is ready.");
}
