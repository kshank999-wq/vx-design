import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { MoldingSpec, PartNeeds } from "@vx/dfm";

/** A physical part with a model: a generated enclosure part, or a model file someone uploaded. */
export interface PartModel {
  key: string;            // "artifact:<task key>/base" or "ref:<reference id>"
  label: string;
  stl: { path: string; name: string } | null;
  step: { path: string; name: string } | null;
  origin: string;
}

export interface Route {
  id: string; name: string; source_key: string | null; needs: PartNeeds; prototype_option: string | null; prototype_qty: number | null;
  production_process: string | null; production_material: string | null; production_volume: number | null; finish: string | null; notes: string | null;
  molding: MoldingSpec;
}

const PART_LABEL: Record<string, string> = { base: "Enclosure base", lid: "Enclosure lid" };

/** Every part model in the project: the newest enclosure base and lid of each enclosure task, and uploaded 3D models. */
export async function partModels(supabase: SupabaseClient, projectId: string): Promise<PartModel[]> {
  const [{ data: versions }, { data: refs }] = await Promise.all([
    supabase.from("artifact_versions").select("storage_path, version, status, created_at, artifacts!inner(name, kind)")
      .eq("project_id", projectId).neq("status", "superseded").in("artifacts.kind", ["stl", "step"]).order("created_at", { ascending: false }),
    supabase.from("project_references").select("id, ref_no, title, filename, storage_path").eq("project_id", projectId).eq("kind", "model_3d").is("part_id", null).order("ref_no"),
  ]);
  const byKey = new Map<string, PartModel>();
  for (const v of versions ?? []) {
    const name = (v.artifacts as unknown as { name: string }).name;
    const m = /^(.+)\/(base|lid)-(stl|step)$/.exec(name);
    if (!m) continue;
    const [, task, part, ext] = m as unknown as [string, string, "base" | "lid", "stl" | "step"];
    const key = `artifact:${task}/${part}`;
    const p = byKey.get(key) ?? { key, label: PART_LABEL[part]!, stl: null, step: null, origin: `enclosure task ${task}` };
    if (!p[ext]) p[ext] = { path: v.storage_path, name: `enclosure-${part}.${ext}` };   // newest first
    byKey.set(key, p);
  }
  for (const r of refs ?? []) {
    const isStl = /\.stl$/i.test(r.filename);
    byKey.set(`ref:${r.id}`, { key: `ref:${r.id}`, label: r.title, origin: `uploaded model REF-${r.ref_no}`,
      stl: isStl ? { path: r.storage_path, name: r.filename } : null, step: isStl ? null : { path: r.storage_path, name: r.filename } });
  }
  return [...byKey.values()];
}

export { prodMaterialLabel, prodProcessLabel, routeLine } from "@vx/dfm";
