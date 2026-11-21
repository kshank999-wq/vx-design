import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { routeLine } from "@vx/dfm";
import type { AssemblyDraft, AssemblyInput } from "@vx/planning";
import { IMAGE_TYPES, refCode } from "./plan-inputs";

export interface Figure { code: string; title: string; note: string | null; path: string; mime: string }

/** Project images that a step may show, by REF code. */
export async function assemblyFigures(supabase: SupabaseClient, projectId: string): Promise<Figure[]> {
  const { data } = await supabase.from("project_references").select("ref_no, title, note, storage_path, mime_type").eq("project_id", projectId)
    .in("mime_type", IMAGE_TYPES).order("ref_no");
  return (data ?? []).map((r) => ({ code: refCode(r.ref_no), title: r.title, note: r.note, path: r.storage_path, mime: r.mime_type ?? "image/png" }));
}

async function latestJson(supabase: SupabaseClient, projectId: string, suffix: string): Promise<Record<string, unknown> | null> {
  const { data } = await supabase.from("artifact_versions").select("storage_path, artifacts!inner(name)").eq("project_id", projectId)
    .eq("status", "committed").like("artifacts.name", `%/${suffix}`).order("committed_at", { ascending: false }).limit(1).maybeSingle();
  if (!data?.storage_path) return null;
  const { data: blob } = await supabase.storage.from("project-files").download(data.storage_path);
  try { return blob ? JSON.parse(await blob.text()) : null; } catch { return null; }
}

/** Everything the assembly instructions are drafted from: made parts, bought parts, boards, the enclosure, requirements, figures. */
export async function assemblyInput(supabase: SupabaseClient, projectId: string, guidance: string | null): Promise<AssemblyInput> {
  const [{ data: project }, { data: routes }, { data: parts }, { data: boards }, { data: audits }, { data: reqs }, figures, enc] = await Promise.all([
    supabase.from("projects").select("name, description").eq("id", projectId).single(),
    supabase.from("part_routes").select("*").eq("project_id", projectId).order("name"),
    supabase.from("project_parts").select("mpn, manufacturer, role, subsystem, status").eq("project_id", projectId).neq("status", "rejected").order("subsystem"),
    supabase.from("artifact_versions").select("artifacts!inner(name), tasks:produced_by_task_id(title)").eq("project_id", projectId)
      .eq("status", "committed").like("artifacts.name", "%/kicad-project"),
    supabase.from("flux_audits").select("audit_no, title, summary").eq("project_id", projectId).eq("status", "ready").eq("use_in_plan", true).order("audit_no"),
    supabase.from("requirements").select("ref_code, text, kind").eq("project_id", projectId).neq("status", "rejected")
      .in("kind", ["mechanical", "environmental", "regulatory", "manufacturing"]).order("ref_code").limit(40),
    assemblyFigures(supabase, projectId),
    latestJson(supabase, projectId, "enclosure-design"),
  ]);
  const boardList = new Map<string, string>();
  for (const b of boards ?? []) {
    const task = (b.tasks as unknown as { title: string } | null)?.title;
    const name = task ?? (b.artifacts as unknown as { name: string }).name.replace(/\/kicad-project$/, "");
    boardList.set(name, "designed in VX Design (committed layout)");
  }
  if (!boardList.size) for (const a of audits ?? []) {
    const s = (a.summary ?? {}) as { components?: number };
    boardList.set(a.title, `from Flux import #${a.audit_no}${s.components ? `, ${s.components} parts` : ""}`);
  }
  const e = enc as { process?: string; material?: string; wall_mm?: number; standoff_height_mm?: number; fastening?: string; openings?: { kind: string; ref: string }[] } | null;
  return {
    project: { name: project?.name ?? "", description: project?.description },
    made: (routes ?? []).map((r) => ({ name: r.name, route: routeLine(r).replace(/^[^:]+: /, "") })),
    bought: (parts ?? []).map((p) => ({ mpn: p.mpn, manufacturer: p.manufacturer, role: p.role, subsystem: p.subsystem })),
    boards: [...boardList].map(([name, detail]) => ({ name, detail })),
    enclosure: e ? `${e.process ?? "?"} ${e.material ?? ""}, wall ${e.wall_mm ?? "?"} mm, standoffs ${e.standoff_height_mm ?? "?"} mm, board fastening ${e.fastening?.replace(/_/g, " ") ?? "?"}` +
      `${e.openings?.length ? `, openings for ${e.openings.map((o) => o.ref).join(", ")}` : ""}` : null,
    requirements: (reqs ?? []).map((r) => ({ refCode: r.ref_code, text: r.text })),
    figures: figures.map((f) => ({ code: f.code, title: f.title, note: f.note })),
    guidance,
  };
}

/** Every part, fastener and consumable the build uses, with quantities per unit. */
export function assemblyBom(d: AssemblyDraft): { item: string; qty: number; kind: "part" | "fastener" }[] {
  const m = new Map<string, { item: string; qty: number; kind: "part" | "fastener" }>();
  for (const s of d.steps) {
    for (const p of s.parts) { const k = `p:${p.name}`; const x = m.get(k) ?? { item: p.name, qty: 0, kind: "part" as const }; x.qty += p.qty; m.set(k, x); }
    for (const f of s.fasteners) { const k = `f:${f.spec}`; const x = m.get(k) ?? { item: f.spec, qty: 0, kind: "fastener" as const }; x.qty += f.qty; m.set(k, x); }
  }
  return [...m.values()];
}
