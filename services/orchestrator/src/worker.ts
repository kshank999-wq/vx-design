/**
 * Worker loop: reclaim stale work, claim tasks from active runs, execute them, and write
 * the completion report when a run has nothing left to do. Any number of workers can run
 * side by side; the database arbitrates (SKIP LOCKED claims, leases, fenced commits).
 */
import type { LanguageModel } from "@vx/planning";
import { WorkerDb, type ExecutionRow, type RunRow } from "./db.ts";
import { runExecution, type ExecutionHandle, type Executor } from "./execution.ts";
import { buildRunReport } from "./report.ts";

export interface WorkerConfig {
  workerId: string;
  concurrency: number;
  leaseSeconds: number;
  pollMs: number;
  stepDelayMs: number;
  computeUsdPerHour: number;
  /** How long remaining work must lack a capable online worker before the run ends (default 30 s). */
  uncoveredGraceMs?: number;
  /** Tool versions reported in the worker registry. */
  tools?: Record<string, string>;
}

export class Worker {
  private readonly db: WorkerDb;
  private readonly cfg: WorkerConfig;
  private readonly executors: Executor[];
  private readonly model: { model: LanguageModel; label: string; offline: boolean };
  private readonly inflight = new Map<string, { handle?: ExecutionHandle; done: Promise<string> }>();
  private stopping = false;
  private lastCheckin = 0;
  /** Runs whose remaining work no online worker can do, and since when. */
  private readonly uncoveredSince = new Map<string, number>();
  readonly disciplines: string[];
  private readonly tools: Record<string, string>;
  private wake: (() => void) | null = null;
  /** Background jobs outside runs (e.g. 3D model checks); at most one of each at a time. */
  private readonly jobs: { name: string; run: () => Promise<number>; busy: boolean }[] = [];

  constructor(db: WorkerDb, cfg: WorkerConfig, executors: Executor[], model: { model: LanguageModel; label: string; offline: boolean }) {
    this.db = db;
    this.cfg = cfg;
    this.executors = executors;
    this.model = model;
    this.disciplines = [...new Set(executors.flatMap((e) => e.disciplines))].sort();
    this.tools = { node: process.versions.node, model: model.label, ...(cfg.tools ?? {}) };
  }

  /** Registers a background job: run() handles one item and returns how many it handled. */
  addJob(name: string, run: () => Promise<number>): void {
    this.jobs.push({ name, run, busy: false });
  }

  private startJobs(): void {
    for (const job of this.jobs) {
      if (job.busy || this.stopping) continue;
      job.busy = true;
      job.run().then((n) => { if (n) this.wake?.(); })
        .catch((e) => console.error(`[${this.cfg.workerId}] ${job.name} failed: ${(e as Error).message}`))
        .finally(() => { job.busy = false; });
    }
  }

  /** Stop claiming; ask in-flight executions to yield at their next checkpoint. */
  shutdown(reason = "worker shutting down"): void {
    this.stopping = true;
    for (const { handle } of this.inflight.values()) handle?.requestYield(reason);
    this.wake?.();
  }

  async run(): Promise<void> {
    console.log(`[${this.cfg.workerId}] started: concurrency ${this.cfg.concurrency}, lease ${this.cfg.leaseSeconds}s, ` +
                `model ${this.model.label}, disciplines ${this.disciplines.join(", ")}`);
    while (!this.stopping) {
      try {
        await this.tick();
      } catch (e) {
        console.error(`[${this.cfg.workerId}] tick failed: ${(e as Error).message}`);
      }
      await new Promise<void>((r) => {
        const t = setTimeout(r, this.cfg.pollMs);
        this.wake = () => { clearTimeout(t); r(); };
      });
    }
    await Promise.allSettled([...this.inflight.values()].map((x) => x.done));
    console.log(`[${this.cfg.workerId}] stopped`);
  }

  async tick(): Promise<void> {
    if (Date.now() - this.lastCheckin > 10_000) {
      await this.db.checkin(this.cfg.workerId, this.disciplines, this.tools);
      this.lastCheckin = Date.now();
    }
    const reaped = await this.db.reapStale();
    if (reaped) console.log(`[${this.cfg.workerId}] reclaimed ${reaped} execution(s) from workers that stopped heartbeating`);

    // Fair queueing: each claim goes to the account (and then the run) with the fewest tasks running, within plan limits.
    while (!this.stopping && this.inflight.size < this.cfg.concurrency) {
      const exec = await this.db.claimFair(this.cfg.workerId, this.cfg.leaseSeconds, this.disciplines);
      if (!exec) break;
      this.launch(exec);
    }
    await this.finishIdleRuns();
    this.startJobs();
  }

  private launch(exec: ExecutionRow): void {
    const entry: { handle?: ExecutionHandle; done: Promise<string> } = { done: Promise.resolve("") };
    entry.done = runExecution(exec, {
      db: this.db, executors: this.executors, model: this.model.model, modelLabel: this.model.label,
      offline: this.model.offline,
      opts: { workerId: this.cfg.workerId, stepDelayMs: this.cfg.stepDelayMs, computeUsdPerHour: this.cfg.computeUsdPerHour },
      onStart: (h) => { entry.handle = h; if (this.stopping) h.requestYield("worker shutting down"); },
    }).finally(() => {
      this.inflight.delete(exec.id);
      this.wake?.();   // a finished task may unblock the next one
    });
    this.inflight.set(exec.id, entry);
  }

  /** Write the report for runs that have ended, or that have nothing left to run. */
  private async finishIdleRuns(): Promise<void> {
    for (const run of await this.db.unreportedRuns()) {
      const p = await this.db.progress(run.id);
      if (p.live_executions > 0) continue;
      let waitingFor: string[] = [];
      if (run.status === "running" && (p.claimable > 0 || p.in_flight > 0)) {
        // Claimable work that no online worker can execute (e.g. schematic without a KiCad worker):
        // after a grace period, end the run so its report is waiting instead of hanging forever.
        const online = await this.db.onlineDisciplines();
        waitingFor = p.in_flight === 0 ? p.claimable_disciplines.filter((d) => !online.has(d)) : [];
        if (!waitingFor.length || waitingFor.length < p.claimable_disciplines.length) { this.uncoveredSince.delete(run.id); continue; }
        const since = this.uncoveredSince.get(run.id) ?? Date.now();
        this.uncoveredSince.set(run.id, since);
        if (Date.now() - since < (this.cfg.uncoveredGraceMs ?? 30_000)) continue;
      }
      this.uncoveredSince.delete(run.id);
      const fresh: RunRow = await this.db.run(run.id);
      if (fresh.report || fresh.status === "paused") continue;
      const report = await buildRunReport(this.db, fresh, waitingFor);
      const status = report.final_status === "canceled" ? "stopped" : report.final_status;
      await this.db.finishRun(run.id, status, report, report.stop_reason);
      console.log(`[${this.cfg.workerId}] run ${run.id.slice(0, 8)} finished: ${report.headline}`);
    }
  }
}
