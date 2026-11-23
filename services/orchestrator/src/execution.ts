/**
 * One execution of one task: lease renewal, resumable steps, and the final outcome.
 *
 * Steps are memoized in the execution's checkpoint. A worker that resumes an interrupted
 * attempt replays the checkpoint and skips completed steps, so finished work (and the AI
 * spend behind it) is not repeated. Losing the lease stops the execution at the next step
 * boundary without writing anything.
 */
import { createHash } from "node:crypto";
import type { LanguageModel, Usage } from "@vx/planning";
import { LeaseLostError, type Checkpoint, type ExecutionRow, type RunRow, type TaskRow, type Validation, type WorkerDb } from "./db.ts";
import { ClaudeModel, DIGEST_MODEL, describeLook, digestTask, type TaskDigest } from "@vx/planning";
import { usageCost } from "./pricing.ts";

export class YieldRequested extends Error {}
/** A task spent its own cost cap in this run: it fails (not retried) so a person decides, instead of spending on. */
export class TaskCostCapError extends Error {}

/**
 * Default AI spend cap per task per run (USD), by discipline, at Opus prices; a task's cost_budget_usd overrides it.
 * Generous for a normal task (a plan build is ~$2.60, a circuit with repairs a few dollars) and a stop for a runaway.
 */
export const TASK_COST_CAP: Record<string, number> = {
  schematic: 15, pcb_layout: 20, enclosure: 12, simulation: 6, verification: 8, power: 6,
  architecture: 4, components: 4, thermal: 4, mechanical: 4, documentation: 4, sourcing: 2, manufacturing: 2,
};
export const taskCostCap = (t: { discipline: string; cost_budget_usd?: number | null }) =>
  t.cost_budget_usd != null ? Number(t.cost_budget_usd) : TASK_COST_CAP[t.discipline] ?? 5;

export interface StoredFile {
  versionId: string;
  storagePath: string;
  sha256: string;
}

export interface ExecutorContext {
  exec: ExecutionRow;
  task: TaskRow;
  run: RunRow;
  db: WorkerDb;
  model: LanguageModel;
  modelLabel: string;
  offline: boolean;
  /** Run fn once per attempt; on resume, the checkpointed result is returned instead. */
  step<T>(name: string, fn: () => Promise<T>): Promise<T>;
  log(message: string, data?: Record<string, unknown>, level?: "debug" | "info" | "warn" | "error"): Promise<void>;
  /** Charge model usage to the run. Throws YieldRequested if the budget is now exhausted. */
  chargeModelUsage(usage: Usage[], purpose: string): Promise<void>;
  /** Lock the artifact, upload the file (content-addressed) and register a scratch version. */
  storeArtifact(args: { name: string; kind: string; filename: string; content: string | Uint8Array; contentType: string;
                        toolName: string; toolVersion: string; toolConfig?: Record<string, unknown>; summary?: string }): Promise<StoredFile>;
}

export type ExecutorResult =
  | { status: "passed"; validations: Validation[]; summary: string; reviewReason: string | null }
  | { status: "failed"; error: string; retryable: boolean; validations?: Validation[] }
  | { status: "blocked"; reason: string };

export interface Executor {
  id: string;
  version: string;
  /** Short description shown in logs and reports. */
  describe: string;
  /** Disciplines this executor handles; a worker claims only tasks its executors can run. */
  disciplines: string[];
  canRun(task: TaskRow): boolean;
  run(ctx: ExecutorContext): Promise<ExecutorResult>;
}

export interface ExecutionOptions {
  workerId: string;
  stepDelayMs: number;
  computeUsdPerHour: number;
}

export class ExecutionHandle {
  readonly exec: ExecutionRow;
  private readonly db: WorkerDb;
  private readonly opts: ExecutionOptions;
  private checkpoint: Checkpoint;
  private directive: "continue" | "yield" | "lost" = "continue";
  private yieldReason = "";
  private timer: NodeJS.Timeout | null = null;
  private failedBeats = 0;
  private readonly startedAt = Date.now();

  constructor(db: WorkerDb, exec: ExecutionRow, opts: ExecutionOptions) {
    this.db = db;
    this.exec = exec;
    this.opts = opts;
    this.checkpoint = exec.checkpoint?.steps ? exec.checkpoint : { steps: {} };
  }

  get resumed(): boolean {
    return this.exec.resumed_from_id !== null;
  }

  start(): void {
    const every = Math.max(1000, (this.exec.lease_seconds * 1000) / 3);
    this.timer = setInterval(() => void this.beat(), every);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Ask the execution to stop at its next step boundary (shutdown, pause). */
  requestYield(reason: string): void {
    if (this.directive === "continue") {
      this.directive = "yield";
      this.yieldReason = reason;
    }
  }

  private async beat(checkpoint?: Checkpoint): Promise<void> {
    try {
      const d = await this.db.heartbeat(this.exec.id, this.opts.workerId, checkpoint);
      this.failedBeats = 0;
      if (d === "lost") this.directive = "lost";
      else if (d === "yield") this.requestYield("run paused, stopped or canceled");
    } catch (e) {
      // Transient network errors: keep trying until the lease would have expired anyway.
      this.failedBeats += 1;
      const every = Math.max(1000, (this.exec.lease_seconds * 1000) / 3);
      if (this.failedBeats * every >= this.exec.lease_seconds * 1000) this.directive = "lost";
      console.error(`[${this.opts.workerId}] heartbeat failed (${this.failedBeats}): ${(e as Error).message}`);
      if (checkpoint) throw e;
    }
  }

  assertActive(): void {
    if (this.directive === "lost") throw new LeaseLostError(`lease on execution ${this.exec.id} was lost`);
    if (this.directive === "yield") throw new YieldRequested(this.yieldReason);
  }

  async step<T>(name: string, fn: () => Promise<T>): Promise<T> {
    this.assertActive();
    if (Object.hasOwn(this.checkpoint.steps, name)) {
      await this.log(`step ${name}: reused from checkpoint`, { step: name, resumed: true });
      return this.checkpoint.steps[name] as T;
    }
    // Confirm the lease before doing (possibly expensive) work: a worker that was frozen
    // past its lease must not spend AI budget on a task someone else now owns.
    await this.beat();
    this.assertActive();
    await this.log(`step ${name}: started`, { step: name });
    const result = await fn();
    if (this.directive === "lost") throw new LeaseLostError(`lease lost during step ${name}`);
    this.checkpoint = { steps: { ...this.checkpoint.steps, [name]: result ?? null } };
    await this.beat(this.checkpoint);
    await this.log(`step ${name}: done`, { step: name });
    if (this.opts.stepDelayMs > 0) await new Promise((r) => setTimeout(r, this.opts.stepDelayMs));
    this.assertActive();
    return result;
  }

  async log(message: string, data: Record<string, unknown> = {}, level: "debug" | "info" | "warn" | "error" = "info"): Promise<void> {
    console.log(`[${this.opts.workerId}] ${this.exec.id.slice(0, 8)} ${message}`);
    await this.db.log(this.exec.project_id, this.exec.id, level, message, { ...data, worker_id: this.opts.workerId });
  }

  async chargeModelUsage(usage: Usage[], purpose: string): Promise<void> {
    let over = false;
    for (const u of usage) {
      const cost = usageCost(u);
      await this.log(`model call (${purpose}): ${u.model}, ${u.inputTokens} in / ${u.outputTokens} out, $${cost.toFixed(4)}`,
                     { purpose, ...u, cost_usd: cost });
      if ((await this.db.recordAiCall(null, this.exec.id, { purpose, usage: u, costUsd: cost, durationMs: null, failed: false })) === "over_budget") over = true;
    }
    if (over) this.requestYield("AI budget reached");
    if (this.costCap != null) {
      const spent = await this.db.taskRunSpend(this.exec.task_id, this.exec.run_id);
      if (spent >= this.costCap) {
        throw new TaskCostCapError(`This task's AI cost cap was reached: $${spent.toFixed(2)} of $${this.costCap.toFixed(2)} in this run. ` +
          "It stopped instead of spending more; read its log, then continue the run (or raise the task's cap) to try again.");
      }
    }
  }

  /** Per-task spend cap for this run (USD), checked after every charge. */
  costCap: number | null = null;
  /** Text outputs stored in this attempt (for the plain-language digest). */
  textOutputs: { name: string; text: string }[] = [];

  async storeArtifact(args: Parameters<ExecutorContext["storeArtifact"]>[0]): Promise<StoredFile> {
    this.assertActive();
    const artifactId = await this.db.acquireLock(this.exec.id, this.opts.workerId, args.name, args.kind);
    if (!artifactId) throw new YieldRequested(`artifact ${args.name} is locked by another execution`);
    const bytes = typeof args.content === "string" ? new TextEncoder().encode(args.content) : args.content;
    if (/^text\/(markdown|plain)/.test(args.contentType) && this.textOutputs.length < 6) {
      this.textOutputs.push({ name: args.name, text: new TextDecoder().decode(bytes.slice(0, 20000)) });
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const storagePath = `${this.exec.project_id}/artifacts/${args.name}/${sha256.slice(0, 16)}-${args.filename}`;
    await this.db.upload(storagePath, bytes, args.contentType);
    const versionId = await this.db.addScratchVersion({
      executionId: this.exec.id, workerId: this.opts.workerId, artifactId, storagePath, sha256, sizeBytes: bytes.byteLength,
      contentType: args.contentType, toolName: args.toolName, toolVersion: args.toolVersion,
      toolConfig: args.toolConfig, summary: args.summary,
    });
    await this.log(`stored ${args.name} as scratch version`, { artifact: args.name, version_id: versionId, sha256 });
    return { versionId, storagePath, sha256 };
  }

  /** Compute time for this execution, charged at the configured hourly rate. */
  async chargeCompute(): Promise<void> {
    const seconds = (Date.now() - this.startedAt) / 1000;
    const cost = (seconds / 3600) * this.opts.computeUsdPerHour;
    try {
      await this.db.updateExecution(this.exec.id, { compute_seconds: seconds.toFixed(3) });
      await this.db.recordCost(this.exec.id, "compute", "worker", this.opts.workerId, seconds, "seconds", cost);
    } catch (e) {
      console.error(`[${this.opts.workerId}] could not record compute: ${(e as Error).message}`);
    }
  }
}

export interface RunExecutionDeps {
  db: WorkerDb;
  executors: Executor[];
  model: LanguageModel;
  modelLabel: string;
  offline: boolean;
  opts: ExecutionOptions;
  /** Called with the live handle so the worker can ask it to yield on shutdown. */
  onStart?(handle: ExecutionHandle): void;
}

/** Run one claimed execution to an outcome. Never throws. Returns how it ended. */
export async function runExecution(exec: ExecutionRow, deps: RunExecutionDeps): Promise<string> {
  const { db, opts } = deps;
  const handle = new ExecutionHandle(db, exec, opts);
  deps.onStart?.(handle);
  handle.start();
  try {
    const [task, run] = await Promise.all([db.task(exec.task_id), db.run(exec.run_id)]);
    await handle.log(handle.resumed
      ? `resuming attempt ${exec.attempt} of ${task.key} from checkpoint ${exec.checkpoint_seq}`
      : `starting attempt ${exec.attempt} of ${task.key}`, { task_key: task.key, attempt: exec.attempt });

    const executor = deps.executors.find((e) => e.canRun(task));
    if (!executor) {
      const reason = `No executor for ${task.discipline} tasks yet.`;
      await handle.log(reason, {}, "warn");
      return await db.fail(exec.id, opts.workerId, reason, "block");
    }
    await db.updateExecution(exec.id, { tool_versions: { executor: executor.id, executor_version: executor.version } });
    handle.costCap = taskCostCap(task);

    // The product's look in words, written once per design freeze from its image, so every step can keep to it.
    try {
      await handle.step("look", async () => {
        const freeze = await db.currentFreeze(task.project_id);
        if (!freeze?.image_path || await db.lookDescription(freeze.id)) return null;
        const project = await db.project(task.project_id);
        const model = deps.offline ? deps.model : new ClaudeModel({ model: DIGEST_MODEL, effort: "low", maxTokens: 4000 });
        const r = await describeLook({ project: project.name, name: freeze.name, note: freeze.note, cmf: freeze.cmf,
          image: { bytes: await db.downloadBytes(freeze.image_path), mime: freeze.mime_type ?? "image/png" } }, model);
        await handle.chargeModelUsage([r.usage], "design_look");
        await db.saveLook(freeze.id, task.project_id, r.look.description.slice(0, 4000), r.usage.model);
        return null;
      });
    } catch (e) {
      if (e instanceof TaskCostCapError || e instanceof YieldRequested || e instanceof LeaseLostError) throw e;
      await handle.log(`could not describe the design's look: ${(e as Error).message}`, {}, "warn");
    }

    const ctx: ExecutorContext = {
      exec, task, run, db, model: deps.model, modelLabel: deps.modelLabel, offline: deps.offline,
      step: (name, fn) => handle.step(name, fn),
      log: (m, d, l) => handle.log(m, d, l),
      chargeModelUsage: (u, p) => handle.chargeModelUsage(u, p),
      storeArtifact: (a) => handle.storeArtifact(a),
    };
    const result = await executor.run(ctx);
    handle.assertActive();

    if (result.status === "blocked") {
      await handle.log(`blocked: ${result.reason}`, {}, "warn");
      return await db.fail(exec.id, opts.workerId, result.reason, "block");
    }
    if (result.status === "failed") {
      await handle.log(`failed: ${result.error}`, {}, "error");
      return await db.fail(exec.id, opts.workerId, result.error, result.retryable ? "retry" : "fail", result.validations);
    }
    // The everyday-language digest (and any owner questions): written before completion so the approval shows it.
    // A digest that fails never fails the work.
    let digest: TaskDigest | null = null;
    try {
      digest = await handle.step("digest", async () => {
        const [project, answered] = await Promise.all([db.project(task.project_id), db.answeredQuestions(task.project_id)]);
        const model = deps.offline ? deps.model : new ClaudeModel({ model: DIGEST_MODEL, effort: "low", maxTokens: 4000 });
        const r = await digestTask({ project: project.name, task: { title: task.title, discipline: task.discipline, description: task.description },
          summary: result.summary, checks: result.validations.map((v) => ({ kind: v.kind, result: v.result, summary: v.summary })),
          outputs: handle.textOutputs, answered }, model);
        await handle.chargeModelUsage([r.usage], "task_digest");
        return r.digest;
      });
    } catch (e) {
      if (e instanceof TaskCostCapError || e instanceof YieldRequested || e instanceof LeaseLostError) throw e;
      await handle.log(`plain-language summary skipped: ${(e as Error).message}`, {}, "warn");
    }
    await db.beginValidation(exec.id, opts.workerId);
    const status = await db.complete(exec.id, opts.workerId, result.validations, result.summary, result.reviewReason);
    if (digest) {
      try { await db.saveDigest(exec.id, task.project_id, task.id, digest); }
      catch (e) { await handle.log(`could not save the plain-language summary: ${(e as Error).message}`, {}, "warn"); }
    }
    await handle.log(`finished: task is ${status}`, { task_status: status });
    return status;
  } catch (e) {
    if (e instanceof LeaseLostError) {
      // Another worker owns this task now. Write nothing: the database would refuse it anyway.
      console.warn(`[${opts.workerId}] ${exec.id.slice(0, 8)} lease lost; abandoning without writing (${e.message})`);
      await db.log(exec.project_id, exec.id, "warn", "lease lost: this worker stopped without committing", { worker_id: opts.workerId });
      return "lease_lost";
    }
    if (e instanceof TaskCostCapError) {
      await handle.log(e.message, {}, "error");
      try { return await db.fail(exec.id, opts.workerId, e.message, "fail"); }
      catch (f) { if (f instanceof LeaseLostError) return "lease_lost"; throw f; }
    }
    if (e instanceof YieldRequested) {
      try {
        await db.yieldExecution(exec.id, opts.workerId, e.message);
        await handle.log(`yielded at checkpoint: ${e.message}`);
        return "yielded";
      } catch (y) {
        if (y instanceof LeaseLostError) return "lease_lost";
        throw y;
      }
    }
    const message = (e as Error).message ?? String(e);
    await handle.log(`error: ${message}`, { stack: (e as Error).stack }, "error");
    try {
      return await db.fail(exec.id, opts.workerId, message, "retry");
    } catch (f) {
      if (f instanceof LeaseLostError) return "lease_lost";
      console.error(`[${opts.workerId}] could not record failure: ${(f as Error).message}`);
      return "error";
    }
  } finally {
    handle.stop();
    await handle.chargeCompute();
  }
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
