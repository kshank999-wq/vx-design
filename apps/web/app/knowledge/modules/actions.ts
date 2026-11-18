"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { normalizeMpn } from "@vx/integrations";
import { fail, requireUser } from "@/lib/auth";
import { list, MODULE_KINDS, parseModuleText } from "@/lib/modules";

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const num = (f: FormData, k: string) => (str(f, k) === "" || !Number.isFinite(Number(str(f, k))) ? undefined : Number(str(f, k)));

export async function saveModule(moduleId: string | null, form: FormData) {
  const path = moduleId ? `/knowledge/modules/${moduleId}` : "/knowledge/modules";
  if (!(str(form, "kind") in MODULE_KINDS)) fail(path, "Choose what kind of module it is.");
  const { performance, certifications, cad } = parseModuleText(str(form, "performance"), str(form, "certifications"), str(form, "cad"));
  const drop = <T extends object>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
  const mod = {
    kind: str(form, "kind"), name: str(form, "name"), manufacturer: str(form, "manufacturer"), mpn: str(form, "mpn"), normalized_mpn: normalizeMpn(str(form, "mpn")),
    description: str(form, "description"), interfaces: list(str(form, "interfaces")), radios: list(str(form, "radios")),
    supply: drop({ v_min: num(form, "v_min"), v_max: num(form, "v_max"), i_typ_ma: num(form, "i_typ_ma"), i_max_ma: num(form, "i_max_ma"), sleep_ua: num(form, "sleep_ua") }),
    dimensions_mm: drop({ x: num(form, "dim_x"), y: num(form, "dim_y"), z: num(form, "dim_z") }),
    performance, certifications, cad, lifecycle: str(form, "lifecycle") || "unknown",
    source_url: str(form, "source_url"), source_note: str(form, "source_note"), checked_on: str(form, "checked_on"),
  };
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc("save_module", { p_id: moduleId, p_module: mod });
  if (error) fail(path, error);
  revalidatePath("/knowledge/modules");
  redirect(`/knowledge/modules/${data}?notice=${encodeURIComponent(moduleId ? "Saved: a library editor verifies it again." : "Module added: a library editor verifies it against its sources.")}`);
}

export async function verifyModule(moduleId: string) {
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("verify_module", { p_id: moduleId });
  if (error) fail(`/knowledge/modules/${moduleId}`, error);
  revalidatePath(`/knowledge/modules/${moduleId}`);
  redirect(`/knowledge/modules/${moduleId}?notice=${encodeURIComponent("Verified.")}`);
}
