/**
 * The worker's view of the database. Every state change goes through a Postgres function
 * that checks the worker still holds the execution (see supabase/migrations/*_g2_worker.sql).
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { HeartbeatDirective } from "@vx/contracts";

export class LeaseLostError extends Error {}

export interface ExecutionRow {
  id: string;
  project_id: string;
  task_id: string;
  run_id: string;
  attempt: number;
  status: string;
  worker_id: string;
  checkpoint: Checkpoint | null;
  checkpoint_seq: number;
  resumed_from_id: string | null;
  lease_seconds: number;
  started_at: string;
}

export interface Checkpoint {
  /** Results of completed steps, keyed by step name. A resumed execution skips these steps. */
  steps: Record<string, unknown>;
}

export interface RunRow {
  id: string;
  project_id: string;
  plan_id: string;
  name: string | null;
  mode: "guided" | "professional" | "autonomous";
  status: string;
  stop_reason: string | null;
  report: unknown;
  max_ai_spend_usd: number;
  max_compute_spend_usd: number;
  max_retries_per_task: number;
  allowed_risk_levels: string[];
  authorized_task_ids: string[] | null;
  created_at: string;
  started_at: string | null;
}

export interface TaskRow {
  id: string;
  project_id: string;
  plan_id: string;
  key: string;
  title: string;
  discipline: string;
  description: string | null;
  required_tools: string[];
  acceptance_tests: { id: string; description: string; method: string; validationKind?: string }[];
  approval_policy: { required?: boolean; reason?: string | null };
  risk_level: string;
  status: string;
  attempts: number;
  blocker_reason: string | null;
  position: number;
}

export interface Validation {
  kind: string;
  result: "pass" | "warning" | "fail" | "error";
  evidence_category: string;
  summary: string;
  details?: Record<string, unknown>;
  artifact_version_id?: string;
  tool_name?: string;
  tool_version?: string;
}

export interface RunProgress {
  claimable: number;
  in_flight: number;
  total: number;
  live_executions: number;
  by_status: Record<string, number>;
  claimable_disciplines: string[];
}

export const BUCKET = "project-files";

export class WorkerDb {
  readonly client: SupabaseClient;

  constructor(url: string, serviceKey: string) {
    this.client = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  }

  private async rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = await this.client.rpc(fn, args);
    if (error) {
      if (error.hint === "lease_lost" || /no longer held by worker/.test(error.message)) throw new LeaseLostError(error.message);
      throw new Error(`${fn}: ${error.message}`);
    }
    return data as T;
  }

  async reapStale(): Promise<number> {
    return this.rpc<number>("reap_stale_executions", {});
  }

  async activeRuns(): Promise<RunRow[]> {
    const { data, error } = await this.client.from("runs").select("*").eq("status", "running").order("created_at");
    if (error) throw new Error(`active runs: ${error.message}`);
    return data as RunRow[];
  }

  /** Runs that have ended (or may be about to) but have no report yet. */
  async unreportedRuns(): Promise<RunRow[]> {
    const { data, error } = await this.client.from("runs").select("*").is("report", null)
      .in("status", ["running", "stopped", "canceled", "failed"]);
    if (error) throw new Error(`unreported runs: ${error.message}`);
    return data as RunRow[];
  }

  async claim(workerId: string, runId: string, leaseSeconds: number, disciplines: string[]): Promise<ExecutionRow | null> {
    const row = await this.rpc<ExecutionRow | null>("claim_next_task", {
      p_worker_id: workerId, p_run_id: runId, p_lease_seconds: leaseSeconds, p_disciplines: disciplines,
    });
    return row?.id ? row : null;  // PostgREST returns an all-null row for a null composite
  }

  async checkin(workerId: string, disciplines: string[], tools: Record<string, string>): Promise<void> {
    await this.rpc("worker_checkin", { p_worker_id: workerId, p_disciplines: disciplines, p_tools: tools });
  }

  async heartbeat(executionId: string, workerId: string, checkpoint?: Checkpoint): Promise<HeartbeatDirective> {
    return this.rpc<HeartbeatDirective>("heartbeat_execution", {
      p_execution_id: executionId, p_worker_id: workerId, p_checkpoint: checkpoint ?? null,
    });
  }

  async yieldExecution(executionId: string, workerId: string, reason: string): Promise<void> {
    await this.rpc("yield_execution", { p_execution_id: executionId, p_worker_id: workerId, p_reason: reason });
  }

  async acquireLock(executionId: string, workerId: string, name: string, kind: string): Promise<string | null> {
    return this.rpc<string | null>("acquire_artifact_lock", {
      p_execution_id: executionId, p_worker_id: workerId, p_name: name, p_kind: kind,
    });
  }

  async addScratchVersion(args: {
    executionId: string; workerId: string; artifactId: string; storagePath: string; sha256: string; sizeBytes: number;
    contentType: string; toolName: string; toolVersion: string; toolConfig?: Record<string, unknown>; summary?: string;
  }): Promise<string> {
    return this.rpc<string>("add_scratch_version", {
      p_execution_id: args.executionId, p_worker_id: args.workerId, p_artifact_id: args.artifactId,
      p_storage_path: args.storagePath, p_sha256: args.sha256, p_size_bytes: args.sizeBytes,
      p_content_type: args.contentType, p_tool_name: args.toolName, p_tool_version: args.toolVersion,
      p_tool_config: args.toolConfig ?? {}, p_summary: args.summary ?? null,
    });
  }

  async beginValidation(executionId: string, workerId: string): Promise<void> {
    await this.rpc("begin_validation", { p_execution_id: executionId, p_worker_id: workerId });
  }

  async complete(executionId: string, workerId: string, validations: Validation[], summary: string,
                 reviewReason: string | null): Promise<string> {
    return this.rpc<string>("complete_execution", {
      p_execution_id: executionId, p_worker_id: workerId, p_validations: validations,
      p_summary: summary, p_review_reason: reviewReason,
    });
  }

  async fail(executionId: string, workerId: string, error: string, outcome: "retry" | "fail" | "block",
             validations: Validation[] = []): Promise<string> {
    return this.rpc<string>("fail_execution", {
      p_execution_id: executionId, p_worker_id: workerId, p_error: error, p_outcome: outcome, p_validations: validations,
    });
  }

  async recordCost(executionId: string, kind: "ai_tokens" | "compute" | "api_call" | "other", provider: string,
                   resource: string, quantity: number, unit: string, costUsd: number): Promise<"ok" | "over_budget"> {
    return this.rpc("record_cost", {
      p_execution_id: executionId, p_kind: kind, p_provider: provider, p_resource: resource,
      p_quantity: quantity, p_unit: unit, p_cost_usd: costUsd,
    });
  }

  async progress(runId: string): Promise<RunProgress> {
    return this.rpc<RunProgress>("run_progress", { p_run_id: runId });
  }

  async finishRun(runId: string, status: "completed" | "stopped" | "failed", report: unknown, reason: string | null): Promise<void> {
    await this.rpc("finish_run", { p_run_id: runId, p_status: status, p_report: report, p_reason: reason });
  }

  /** Disciplines offered by workers that checked in within the last `withinMs`. */
  async onlineDisciplines(withinMs = 30_000): Promise<Set<string>> {
    const { data, error } = await this.client.from("workers").select("disciplines")
      .gte("last_seen_at", new Date(Date.now() - withinMs).toISOString());
    if (error) throw new Error(`workers: ${error.message}`);
    return new Set((data ?? []).flatMap((w) => w.disciplines as string[]));
  }

  async log(projectId: string, executionId: string, level: "debug" | "info" | "warn" | "error", message: string,
            data: Record<string, unknown> = {}): Promise<void> {
    const { error } = await this.client.from("execution_logs")
      .insert({ project_id: projectId, execution_id: executionId, level, message, data });
    if (error) console.error(`[log] ${error.message}`);
  }

  async updateExecution(executionId: string, fields: Record<string, unknown>): Promise<void> {
    const { error } = await this.client.from("executions").update(fields).eq("id", executionId);
    if (error) throw new Error(`update execution: ${error.message}`);
  }

  // --- Reads used to build executor context ---------------------------------

  async task(taskId: string): Promise<TaskRow> {
    const { data, error } = await this.client.from("tasks").select("*").eq("id", taskId).single();
    if (error) throw new Error(`task ${taskId}: ${error.message}`);
    return data as TaskRow;
  }

  async run(runId: string): Promise<RunRow> {
    const { data, error } = await this.client.from("runs").select("*").eq("id", runId).single();
    if (error) throw new Error(`run ${runId}: ${error.message}`);
    return data as RunRow;
  }

  async project(projectId: string): Promise<{ name: string; description: string | null }> {
    const { data, error } = await this.client.from("projects").select("name, description").eq("id", projectId).single();
    if (error) throw new Error(`project: ${error.message}`);
    return data;
  }

  async taskRequirements(taskId: string): Promise<{ ref_code: string; kind: string; priority: string; text: string }[]> {
    const { data, error } = await this.client.from("task_requirements")
      .select("requirements(ref_code, kind, priority, text)").eq("task_id", taskId);
    if (error) throw new Error(`task requirements: ${error.message}`);
    return (data ?? []).map((r) => r.requirements as unknown as { ref_code: string; kind: string; priority: string; text: string })
      .sort((a, b) => a.ref_code.localeCompare(b.ref_code));
  }

  /** Committed outputs of the task's direct upstream tasks, with text content where it is text. */
  async upstreamOutputs(taskId: string): Promise<{ taskKey: string; title: string; name: string; content: string | null }[]> {
    const { data: deps, error } = await this.client.from("task_dependencies")
      .select("upstream:tasks!task_dependencies_depends_on_task_id_fkey(id, key, title, position)").eq("task_id", taskId);
    if (error) throw new Error(`upstream tasks: ${error.message}`);
    const out = [];
    const ups = (deps ?? []).map((d) => d.upstream as unknown as { id: string; key: string; title: string; position: number })
      .sort((a, b) => a.position - b.position);
    for (const up of ups) {
      const { data: links, error: e2 } = await this.client.from("task_artifacts")
        .select("artifact_versions(storage_path, content_type, status, artifacts(name))")
        .eq("task_id", up.id).eq("role", "output");
      if (e2) throw new Error(`upstream outputs: ${e2.message}`);
      for (const l of links ?? []) {
        const v = l.artifact_versions as unknown as { storage_path: string; content_type: string | null; status: string; artifacts: { name: string } };
        if (v.status !== "committed") continue;
        out.push({ taskKey: up.key, title: up.title, name: v.artifacts.name,
                   content: v.content_type?.startsWith("text/") ? await this.downloadText(v.storage_path) : null });
      }
    }
    return out;
  }

  async reviewNotes(taskId: string): Promise<string[]> {
    const { data, error } = await this.client.from("approvals").select("response_note")
      .eq("task_id", taskId).eq("status", "rejected").order("responded_at");
    if (error) throw new Error(`review notes: ${error.message}`);
    return (data ?? []).map((a) => a.response_note).filter((n): n is string => !!n);
  }

  async upload(path: string, body: Uint8Array, contentType: string): Promise<void> {
    // Paths are content-addressed, so re-uploading after a resume writes identical bytes.
    const { error } = await this.client.storage.from(BUCKET).upload(path, body, { contentType, upsert: true });
    if (error) throw new Error(`upload ${path}: ${error.message}`);
  }

  async downloadText(path: string): Promise<string> {
    const { data, error } = await this.client.storage.from(BUCKET).download(path);
    if (error) throw new Error(`download ${path}: ${error.message}`);
    return data.text();
  }
}
