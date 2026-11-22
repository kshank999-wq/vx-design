/**
 * Concept job (M-CON): claims a requested round, has the model write the brief (variants with image prompts,
 * colour/material/finish, envelope), renders each variant with the image provider, stores the images in the
 * project's folder and records them with their provenance. A variant the provider refuses or fails on is recorded
 * as failed with the reason; the others still count.
 */
import { meteredFor } from "./metering.ts";
import { createHash } from "node:crypto";
import { generateConceptBrief, type LanguageModel } from "@vx/planning";
import { ImageProviderError, type GeneratedImage, type ImageProvider, type ReferenceImage } from "@vx/integrations";
import type { ConceptRoundRow, WorkerDb } from "./db.ts";

const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/svg+xml": "svg" };
const RASTER = new Set(["image/png", "image/jpeg", "image/webp"]);

async function withRetry(provider: ImageProvider, run: () => Promise<GeneratedImage>): Promise<GeneratedImage> {
  try {
    return await run();
  } catch (e) {
    if (!(e instanceof ImageProviderError) || !e.retryable) throw e;
    await new Promise((r) => setTimeout(r, provider.id === "fixture" ? 0 : 5000));
    return run();
  }
}

export async function processConceptRound(db: WorkerDb, model: { model: LanguageModel; label: string; offline: boolean },
                                          provider: ImageProvider, workerId: string): Promise<number> {
  const round = await db.claimConceptRound(workerId) as ConceptRoundRow | null;
  if (!round) return 0;
  const tag = `[${workerId}] concepts ${round.id.slice(0, 8)} (round ${round.round_no})`;
  try {
    const ctx = await db.conceptContext(round);
    const { brief, usage, promptVersion } = await generateConceptBrief({
      project: ctx.project, requirements: ctx.requirements, count: round.variant_count,
      direction: ctx.references.length
        ? `${round.direction}\n\nThe team's own mock-ups are given as reference images; follow what they show unless the direction says otherwise:\n` +
          ctx.references.map((r) => `- REF-${r.ref_no} ${r.title}${r.note ? `: ${r.note}` : ""}`).join("\n")
        : round.direction,
      parent: ctx.parent ? { name: ctx.parent.name, prompt: ctx.parent.prompt, cmf_summary: (ctx.parent.cmf.summary as string) ?? null } : null,
      freeze: ctx.freeze,
    }, meteredFor(db, model.model, round.project_id));
    void usage;

    // The chosen variant goes to the provider as the reference image. Providers take raster images only, so an
    // offline placeholder (SVG) cannot be a reference for a real provider; the refinement then works from its prompt.
    const references: ReferenceImage[] = [];
    let referenceNote: string | null = null;
    if (ctx.parent) {
      if (RASTER.has(ctx.parent.mime_type) || provider.id === "fixture") {
        references.push({ mimeType: ctx.parent.mime_type, data: await db.downloadBytes(ctx.parent.image_path),
                          label: `"${ctx.parent.name}" (round ${ctx.parent.round_no})` });
      } else {
        referenceNote = `the refined variant is a ${ctx.parent.mime_type} placeholder, which ${provider.label} cannot take as a reference; refined from its description only`;
      }
    }

    // The project's mock-ups chosen for this round (raster images; checked when the round was requested).
    for (const r of ctx.references) {
      if (RASTER.has(r.mime_type) || provider.id === "fixture") {
        references.push({ mimeType: r.mime_type, data: await db.downloadBytes(r.storage_path), label: `REF-${r.ref_no} ${r.title}` });
      }
    }

    const variants: Record<string, unknown>[] = [];
    for (const [i, v] of brief.variants.entries()) {
      const base = { ordinal: i + 1, name: v.name, rationale: v.rationale, prompt: v.prompt,
                     cmf: { ...v.cmf, design_language: v.design_language }, provider: provider.id, model: provider.model };
      try {
        const img = await withRetry(provider, () => provider.generate({ prompt: v.prompt, references, aspectRatio: "4:3" }));
        const sha = createHash("sha256").update(img.data).digest("hex");
        const path = `${round.project_id}/concepts/${round.id}/${i + 1}-${sha.slice(0, 16)}.${EXT[img.mimeType] ?? "bin"}`;
        await db.upload(path, img.data, img.mimeType);
        await db.recordProjectCost(round.project_id, "api_call", provider.id, img.model, 1, "images");
        variants.push({ ...base, status: "ready", image_path: path, mime_type: img.mimeType, sha256: sha, model: img.model, seed: img.seed,
                        revised_prompt: img.revisedPrompt,
                        provider_meta: { ...img.meta, references: references.map((r) => r.label), reference_note: referenceNote,
                                         terms: provider.terms, brief_prompt_version: promptVersion, brief_model: model.label } });
      } catch (e) {
        const reason = e instanceof ImageProviderError && e.kind === "refused"
          ? `declined by the provider's safety system: ${e.message}` : (e as Error).message;
        variants.push({ ...base, status: "failed", error: reason.slice(0, 500) });
        console.error(`${tag} variant ${i + 1} failed: ${reason}`);
      }
    }
    const status = await db.completeConceptRound(round.id, workerId, { ...brief, prompt_version: promptVersion, offline: model.offline },
                                                 model.label, provider.id, provider.model, variants,
                                                 variants.some((v) => v.status === "failed") ? "some variants could not be generated" : null);
    console.log(`${tag}: ${status} (${variants.filter((v) => v.status === "ready").length}/${variants.length} images, ${provider.id})`);
  } catch (e) {
    const msg = (e as Error).message;
    if (/lease_lost|not being generated/.test(msg)) { console.error(`${tag}: lost the round (${msg})`); return 1; }
    console.error(`${tag} failed: ${msg}`);
    await db.completeConceptRound(round.id, workerId, {}, model.label, provider.id, provider.model, [], msg.slice(0, 500))
      .catch((e2) => console.error(`${tag}: could not record the failure: ${(e2 as Error).message}`));
  }
  return 1;
}
