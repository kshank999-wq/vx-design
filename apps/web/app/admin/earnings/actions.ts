"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { fail, requireUser } from "@/lib/auth";

export async function setReferenceMarkup(form: FormData) {
  const { supabase } = await requireUser();
  const pct = Number(form.get("pct"));
  const { error } = await supabase.rpc("set_reference_markup", { p_pct: pct });
  if (error) fail("/admin/earnings", error);
  revalidatePath("/admin/earnings");
  redirect(`/admin/earnings?notice=${encodeURIComponent(`In-house projects are now measured at ${pct}% markup.`)}`);
}
