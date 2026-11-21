"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { optionByKey, type PartNeeds } from "@vx/dfm";
import { fail, requireUser } from "@/lib/auth";

const base = (projectId: string) => `/projects/${projectId}/manufacturing`;
const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const int = (f: FormData, k: string) => { const n = Number(str(f, k)); return str(f, k) && Number.isFinite(n) ? Math.round(n) : null; };
function go(projectId: string, notice: string): never {
  revalidatePath(base(projectId));
  redirect(`${base(projectId)}?notice=${encodeURIComponent(notice)}`);
}

const NEED_FLAGS = ["outdoor", "impact", "snap_fits", "flexible", "clear", "cosmetic", "precise"] as const;
function needsOf(form: FormData): PartNeeds {
  const n: PartNeeds = {};
  for (const k of NEED_FLAGS) if (form.get(k) === "on") n[k] = true;
  const t = int(form, "max_temp_c");
  if (t != null) n.max_temp_c = t;
  return n;
}

/** Adds or edits a part's route: what it must survive, the prototype and the production process. */
export async function saveRoute(projectId: string, routeId: string | null, form: FormData) {
  const { supabase } = await requireUser();
  const option = str(form, "prototype_option");
  if (option && !optionByKey(option)) fail(base(projectId), "Unknown prototype material.");
  const { error } = await supabase.rpc("save_part_route", {
    p_project: projectId, p_id: routeId, p_name: str(form, "name"), p_source_key: str(form, "source_key") || null, p_needs: needsOf(form),
    p_prototype_option: option || null, p_prototype_qty: int(form, "prototype_qty"), p_production_process: str(form, "production_process") || null,
    p_production_material: str(form, "production_material") || null, p_production_volume: int(form, "production_volume"),
    p_finish: str(form, "finish") || null, p_notes: str(form, "notes") || null,
  });
  if (error) fail(base(projectId), error);
  go(projectId, `${str(form, "name")}: route saved.`);
}

/** Takes one of the suggested prototype materials. */
export async function chooseSuggestion(projectId: string, routeId: string, option: string) {
  const { supabase } = await requireUser();
  const { data: r } = await supabase.from("part_routes").select("*").eq("id", routeId).single();
  const o = optionByKey(option);
  if (!r || !o) fail(base(projectId), "Route or material not found.");
  const { error } = await supabase.rpc("save_part_route", {
    p_project: projectId, p_id: routeId, p_name: r.name, p_source_key: r.source_key, p_needs: r.needs, p_prototype_option: option,
    p_prototype_qty: r.prototype_qty, p_production_process: r.production_process, p_production_material: r.production_material,
    p_production_volume: r.production_volume, p_finish: r.finish, p_notes: r.notes,
  });
  if (error) fail(base(projectId), error);
  go(projectId, `${r.name}: prototype in ${o.material}.`);
}

export async function removeRoute(projectId: string, routeId: string) {
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("remove_part_route", { p_id: routeId });
  if (error) fail(base(projectId), error);
  go(projectId, "Route removed.");
}

/** The injection molding spec of a part: pull, finish, cosmetic faces, tolerances, critical dimensions and more. */
export async function saveMolding(projectId: string, routeId: string, form: FormData) {
  const { supabase } = await requireUser();
  const cav = int(form, "cavities");
  const spec = Object.fromEntries(["pull", "finish", "grade", "flammability", "cosmetic_faces", "tolerance", "critical_dims", "gates", "inserts", "notes"]
    .map((k) => [k, str(form, k) || null]));
  const { error } = await supabase.rpc("save_part_molding", { p_id: routeId, p_molding: { ...spec, cavities: cav && cav > 0 ? cav : null } });
  if (error) fail(base(projectId), error);
  go(projectId, "Molding spec saved.");
}
