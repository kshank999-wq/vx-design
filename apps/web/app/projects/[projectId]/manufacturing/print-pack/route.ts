import { zipSync } from "fflate";
import { printSheet, stlStats, type PrintPart } from "@vx/dfm";
import { requireUser } from "@/lib/auth";
import { partModels, type Route } from "@/lib/manufacturing";

export const maxDuration = 120;

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "part";

/**
 * The 3D-printing export: a ZIP with one folder per chosen part (STL and STEP), a print sheet (PRINT-SHEET.md) with
 * material, settings, size and what each print stands in for, and parts.csv for a print service's order form.
 */
export async function GET(req: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const { supabase } = await requireUser();
  const ids = new URL(req.url).searchParams.getAll("route");
  const [{ data: project }, { data: rows }, models] = await Promise.all([
    supabase.from("projects").select("name").eq("id", projectId).maybeSingle(),
    supabase.from("part_routes").select("*").eq("project_id", projectId).order("name"),
    partModels(supabase, projectId),
  ]);
  if (!project) return new Response("Project not found.", { status: 404 });
  const routes = ((rows ?? []) as Route[]).filter((r) => !ids.length || ids.includes(r.id));
  if (!routes.length) return new Response("Choose at least one part to export.", { status: 400 });

  const files: Record<string, Uint8Array> = {};
  const parts: PrintPart[] = [];
  for (const [i, r] of routes.entries()) {
    const folder = `${String(i + 1).padStart(2, "0")}-${slug(r.name)}`;
    const m = models.find((x) => x.key === r.source_key);
    const names: string[] = [];
    let stats = null;
    for (const f of [m?.stl, m?.step]) {
      if (!f) continue;
      const { data } = await supabase.storage.from("project-files").download(f.path);
      if (!data) continue;
      const bytes = new Uint8Array(await data.arrayBuffer());
      files[`${folder}/${f.name}`] = bytes;
      names.push(f.name);
      if (f === m?.stl) { try { stats = stlStats(bytes); } catch { stats = null; } }
    }
    parts.push({ folder, route: r, files: names, stats });
  }
  const date = new Date().toISOString().slice(0, 10);
  const sheet = printSheet(project.name, date, parts);
  files["PRINT-SHEET.md"] = new TextEncoder().encode(sheet.markdown);
  files["parts.csv"] = new TextEncoder().encode(sheet.csv);
  const zip = zipSync(files, { level: 6 });
  return new Response(zip as unknown as BodyInit, {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${slug(project.name)}-3d-print-${date}.zip"`,
      "cache-control": "no-store",
    },
  });
}
