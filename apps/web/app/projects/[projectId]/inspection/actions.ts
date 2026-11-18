"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { FAB_PROFILE_FACTS } from "@vx/dfm";
import { enclosurePlan, pcbaPlan, type FabCheckFacts, type FitReportFacts, type InspectionItem } from "@vx/planning";
import { fail, requireUser } from "@/lib/auth";
import { latestJson, processTolerance } from "@/lib/mech";

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const base = (projectId: string, planId?: string) => `/projects/${projectId}/inspection${planId ? `/${planId}` : ""}`;
function go(path: string, notice: string): never {
  revalidatePath(path);
  redirect(`${path}?notice=${encodeURIComponent(notice)}`);
}

interface FabCheckJson { profile?: string; board: FabCheckFacts["board"]; parts: (FabCheckFacts["parts"][number] & { dnp?: boolean; exclude_from_bom?: boolean })[] }

/** Draft a bare-board or assembled-board plan from the latest committed fab check. */
export async function draftFromFab(projectId: string, form: FormData) {
  const { supabase } = await requireUser();
  const fab = await latestJson(supabase, projectId, "fab-check");
  if (!fab) fail(base(projectId), new Error("No committed fab package yet: run manufacturing and approve its task."));
  const j = fab.json as FabCheckJson;
  const kind = str(form, "kind") === "bare_pcb" ? "bare_pcb" : "pcba";
  const procId = str(form, "procedure");
  const { data: proc } = procId
    ? await supabase.from("test_procedures").select("id, code, version, title").eq("id", procId).eq("project_id", projectId).eq("status", "approved").maybeSingle()
    : { data: null };
  const facts: FabCheckFacts = {
    profile: j.profile,
    board: { ...j.board, thickness_mm: FAB_PROFILE_FACTS[j.profile ?? ""]?.thickness_mm },
    parts: j.parts.filter((p) => !p.dnp && !p.exclude_from_bom),
  };
  const items = pcbaPlan(facts, { assembled: kind === "pcba", productionTest: proc });
  const { data, error } = await supabase.rpc("save_inspection_plan", {
    p_project: projectId, p_id: null, p_kind: kind, p_title: str(form, "title") || (kind === "pcba" ? "Assembled board" : "Bare board"),
    p_source: { artifact: fab.name, version: fab.version, procedure: proc ? `${proc.code} v${proc.version}` : null }, p_items: items,
  });
  if (error) fail(base(projectId), error);
  go(base(projectId, data as string), `Drafted ${items.length} items from ${fab.name} v${fab.version}.`);
}

/** Draft an enclosure plan from the latest committed fit report, with the process tolerance and where it came from. */
export async function draftFromEnclosure(projectId: string, form: FormData) {
  const { supabase } = await requireUser();
  const fit = await latestJson(supabase, projectId, "fit-report");
  if (!fit) fail(base(projectId), new Error("No committed enclosure fit report yet: run the enclosure task and approve it."));
  const j = fit.json as FitReportFacts;
  const t = await processTolerance(supabase, j.process?.name ?? "fdm");
  const items = enclosurePlan(j, { mm: t.tolerance_mm, basis: t.basis });
  const { data, error } = await supabase.rpc("save_inspection_plan", {
    p_project: projectId, p_id: null, p_kind: "enclosure", p_title: str(form, "title") || "Enclosure",
    p_source: { artifact: fit.name, version: fit.version, tolerance: t }, p_items: items,
  });
  if (error) fail(base(projectId), error);
  go(base(projectId, data as string), `Drafted ${items.length} items from ${fit.name} v${fit.version}.`);
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || "item";

/** Save the edited table: rows marked for removal are dropped; a filled-in new row is added. */
export async function savePlan(projectId: string, planId: string, kind: string, form: FormData) {
  const { supabase } = await requireUser();
  const n = Number(str(form, "count"));
  const items: InspectionItem[] = [];
  const row = (p: string, key: string): InspectionItem => ({
    key, stage: str(form, `${p}stage`) as InspectionItem["stage"], characteristic: str(form, `${p}characteristic`), method: str(form, `${p}method`),
    sample: str(form, `${p}sample`) as InspectionItem["sample"], acceptance: str(form, `${p}acceptance`), reference: str(form, `${p}reference`),
    critical: form.get(`${p}critical`) === "on",
  });
  for (let i = 0; i < n; i++) if (form.get(`${i}_remove`) !== "on") items.push(row(`${i}_`, str(form, `${i}_key`)));
  if (str(form, "new_characteristic")) {
    let key = slug(str(form, "new_characteristic")), k = 2;
    while (items.some((x) => x.key === key)) key = `${slug(str(form, "new_characteristic")).slice(0, 36)}_${k++}`;
    items.push(row("new_", key));
  }
  const { error } = await supabase.rpc("save_inspection_plan", {
    p_project: projectId, p_id: planId, p_kind: kind, p_title: str(form, "title"), p_source: null, p_items: items,
  });
  if (error) fail(base(projectId, planId), error);
  go(base(projectId, planId), `Saved ${items.length} items.`);
}

export async function approvePlan(projectId: string, planId: string, form: FormData) {
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("approve_inspection_plan", { p_id: planId, p_note: str(form, "note") || null });
  if (error) fail(base(projectId, planId), error);
  go(base(projectId, planId), "Plan approved.");
}

export async function revisePlan(projectId: string, planId: string) {
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc("revise_inspection_plan", { p_id: planId });
  if (error) fail(base(projectId, planId), error);
  go(base(projectId, data as string), "New draft version made; approve it to replace the current plan.");
}

export async function setLotPlan(projectId: string, lotId: string, form: FormData) {
  const { supabase } = await requireUser();
  const path = `/projects/${projectId}/production/${lotId}`;
  const { error } = await supabase.rpc("set_lot_inspection_plan", { p_lot: lotId, p_plan: str(form, "plan") || null });
  if (error) fail(path, error);
  go(path, str(form, "plan") ? "Inspection plan set." : "Inspection plan cleared.");
}
