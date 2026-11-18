"use server";
import { redirect } from "next/navigation";
import { fail, requireUser } from "@/lib/auth";

export async function createProject(form: FormData) {
  const { supabase, userId } = await requireUser();
  const name = String(form.get("name") ?? "").trim();
  const description = String(form.get("description") ?? "").trim() || null;
  if (!name) fail("/projects", "Project name is required.");
  const { data, error } = await supabase.from("projects").insert({ name, description, created_by: userId, stage_gates: form.get("stage_gates") === "on" }).select("id").single();
  if (error) fail("/projects", error);
  redirect(`/projects/${data.id}`);
}
