"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { fail, requireUser } from "@/lib/auth";

/** Administrators: move an account to another plan (its monthly allowances follow the plan). */
export async function setAccountPlan(userId: string, form: FormData) {
  const path = "/admin/accounts";
  const { supabase } = await requireUser();
  const plan = String(form.get("plan") ?? "");
  const { error } = await supabase.rpc("admin_set_account_plan", { p_user: userId, p_plan: plan });
  if (error) fail(path, error);
  revalidatePath(path);
  redirect(`${path}?notice=${encodeURIComponent("Plan changed. Runs stopped by the old plan's allowance can be restarted now.")}`);
}
