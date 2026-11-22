/** AI calls made by worker jobs outside a run (plans, Flux history, the earlier-work register, concept briefs), recorded under their project. */
import { MeteredModel, type LanguageModel } from "@vx/planning";
import type { WorkerDb } from "./db.ts";

export function meteredFor(db: WorkerDb, model: LanguageModel, projectId: string): LanguageModel {
  return new MeteredModel(model, async (e) => { await db.recordAiCall(projectId, null, e); });
}
