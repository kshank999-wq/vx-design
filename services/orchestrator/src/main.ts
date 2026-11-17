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
 */
import { hostname } from "node:os";
import { ClaudeModel, OfflineModel } from "@vx/planning";
import { WorkerDb } from "./db.ts";
import { EXECUTORS } from "./executors/index.ts";
import { Worker } from "./worker.ts";

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

const worker = new Worker(new WorkerDb(url, key), {
  workerId: env("WORKER_ID", `${hostname()}-${process.pid}`),
  concurrency: Number(env("WORKER_CONCURRENCY", "2")),
  leaseSeconds: Number(env("WORKER_LEASE_SECONDS", "60")),
  pollMs: Number(env("WORKER_POLL_MS", "3000")),
  stepDelayMs: Number(env("VX_STEP_DELAY_MS", "0")),
  computeUsdPerHour: Number(env("VX_COMPUTE_USD_PER_HOUR", "0.10")),
}, EXECUTORS, model);

let signals = 0;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (++signals > 1) process.exit(1);
    console.log(`${sig}: finishing current steps, then yielding work back to the queue`);
    worker.shutdown();
  });
}

await worker.run();
