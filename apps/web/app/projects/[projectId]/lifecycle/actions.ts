"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { normalizeManufacturer, normalizeMpn } from "@vx/integrations";
import { fail, requireUser } from "@/lib/auth";
import { readSourcedBom } from "@/lib/lifecycle";

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const base = (projectId: string, caseId?: string) => `/projects/${projectId}/lifecycle${caseId ? `/${caseId}` : ""}`;
function go(path: string, notice: string): never {
  revalidatePath(path);
  redirect(`${path}?notice=${encodeURIComponent(notice)}`);
}

export async function loadBom(projectId: string, versionId: string) {
  const { supabase } = await requireUser();
  const { data: v } = await supabase.from("artifact_versions").select("storage_path").eq("id", versionId).eq("project_id", projectId).single();
  const bom = v ? await readSourcedBom(supabase, v.storage_path) : null;
  if (!bom?.lines) fail(base(projectId), "The sourced BOM could not be read.");
  const lines = bom.lines.map((l) => {
    const mpn = l.selected?.mpn ?? l.wanted.mpn ?? "";
    const mfr = l.selected?.manufacturer ?? l.wanted.manufacturer ?? "";
    return { mpn, manufacturer: mfr, normalized_mpn: mpn ? normalizeMpn(mpn) : "", normalized_mfr: mfr ? normalizeManufacturer(mfr) : "",
             refs: l.refs, qty_per_board: l.quantityPerBoard || l.refs.length || 1,
             alternates: (l.alternates ?? []).map((a) => ({ mpn: a.mpn, manufacturer: a.manufacturer })) };
  });
  const { data, error } = await supabase.rpc("load_bom_parts", { p_project: projectId, p_version: versionId, p_lines: lines });
  if (error) fail(base(projectId), error);
  go(base(projectId), `${data} BOM line(s) loaded into the watch.`);
}

export async function recordNotice(projectId: string, form: FormData) {
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("record_part_notice", {
    p_part: str(form, "part"), p_kind: str(form, "kind"), p_title: str(form, "title"), p_notice_ref: str(form, "notice_ref") || null,
    p_summary: str(form, "summary") || null, p_issued_on: str(form, "issued_on") || null, p_effective_on: str(form, "effective_on") || null,
    p_last_order_on: str(form, "last_order_on") || null, p_last_ship_on: str(form, "last_ship_on") || null,
    p_source_url: str(form, "source_url") || null, p_source_note: str(form, "source_note") || null,
  });
  if (error) fail(base(projectId), error);
  go(base(projectId), "Notice recorded.");
}

export async function openCase(projectId: string, form: FormData) {
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc("open_lifecycle_case", {
    p_project: projectId, p_part: str(form, "part") || null, p_mpn: str(form, "mpn"), p_manufacturer: str(form, "manufacturer") || null,
    p_refs: str(form, "refs").split(/[\s,]+/).filter(Boolean), p_trigger: str(form, "trigger"), p_severity: str(form, "severity") || "medium",
    p_notice: str(form, "notice") || null,
  });
  if (error) fail(base(projectId), error);
  go(base(projectId, data as string), "Case opened: write the impact assessment, then look for substitutes or other options.");
}

export async function assessCase(projectId: string, caseId: string, form: FormData) {
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("assess_lifecycle_case", { p_case: caseId, p_impact: str(form, "impact"), p_severity: str(form, "severity") || null });
  if (error) fail(base(projectId, caseId), error);
  go(base(projectId, caseId), "Assessment saved.");
}

export async function proposeSubstitute(projectId: string, caseId: string, form: FormData) {
  const { supabase } = await requireUser();
  const [mpn, manufacturer] = str(form, "pick") ? str(form, "pick").split("|") : [str(form, "mpn"), str(form, "manufacturer")];
  const { data: part } = await supabase.from("parts").select("id").eq("normalized_mpn", normalizeMpn(mpn ?? "")).limit(1).maybeSingle();
  const { error } = await supabase.rpc("propose_substitute", { p_project: projectId, p_case: caseId, p_original_mpn: null, p_mpn: mpn ?? "",
    p_manufacturer: manufacturer ?? "", p_part: part?.id ?? null });
  if (error) fail(base(projectId, caseId), error);
  go(base(projectId, caseId), `${mpn} proposed: work through the qualification checks.`);
}

export async function saveChecks(projectId: string, caseId: string, subId: string, form: FormData) {
  const { supabase } = await requireUser();
  const checks: Record<string, { result: string; basis: string; test_run_id?: string }> = {};
  for (const k of ["pinout", "electrical", "environmental", "supply", "test"]) {
    const result = str(form, `${k}_result`), basis = str(form, `${k}_basis`);
    if (!result && !basis) continue;
    checks[k] = { result, basis, ...(k === "test" && str(form, "test_run") ? { test_run_id: str(form, "test_run") } : {}) };
  }
  const { error } = await supabase.rpc("save_substitute_checks", { p_substitute: subId, p_checks: checks });
  if (error) fail(base(projectId, caseId), error);
  go(base(projectId, caseId), "Checks saved.");
}

export async function decideSubstitute(projectId: string, caseId: string, subId: string, form: FormData) {
  const { supabase } = await requireUser();
  const qualified = str(form, "decision") === "qualify";
  const { error } = await supabase.rpc("decide_substitute", { p_substitute: subId, p_qualified: qualified, p_note: str(form, "note") });
  if (error) fail(base(projectId, caseId), error);
  go(base(projectId, caseId), qualified ? "Substitute qualified." : "Substitute rejected.");
}

export async function resolveCase(projectId: string, caseId: string, form: FormData) {
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("resolve_lifecycle_case", { p_case: caseId, p_resolution: str(form, "resolution"), p_note: str(form, "note"),
    p_substitute: str(form, "substitute") || null, p_ltb_quantity: str(form, "ltb_quantity") ? Number(str(form, "ltb_quantity")) : null });
  if (error) fail(base(projectId, caseId), error);
  go(base(projectId, caseId), "Resolved and recorded as a project decision.");
}
