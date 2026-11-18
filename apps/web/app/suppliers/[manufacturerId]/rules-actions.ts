"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { PROCESSES, parseRules, RULE_FIELDS, type Process } from "@vx/dfm";
import { fail, requireUser } from "@/lib/auth";

export async function saveProcessRules(manufacturerId: string, form: FormData) {
  const path = `/suppliers/${manufacturerId}`;
  const process = String(form.get("process") ?? "") as Process;
  if (!PROCESSES.some((p) => p.key === process)) fail(path, "Choose a process.");
  const input = Object.fromEntries(RULE_FIELDS[process].map((f) => [f.key, String(form.get(f.key) ?? "")]));
  const { rules, problems } = parseRules(process, input);
  if (problems.length) fail(path, problems.join("; "));
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("save_process_rules", {
    p_manufacturer: manufacturerId, p_process: process, p_rules: rules,
    p_source_url: String(form.get("source_url") ?? "").trim() || null, p_source_note: String(form.get("source_note") ?? "").trim() || null,
    p_checked_on: String(form.get("checked_on") ?? "") || null,
  });
  if (error) fail(path, error);
  revalidatePath(path);
  redirect(`${path}?notice=${encodeURIComponent(`${PROCESSES.find((p) => p.key === process)!.label} rules saved; a library editor verifies them against the source.`)}#rules`);
}

export async function verifyProcessRules(manufacturerId: string, rulesId: string) {
  const path = `/suppliers/${manufacturerId}`;
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("verify_process_rules", { p_id: rulesId });
  if (error) fail(path, error);
  revalidatePath(path);
  redirect(`${path}?notice=${encodeURIComponent("Rules verified.")}#rules`);
}

export async function deleteProcessRules(manufacturerId: string, rulesId: string) {
  const path = `/suppliers/${manufacturerId}`;
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("delete_process_rules", { p_id: rulesId });
  if (error) fail(path, error);
  revalidatePath(path);
  redirect(`${path}?notice=${encodeURIComponent("Rules removed.")}#rules`);
}
