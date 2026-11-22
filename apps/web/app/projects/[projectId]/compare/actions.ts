"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { extractRequirements, usageCost, type ParsedDocument } from "@vx/planning";
import { fail, requireUser } from "@/lib/auth";
import { modelFor, READING_MODELS } from "@/lib/model";
import type { CompareReq } from "@/lib/model-compare";

const base = (projectId: string) => `/projects/${projectId}/compare`;

/**
 * Reads one specification with each chosen model, saving nothing as requirements: the results are kept for a
 * side-by-side comparison with the requirements already read from it. Every call is priced and recorded
 * ("Model comparison" on the AI usage page).
 */
export async function compareModels(projectId: string, form: FormData) {
  const { supabase, userId } = await requireUser();
  const documentId = String(form.get("document") ?? "");
  const models = form.getAll("model").map(String).filter((m) => READING_MODELS.some(([id]) => id === m));
  if (!documentId || !models.length) fail(base(projectId), "Choose a specification and at least one model.");
  const { data: doc } = await supabase.from("documents").select("id, title, parsed, extraction_report").eq("id", documentId).eq("project_id", projectId).single();
  if (!doc?.parsed) fail(base(projectId), "That specification has no parsed text.");
  const { data: saved } = await supabase.from("requirements").select("text, kind, priority, block_id, source_excerpt, notes")
    .eq("document_id", documentId).eq("origin", "extracted");
  const baseline: CompareReq[] = (saved ?? []).map((r) => ({ statement: r.text, kind: r.kind, priority: r.priority, blockId: r.block_id ?? "", excerpt: r.source_excerpt ?? "", ambiguity: r.notes }));
  const runs = await Promise.all(models.map(async (m) => {
    const t0 = Date.now();
    try {
      const choice = modelFor(projectId, m, "compare:");
      const r = await extractRequirements(doc!.parsed as ParsedDocument, choice.model);
      return [m, {
        requirements: r.requirements.map((x) => ({ statement: x.text, kind: x.kind, priority: x.priority, blockId: x.blockId, excerpt: x.excerpt, ambiguity: x.notes })),
        cost_usd: r.usage.reduce((n, u) => n + usageCost(u), 0), duration_ms: Date.now() - t0, offline: choice.offline,
        tokens: { input: r.usage.reduce((n, u) => n + u.inputTokens, 0), output: r.usage.reduce((n, u) => n + u.outputTokens, 0) },
        sources: r.sources ?? null, error: null,
      }] as const;
    } catch (e) {
      return [m, { requirements: [], cost_usd: 0, duration_ms: Date.now() - t0, error: (e as Error).message }] as const;
    }
  }));
  const report = (doc!.extraction_report ?? {}) as { model?: string; usage?: { model: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }[] };
  const { data: row, error } = await supabase.from("model_comparisons").insert({
    project_id: projectId, document_id: documentId, created_by: userId,
    results: { document: doc!.title, baseline: { model: report.model ?? "earlier reading", requirements: baseline,
               cost_usd: (report.usage ?? []).reduce((n, u) => n + usageCost(u), 0) }, models: Object.fromEntries(runs) },
  }).select("id").single();
  if (error) fail(base(projectId), error);
  revalidatePath(base(projectId));
  redirect(`${base(projectId)}/${row!.id}`);
}

/** The model this project reads specifications and part datasheets with from now on. */
export async function setReadingModel(projectId: string, form: FormData) {
  const { supabase } = await requireUser();
  const model = String(form.get("reading_model") ?? "");
  if (model && !READING_MODELS.some(([id]) => id === model)) fail(base(projectId), "Unknown model.");
  const { error } = await supabase.rpc("set_reading_model", { p_project: projectId, p_model: model });
  if (error) fail(base(projectId), error);
  revalidatePath(base(projectId));
  const label = READING_MODELS.find(([id]) => id === model)?.[1].split(" (")[0] ?? "the default model";
  redirect(`${base(projectId)}?notice=${encodeURIComponent(`Specifications and datasheets are now read with ${label}.`)}`);
}
