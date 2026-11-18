#!/usr/bin/env node
/**
 * VX Design worker. Long-running; not for Vercel.
 *
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... ANTHROPIC_API_KEY=... node services/orchestrator/src/main.ts
 *
 * Environment:
 *   WORKER_ID                 unique name (default: hostname-pid)
 *   WORKER_CONCURRENCY        executions at once (default 2)
 *   WORKER_LEASE_SECONDS      lease length; heartbeats every third of it (default 60)
 *   WORKER_POLL_MS            idle poll interval (default 3000)
 *   VX_LLM=offline            use the offline stand-in instead of Claude (labelled as such)
 *   VX_PLANNING_MODEL         Claude model id (default claude-opus-5-5)
 *   VX_COMPUTE_USD_PER_HOUR   charge for worker time against compute budgets (default 0.10)
 *   VX_STEP_DELAY_MS          pause after each step (tests use it to interrupt work mid-task)
 *   NEXAR_CLIENT_ID / NEXAR_CLIENT_SECRET      sourcing primary (Octopart data via Nexar)
 *   DIGIKEY_CLIENT_ID / DIGIKEY_CLIENT_SECRET  sourcing fallback A
 *   MOUSER_API_KEY                             sourcing fallback B
 *   VX_SOURCING=fixture       offline stand-in for the distributors (invented data, labelled); =off to disable
 *   GEMINI_API_KEY / OPENAI_API_KEY            concept images (Gemini "Nano Banana" preferred when both are set)
 *   VX_IMAGE_PROVIDER         gemini | openai;  VX_IMAGE_MODEL  override the provider's default model
 *   VX_IMAGES=fixture         offline placeholder images (labelled on the image); =off to disable
 */
import { hostname } from "node:os";
import { ClaudeModel, OfflineModel } from "@vx/planning";
import { imageProviderFromEnv, sourcingProvidersFromEnv } from "@vx/integrations";
import { WorkerDb } from "./db.ts";
import { detectEngineering } from "./engineering.ts";
import { executorsFor } from "./executors/index.ts";
import { Worker } from "./worker.ts";
import { processModelCheck } from "./models.ts";
import { processConceptRound } from "./concepts.ts";
import { processRfqPacket } from "./rfq.ts";

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`${name} is required`);
  return v;
}

const url = env("SUPABASE_URL");
const key = env("SUPABASE_SERVICE_ROLE_KEY");

let model;
if (process.env.VX_LLM === "offline") {
  model = { model: new OfflineModel(), label: "Offline heuristic (not AI)", offline: true };
} else if (process.env.ANTHROPIC_API_KEY) {
  model = { model: new ClaudeModel(), label: process.env.VX_PLANNING_MODEL ?? "claude-opus-5-5", offline: false };
} else {
  console.error("No model configured: set ANTHROPIC_API_KEY, or VX_LLM=offline for the offline stand-in.");
  process.exit(2);
}

const engineering = await detectEngineering();
console.log(engineering
  ? `engineering tools: vx_eng ${engineering.versions.vx_eng}, KiCad ${engineering.versions.kicad}`
  : "engineering tools not found: this worker will not take schematic tasks");

const sourcing = sourcingProvidersFromEnv();
const sourcingOn = sourcing.filter((p) => p.configured());
console.log(sourcingOn.length ? `sourcing providers: ${sourcingOn.map((p) => `${p.label} (${p.role})`).join(", ")}`
                              : "no sourcing provider configured: this worker will not take sourcing tasks");

const worker = new Worker(new WorkerDb(url, key), {
  workerId: env("WORKER_ID", `${hostname()}-${process.pid}`),
  concurrency: Number(env("WORKER_CONCURRENCY", "2")),
  leaseSeconds: Number(env("WORKER_LEASE_SECONDS", "60")),
  pollMs: Number(env("WORKER_POLL_MS", "3000")),
  stepDelayMs: Number(env("VX_STEP_DELAY_MS", "0")),
  computeUsdPerHour: Number(env("VX_COMPUTE_USD_PER_HOUR", "0.10")),
  uncoveredGraceMs: Number(env("VX_UNCOVERED_GRACE_MS", "30000")),
  tools: engineering ? { kicad: engineering.versions.kicad, vx_eng: engineering.versions.vx_eng } : {},
}, executorsFor(engineering, sourcing), model);
if (engineering) {
  const db3d = new WorkerDb(url, key);
  const id = env("WORKER_ID", `${hostname()}-${process.pid}`);
  worker.addJob("3D model check", () => processModelCheck(db3d, engineering, id));
}

// Concept images (M-CON): any worker with an image provider key (worker secret) takes concept rounds.
const images = imageProviderFromEnv();
if (images?.configured()) {
  const dbc = new WorkerDb(url, key);
  const id = env("WORKER_ID", `${hostname()}-${process.pid}`);
  console.log(`concept images: ${images.label} (${images.model})`);
  worker.addJob("concepts", () => processConceptRound(dbc, model, images, id));
} else {
  console.log("no image provider configured: this worker will not take concept rounds");
}

// RFQ packets (M-RFQ): no external service needed, so every worker takes them.
{
  const dbr = new WorkerDb(url, key);
  const id = env("WORKER_ID", `${hostname()}-${process.pid}`);
  worker.addJob("rfq packets", () => processRfqPacket(dbr, id));
}

let signals = 0;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (++signals > 1) process.exit(1);
    console.log(`${sig}: finishing current steps, then yielding work back to the queue`);
    worker.shutdown();
  });
}

await worker.run();
