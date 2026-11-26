import type { SupabaseClient } from "@supabase/supabase-js";
import { SubmitButton } from "@/components/SubmitButton";
import { closeFileTask } from "@/app/projects/[projectId]/questions/actions";

const KIND: Record<string, string> = { datasheet: "Datasheet", "3d_model": "3D model (STEP)", drawing: "Drawing", other: "File" };
const SEARCH: Record<string, string> = { datasheet: "datasheet pdf", "3d_model": "STEP 3D model download", drawing: "mechanical drawing pdf", other: "" };

/**
 * "To do for you": files to download from manufacturers' websites (datasheets, 3D STEP models, drawings), asked for by
 * the design steps or missing for the important parts of the parts list. An item ticks itself off when a matching file is
 * uploaded on Inputs; it can also be marked done or not needed.
 */
export async function FileTasks({ supabase, projectId, canEdit }: { supabase: SupabaseClient; projectId: string; canEdit: boolean }) {
  if (canEdit) {
    await supabase.rpc("refresh_owner_file_tasks", { p_project: projectId });
    await addFromDesigns(supabase, projectId);
  }
  const { data: rows } = await supabase.from("owner_file_tasks").select("id, kind, mpn, manufacturer, title, why, where_to_look, created_at, tasks(title)")
    .eq("project_id", projectId).eq("status", "open").order("created_at");
  if (!rows?.length) return null;
  return (
    <section className="card file-tasks" id="to-do" data-testid="file-tasks">
      <h2>To do for you <span className="muted small">({rows.length})</span></h2>
      <p className="small muted">Files the design work needs that manufacturers publish on their websites. Download each one and upload it on
        {" "}<a href={`/projects/${projectId}/inputs`}>Inputs</a> (add it to the part). The item ticks itself off when the file is there.</p>
      <ol className="list">{rows.map((r) => {
        const q = encodeURIComponent([r.mpn, r.manufacturer, SEARCH[r.kind] ?? ""].filter(Boolean).join(" "));
        return (
          <li key={r.id}>
            <div className="row spread wrap"><strong>{r.title}</strong><span className="pill">{KIND[r.kind] ?? r.kind}</span></div>
            {r.why && <div className="small">Why: {r.why}</div>}
            {r.where_to_look && <div className="small muted">Where: {r.where_to_look}</div>}
            {(r.tasks as unknown as { title: string } | null)?.title && <div className="small muted">Asked by the step "{(r.tasks as unknown as { title: string }).title}"</div>}
            <div className="row tight wrap" style={{ marginTop: 6 }}>
              {r.mpn && <a className="btn btn-small" href={`https://www.google.com/search?q=${q}`} target="_blank" rel="noreferrer">Search the web for it ↗</a>}
              <a className="btn btn-small" href={`/projects/${projectId}/inputs`}>Upload it on Inputs</a>
              {canEdit && <form action={closeFileTask.bind(null, projectId, r.id, "done")}><SubmitButton variant="secondary">Done</SubmitButton></form>}
              {canEdit && <form action={closeFileTask.bind(null, projectId, r.id, "not_needed")}><SubmitButton variant="secondary">Not needed</SubmitButton></form>}
            </div>
          </li>
        );
      })}</ol>
    </section>
  );
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
