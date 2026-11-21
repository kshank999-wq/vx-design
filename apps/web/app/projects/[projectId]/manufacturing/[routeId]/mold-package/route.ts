import { zipSync } from "fflate";
import { analyzeMolding, moldable, moldingSheet, parseStl, type MoldingAnalysis } from "@vx/dfm";
import { requireUser } from "@/lib/auth";
import { partModels, type Route } from "@/lib/manufacturing";

export const maxDuration = 120;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "part";

/**
 * The mold maker's package for one part: its STEP and STL, MOLDING-SPEC.md (material, finish, cosmetic surfaces,
 * tolerances, critical dimensions, volume, suggested tool, the design check and what to quote) and design-check.csv.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ projectId: string; routeId: string }> }) {
  const { projectId, routeId } = await params;
  const { supabase } = await requireUser();
  const [{ data: project }, { data: row }, models] = await Promise.all([
    supabase.from("projects").select("name").eq("id", projectId).maybeSingle(),
    supabase.from("part_routes").select("*").eq("id", routeId).eq("project_id", projectId).maybeSingle(),
    partModels(supabase, projectId),
  ]);
  if (!project || !row) return new Response("Not found.", { status: 404 });
  const r = row as Route;
  const m = models.find((x) => x.key === r.source_key);
  const files: Record<string, Uint8Array> = {};
  const names: string[] = [];
  let analysis: MoldingAnalysis | null = null;
  for (const f of [m?.step, m?.stl]) {
    if (!f) continue;
    const { data } = await supabase.storage.from("project-files").download(f.path);
    if (!data) continue;
    const bytes = new Uint8Array(await data.arrayBuffer());
    files[`cad/${f.name}`] = bytes;
    names.push(f.name);
    if (f === m?.stl && moldable(r.production_material)) { try { analysis = analyzeMolding(parseStl(bytes), r.production_material!, r.molding ?? {}); } catch { analysis = null; } }
  }
  const date = new Date().toISOString().slice(0, 10);
  const enc = new TextEncoder();
  files["MOLDING-SPEC.md"] = enc.encode(moldingSheet(project.name, date, r, r.molding ?? {}, analysis, names));
  if (analysis) {
    const cell = (c: string) => /[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c;
    files["design-check.csv"] = enc.encode(`level,finding\n${analysis.findings.map((f) => `${f.level},${cell(f.text)}`).join("\n")}\n`);
  }
  if (r.molding?.critical_dims) files["critical-dimensions.txt"] = enc.encode(`${r.molding.critical_dims.trim()}\n`);
  return new Response(zipSync(files, { level: 6 }) as unknown as BodyInit, { headers: {
    "content-type": "application/zip", "cache-control": "no-store",
    "content-disposition": `attachment; filename="${slug(project.name)}-${slug(r.name)}-mold-package-${date}.zip"`,
  } });
}
