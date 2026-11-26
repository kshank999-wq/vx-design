import type { SupabaseClient } from "@supabase/supabase-js";

/** Brings the to-do list up to date: ticks off items whose file was uploaded, adds the boards' important parts. */
export async function refreshFileTasks(supabase: SupabaseClient, projectId: string) {
  await supabase.rpc("refresh_owner_file_tasks", { p_project: projectId });
  await addFromDesigns(supabase, projectId);
}

/** Important parts (connectors, chips, modules, crystals, switches, batteries, displays) of each board's newest circuit design. */
const KEY_REF = /^(J|U|Y|X|SW|BT|DS|M|LCD|MOD|CN|P)\d/;
async function addFromDesigns(supabase: SupabaseClient, projectId: string) {
  const { data: rows } = await supabase.from("artifact_versions").select("storage_path, created_at, artifacts(name)")
    .eq("project_id", projectId).eq("status", "committed").order("created_at", { ascending: false }).limit(800);
  const seen = new Set<string>();
  const designs = (rows ?? []).filter((r) => {
    const name = (r.artifacts as unknown as { name: string } | null)?.name ?? "";
    if (!name.endsWith("/design") || seen.has(name)) return false;
    seen.add(name);
    return true;
  }).slice(0, 12);
  const items = new Map<string, Record<string, string>>();
  for (const d of designs) {
    const { data: blob } = await supabase.storage.from("project-files").download(d.storage_path);
    if (!blob) continue;
    let json: { components?: { ref: string; value?: string; mpn?: string | null; manufacturer?: string | null; purpose?: string; datasheet?: string | null }[] } | null = null;
    try { json = JSON.parse(await blob.text()); } catch { continue; }
    for (const c of json?.components ?? []) {
      if (!c.mpn || !KEY_REF.test(c.ref) || items.has(c.mpn.toLowerCase())) continue;
      items.set(c.mpn.toLowerCase(), {
        kind: "3d_model", mpn: c.mpn, manufacturer: c.manufacturer ?? "",
        title: `Get the 3D model (STEP file) for ${c.mpn}${c.manufacturer ? ` by ${c.manufacturer}` : ""}`,
        why: `${c.ref}${c.purpose ? ` (${c.purpose})` : ""}: with its real shape the casing and fit checks are exact instead of using a generic box.`,
        where_to_look: (c.datasheet ? `Start from the part's page: ${c.datasheet} . ` : "") + "The manufacturer's product page for this part number, usually under Downloads, CAD models or 3D (STEP). Distributors such as DigiKey and Mouser also link it under \"CAD models\".",
      });
    }
  }
  if (items.size) await supabase.rpc("add_owner_file_tasks", { p_project: projectId, p_items: [...items.values()].slice(0, 60) });
}
