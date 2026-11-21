import { zipSync } from "fflate";
import { AssemblyDraft } from "@vx/planning";
import { requireUser } from "@/lib/auth";
import { assemblyBom, assemblyFigures } from "@/lib/assembly";
import { assemblyCsv, assemblyHtml } from "@/lib/assembly-html";

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "project";

/**
 * A version of the assembly instructions: ?format=html opens the printable document (print it or save it as PDF from
 * the browser); the default is a ZIP for the assembler with the document, its figures, steps.csv and bom.csv.
 */
export async function GET(req: Request, { params }: { params: Promise<{ projectId: string; versionId: string }> }) {
  const { projectId, versionId } = await params;
  const { supabase } = await requireUser();
  const [{ data: project }, { data: v }, figures] = await Promise.all([
    supabase.from("projects").select("name").eq("id", projectId).maybeSingle(),
    supabase.from("assembly_instructions").select("version, status, content, model, approved_at").eq("id", versionId).eq("project_id", projectId).maybeSingle(),
    assemblyFigures(supabase, projectId),
  ]);
  if (!project || !v) return new Response("Not found.", { status: 404 });
  const d = AssemblyDraft.parse(v.content);
  const used = figures.filter((f) => d.steps.some((s) => s.figure === f.code));
  const meta = { project: project.name, version: v.version, status: v.status, approvedAt: v.approved_at, model: v.model, exported: new Date().toISOString().slice(0, 10) };
  const bom = assemblyBom(d);
  const ext = (mime: string) => mime === "image/jpeg" ? "jpg" : mime.split("/")[1] ?? "png";

  if (new URL(req.url).searchParams.get("format") === "html") {
    const { data: signed } = used.length ? await supabase.storage.from("project-files").createSignedUrls(used.map((f) => f.path), 3600) : { data: [] };
    const src = Object.fromEntries(used.map((f, i) => [f.code, { src: signed?.[i]?.signedUrl ?? "", title: f.title }]));
    return new Response(assemblyHtml(d, meta, src, bom), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  }
  const files: Record<string, Uint8Array> = {};
  const src: Record<string, { src: string; title: string }> = {};
  for (const f of used) {
    const { data } = await supabase.storage.from("project-files").download(f.path);
    if (!data) continue;
    const name = `figures/${f.code}.${ext(f.mime)}`;
    files[name] = new Uint8Array(await data.arrayBuffer());
    src[f.code] = { src: name, title: f.title };
  }
  const enc = new TextEncoder();
  files["assembly-instructions.html"] = enc.encode(assemblyHtml(d, meta, src, bom));
  files["steps.csv"] = enc.encode(assemblyCsv(d));
  files["bom.csv"] = enc.encode(`qty,item,kind\n${bom.map((b) => [String(b.qty), /[",]/.test(b.item) ? `"${b.item.replace(/"/g, '""')}"` : b.item, b.kind].join(",")).join("\n")}\n`);
  const zip = zipSync(files, { level: 6 });
  return new Response(zip as unknown as BodyInit, { headers: {
    "content-type": "application/zip", "cache-control": "no-store",
    "content-disposition": `attachment; filename="${slug(project.name)}-assembly-v${v.version}${v.status === "approved" ? "" : "-DRAFT"}.zip"`,
  } });
}
