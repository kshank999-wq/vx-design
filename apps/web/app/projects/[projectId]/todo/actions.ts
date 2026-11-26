"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { fail, requireUser } from "@/lib/auth";

/** Ticks off a to-do, marks it not needed, or opens it again. */
export async function setFileTask(projectId: string, id: string, status: "open" | "done" | "not_needed") {
  const path = `/projects/${projectId}/todo`;
  const { supabase } = await requireUser();
  const { error } = await supabase.from("owner_file_tasks").update({ status, closed_at: status === "open" ? null : new Date().toISOString() })
    .eq("id", id).eq("project_id", projectId);
  if (error) fail(path, error);
  revalidatePath(`/projects/${projectId}`, "layout");
  redirect(`${path}#item-${id}`);
}
