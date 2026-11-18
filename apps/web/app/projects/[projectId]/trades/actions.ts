"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { normalizeMpn, pricing, type Offer } from "@vx/integrations";
import { LIFECYCLE_RATING, rankOptions, TRADE_TEMPLATES, type Criterion, type Scores, type TradeOption } from "@vx/planning";
import { fail, requireUser } from "@/lib/auth";
import { DECISION_CLASSES, slug, type Study } from "@/lib/trades";
import { STAGES } from "@/lib/stages";

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const base = (projectId: string, studyId?: string) => `/projects/${projectId}/trades${studyId ? `/${studyId}` : ""}`;

export async function createStudy(projectId: string, form: FormData) {
  const path = base(projectId);
  const t = TRADE_TEMPLATES[str(form, "template")] ?? TRADE_TEMPLATES.blank!;
  const stage = str(form, "stage") || "S2", cls = str(form, "decision_class") || "component_selection";
  if (!STAGES.includes(stage as never) || !DECISION_CLASSES.includes(cls as never)) fail(path, "Choose a stage and a decision type.");
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc("create_trade_study", {
    p_project: projectId, p_question: str(form, "question"), p_criteria: t.criteria, p_options: t.options, p_stage: stage, p_decision_class: cls,
  });
  if (error) fail(path, error);
  redirect(`${base(projectId, data as string)}?notice=${encodeURIComponent("Study started: add options, adjust the criteria, then score them.")}`);
}

/** Reads the editor form: criteria and option rows (blank rows ignored) and the score grid. */
function readForm(form: FormData, old: Study): { criteria: Criterion[]; options: TradeOption[]; scores: Scores; problems: string[] } {
  const problems: string[] = [];
  const rows = (prefix: string) => [...new Set([...form.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)))];
  const criteria: Criterion[] = [];
  for (const i of rows("c_label_")) {
    const label = str(form, `c_label_${i}`);
    if (!label) continue;
    const kind = str(form, `c_kind_${i}`) as Criterion["kind"];
    const weight = kind === "must" ? 0 : Number(str(form, `c_weight_${i}`) || "5");
    if (!Number.isFinite(weight) || weight < 0 || weight > 10) problems.push(`${label}: weight is 0–10`);
    criteria.push({ key: str(form, `c_key_${i}`) || slug(label), label, kind, weight: Math.max(0, Math.min(10, weight || 0)),
                    ...(str(form, `c_unit_${i}`) ? { unit: str(form, `c_unit_${i}`) } : {}) });
  }
  const options: TradeOption[] = [];
  for (const j of rows("o_name_")) {
    const name = str(form, `o_name_${j}`);
    if (!name) continue;
    options.push({ key: str(form, `o_key_${j}`) || slug(name), name,
                   ...(str(form, `o_desc_${j}`) ? { description: str(form, `o_desc_${j}`) } : {}),
                   ...(str(form, `o_mpn_${j}`) ? { mpn: str(form, `o_mpn_${j}`) } : {}),
                   ...(str(form, `o_mfr_${j}`) ? { manufacturer: str(form, `o_mfr_${j}`) } : {}) });
  }
  const scores: Scores = {};
  for (const o of options) for (const c of criteria) {
    const raw = str(form, `s__${o.key}__${c.key}`), basis = str(form, `b__${o.key}__${c.key}`);
    const prev = old.scores[o.key]?.[c.key];
    if (!raw && !basis) continue;
    let value: number | boolean | null = null;
    if (c.kind === "must") value = /^(y|yes|true|1)$/i.test(raw) ? true : /^(n|no|false|0)$/i.test(raw) ? false : null;
    else if (raw) {
      const n = Number(raw.replace(/[, ]/g, ""));
      if (!Number.isFinite(n)) problems.push(`${o.name}, ${c.label}: "${raw}" is not a number`);
      else if (c.kind === "rating" && (n < 1 || n > 5)) problems.push(`${o.name}, ${c.label}: ratings are 1–5`);
      else value = n;
    }
    // A value the catalog filled stays marked as such while it is unchanged.
    const fromCatalog = prev?.source === "catalog" && prev.value === value && (prev.basis ?? "") === basis;
    (scores[o.key] ??= {})[c.key] = { value, basis, source: fromCatalog ? "catalog" : "manual",
                                       ...(fromCatalog && prev?.observed_at ? { observed_at: prev.observed_at } : {}) };
  }
  if (new Set(criteria.map((c) => c.key)).size !== criteria.length) problems.push("two criteria have the same key; rename one");
  if (new Set(options.map((o) => o.key)).size !== options.length) problems.push("two options have the same key; rename one");
  return { criteria, options, scores, problems };
}

async function load(projectId: string, studyId: string) {
  const { supabase } = await requireUser();
  const { data } = await supabase.from("trade_studies").select("*").eq("id", studyId).eq("project_id", projectId).single();
  if (!data) fail(base(projectId), "Study not found.");
  return { supabase, study: data as Study };
}

export async function saveStudy(projectId: string, studyId: string, form: FormData) {
  const path = base(projectId, studyId);
  const { supabase, study } = await load(projectId, studyId);
  const { criteria, options, scores, problems } = readForm(form, study);
  if (problems.length) fail(path, problems.join("; "));
  const result = criteria.length && options.length ? rankOptions(criteria, options, scores) : null;
  const { error } = await supabase.rpc("save_trade_study", {
    p_id: studyId, p_question: str(form, "question"), p_context: str(form, "context"),
    p_requirement_refs: str(form, "requirement_refs").split(/[,\s]+/).filter(Boolean), p_criteria: criteria, p_options: options,
    p_scores: scores, p_result: result,
  });
  if (error) fail(path, error);
  revalidatePath(path);
  redirect(`${path}?notice=${encodeURIComponent("Saved and ranked.")}`);
}

/** Fills unit cost, stock and lifecycle for options with a part number, from the parts catalog's latest offers. */
export async function fillFromCatalog(projectId: string, studyId: string) {
  const path = base(projectId, studyId);
  const { supabase, study } = await load(projectId, studyId);
  if (study.status !== "draft") fail(path, "The study is no longer a draft.");
  const keys = new Set(study.criteria.map((c) => c.key));
  const { data: intake } = await supabase.from("project_intake").select("quantity").eq("project_id", projectId).maybeSingle();
  const qty = intake?.quantity ?? 1000;
  const scores: Scores = structuredClone(study.scores);
  const filled: string[] = [], missing: string[] = [];
  for (const o of study.options.filter((x) => x.mpn)) {
    const { data: parts } = await supabase.from("parts").select("id, mpn, manufacturer, lifecycle").eq("normalized_mpn", normalizeMpn(o.mpn!)).limit(5);
    const part = parts?.find((p) => !o.manufacturer || p.manufacturer.toLowerCase().includes(o.manufacturer.toLowerCase())) ?? parts?.[0];
    if (!part) { missing.push(o.name); continue; }
    const { data: rows } = await supabase.from("offers").select("*").eq("part_id", part.id).order("observed_at", { ascending: false }).limit(50);
    const latest = new Map<string, NonNullable<typeof rows>[number]>();
    for (const r of rows ?? []) { const k = `${r.provider}|${r.seller}|${r.sku}`; if (!latest.has(k)) latest.set(k, r); }
    const offers: Offer[] = [...latest.values()].map((r) => ({ provider: r.provider, seller: r.seller, sku: r.sku, stock: r.stock, moq: r.moq,
      multiple: r.multiple, packaging: r.packaging, currency: r.currency ?? "USD", prices: (r.prices ?? []).map((p: { quantity: number; unit_price?: number; unitPrice?: number }) =>
        ({ quantity: p.quantity, unitPrice: Number(p.unitPrice ?? p.unit_price) })), url: r.url, observedAt: r.observed_at, status: r.data_status }));
    const fixture = offers.some((x) => x.status === "fixture") ? " (fixture data, not real)" : "";
    const when = offers.map((x) => x.observedAt).sort().pop()?.slice(0, 10) ?? "";
    const s = (scores[o.key] ??= {});
    if (keys.has("unit_cost")) {
      const p = pricing(offers, 1, [qty], "USD")[0]?.choice;
      if (p) s.unit_cost = { value: p.unitPrice, source: "catalog", observed_at: when, basis: `${p.seller} via ${p.provider}, ${qty} pcs, ${when}${fixture}` };
    }
    if (keys.has("availability")) {
      const stock = [...new Map(offers.map((x) => [x.seller, x.stock ?? 0])).values()].reduce((a, b) => a + b, 0);
      s.availability = { value: stock, source: "catalog", observed_at: when, basis: `stock across ${new Set(offers.map((x) => x.seller)).size} seller(s), ${when}${fixture}` };
    }
    if (keys.has("lifecycle")) {
      s.lifecycle = { value: LIFECYCLE_RATING[part.lifecycle] ?? 3, source: "catalog", observed_at: when, basis: `catalog lifecycle: ${part.lifecycle}` };
    }
    filled.push(o.name);
  }
  const result = study.criteria.length && study.options.length ? rankOptions(study.criteria, study.options, scores) : null;
  const { error } = await supabase.rpc("save_trade_study", {
    p_id: studyId, p_question: study.question, p_context: study.context ?? "", p_requirement_refs: study.requirement_refs,
    p_criteria: study.criteria, p_options: study.options, p_scores: scores, p_result: result,
  });
  if (error) fail(path, error);
  revalidatePath(path);
  redirect(`${path}?notice=${encodeURIComponent((filled.length ? `Filled from the parts catalog: ${filled.join(", ")}.` : "Nothing filled.") +
    (missing.length ? ` Not in the catalog yet (run sourcing to look them up): ${missing.join(", ")}.` : "") +
    (!study.options.some((x) => x.mpn) ? " Give options a part number to fill them." : ""))}`);
}

export async function decideStudy(projectId: string, studyId: string, form: FormData) {
  const path = base(projectId, studyId);
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("decide_trade_study", { p_id: studyId, p_option: str(form, "option"), p_rationale: str(form, "rationale") });
  if (error) fail(path, error);
  revalidatePath(path);
  redirect(`${path}?notice=${encodeURIComponent("Decided: recorded as a project decision.")}`);
}

export async function withdrawStudy(projectId: string, studyId: string, form: FormData) {
  const path = base(projectId, studyId);
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("withdraw_trade_study", { p_id: studyId, p_note: str(form, "note") });
  if (error) fail(path, error);
  revalidatePath(path);
  redirect(`${path}?notice=${encodeURIComponent("Withdrawn.")}`);
}
