"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { fail, requireUser } from "@/lib/auth";

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const base = (projectId: string, releaseId?: string) => `/projects/${projectId}/releases${releaseId ? `/${releaseId}` : ""}`;
function go(path: string, notice: string): never {
  revalidatePath(path);
  redirect(`${path}?notice=${encodeURIComponent(notice)}`);
}

export async function saveRelease(projectId: string, releaseId: string | null, form: FormData) {
  const path = base(projectId, releaseId ?? undefined);
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc("save_release", { p_project: projectId, p_id: releaseId, p_revision: str(form, "revision"),
    p_notes: str(form, "notes") || null, p_version_ids: form.getAll("files").map(String) });
  if (error) fail(path, error);
  go(base(projectId, data as string), releaseId ? "Saved." : "Draft release made: check the readiness list, then the owner issues it.");
}

export async function issueRelease(projectId: string, releaseId: string, form: FormData) {
  const path = base(projectId, releaseId);
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("issue_release", { p_release: releaseId, p_waiver: str(form, "waiver") || null });
  if (error) fail(path, error);
  go(path, "Released: the files and their checksums are locked under this revision.");
}

export async function withdrawRelease(projectId: string, releaseId: string, form: FormData) {
  const { supabase } = await requireUser();
  const { data: r } = await supabase.from("releases").select("status").eq("id", releaseId).maybeSingle();
  const { error } = await supabase.rpc("withdraw_release", { p_release: releaseId, p_reason: str(form, "reason") });
  if (error) fail(base(projectId, releaseId), error);
  if (r?.status === "draft") go(base(projectId), "Draft deleted.");
  go(base(projectId, releaseId), "Withdrawn.");
}
