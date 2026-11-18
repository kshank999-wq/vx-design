/**
 * The worker's view of the database. Every state change goes through a Postgres function
 * that checks the worker still holds the execution (see supabase/migrations/*_g2_worker.sql).
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { HeartbeatDirective, ManufacturingCategory } from "@vx/contracts";

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

  /**
   * Nearest committed output named `<task>/<suffix>` among the task's upstream tasks (direct first, then
   * their upstream, breadth-first). `disciplines` limits which upstream tasks count.
   */
  async upstreamVersion(taskId: string, suffix: string, disciplines?: string[]):
      Promise<{ taskKey: string; versionId: string; storagePath: string; toolConfig: Record<string, unknown> | null } | null> {
    const seen = new Set<string>([taskId]);
    let frontier = [taskId];
    while (frontier.length) {
      const { data: deps, error } = await this.client.from("task_dependencies")
        .select("upstream:tasks!task_dependencies_depends_on_task_id_fkey(id, key, discipline, position)").in("task_id", frontier);
      if (error) throw new Error(`upstream tasks: ${error.message}`);
      const ups = (deps ?? []).map((d) => d.upstream as unknown as { id: string; key: string; discipline: string; position: number })
        .filter((u) => !seen.has(u.id)).sort((a, b) => b.position - a.position);
      for (const up of ups) {
        seen.add(up.id);
        if (disciplines && !disciplines.includes(up.discipline)) continue;
        const { data: links, error: e2 } = await this.client.from("task_artifacts")
          .select("artifact_versions(id, storage_path, status, tool_config, artifacts(name))").eq("task_id", up.id).eq("role", "output");
        if (e2) throw new Error(`upstream outputs: ${e2.message}`);
        for (const l of links ?? []) {
          const v = l.artifact_versions as unknown as { id: string; storage_path: string; status: string;
                                                         tool_config: Record<string, unknown> | null; artifacts: { name: string } };
          if (v.status === "committed" && v.artifacts.name.endsWith(`/${suffix}`)) {
            return { taskKey: up.key, versionId: v.id, storagePath: v.storage_path, toolConfig: v.tool_config };
          }
        }
      }
      frontier = ups.map((u) => u.id);
    }
    return null;
  }

  /** Committed JSON output of an upstream task whose artifact name ends with `/${suffix}` (e.g. the schematic's design). */
  async upstreamJson(taskId: string, suffix: string): Promise<{ taskKey: string; versionId: string; value: unknown } | null> {
    const v = await this.upstreamVersion(taskId, suffix);
    return v ? { taskKey: v.taskKey, versionId: v.versionId, value: JSON.parse(await this.downloadText(v.storagePath)) } : null;
  }

  /** Adds a live part and its offers to the shared catalog. */
  async recordPart(part: Record<string, unknown>, offers: Record<string, unknown>[]): Promise<string> {
    return this.rpc<string>("record_part", { p_part: part, p_offers: offers });
  }

  /** Registers a 3D model candidate as the worker (service role). Returns the model id. */
  async registerPartModel(a: { projectId: string; mpn: string; manufacturer: string; normalizedMpn: string; normalizedMfr: string;
                               footprint: string; sourceKind: "upload" | "url" | "nexar"; source: string; sourceUrl: string | null;
                               license: string | null; shared: boolean }): Promise<string> {
    return this.rpc<string>("register_part_model", {
      p_project_id: a.projectId, p_mpn: a.mpn, p_manufacturer: a.manufacturer, p_normalized_mpn: a.normalizedMpn,
      p_normalized_mfr: a.normalizedMfr, p_footprint: a.footprint, p_source_kind: a.sourceKind, p_source: a.source,
      p_source_url: a.sourceUrl, p_license: a.license, p_original_path: null, p_shared: a.shared, p_mechanical: {},
    });
  }

  async claimModelCheck(workerId: string): Promise<Record<string, unknown> | null> {
    const r = await this.rpc<Record<string, unknown> | null>("claim_model_check", { p_worker_id: workerId });
    return r && (r as { id?: string }).id ? r : null;
  }

  async completeModelCheck(id: string, workerId: string, status: string, check: unknown, error: string | null,
                           f: { originalPath?: string | null; originalSha?: string; storagePath?: string | null; sha256?: string | null;
                                overlayPath?: string | null; mechanical?: unknown }): Promise<void> {
    await this.rpc("complete_model_check", {
      p_id: id, p_worker_id: workerId, p_status: status, p_check: check, p_error: error,
      p_original_path: f.originalPath ?? null, p_original_sha256: f.originalSha ?? null, p_storage_path: f.storagePath ?? null,
      p_sha256: f.sha256 ?? null, p_overlay_path: f.overlayPath ?? null, p_mechanical: f.mechanical ?? null,
    });
  }

  /** Verified models usable by a project (its own, plus shared ones) for the given parts. */
  async verifiedModels(projectId: string, parts: { normalizedMpn: string; normalizedMfr: string }[]):
      Promise<{ id: string; normalized_mpn: string; normalized_mfr: string; footprint: string; storage_path: string; sha256: string;
                source: string; license: string | null; shared: boolean }[]> {
    if (!parts.length) return [];
    const { data, error } = await this.client.from("part_models")
      .select("id, footprint, storage_path, sha256, source, license, shared, project_id, verified_at, parts!inner(normalized_mpn, normalized_mfr)")
      .eq("status", "verified").in("parts.normalized_mpn", parts.map((p) => p.normalizedMpn))
      .order("verified_at", { ascending: false });
    if (error) throw new Error(`verified models: ${error.message}`);
    return (data ?? [])
      .filter((m) => m.shared || m.project_id === projectId)
      .map((m) => { const p = m.parts as unknown as { normalized_mpn: string; normalized_mfr: string };
                    return { id: m.id, normalized_mpn: p.normalized_mpn, normalized_mfr: p.normalized_mfr, footprint: m.footprint,
                             storage_path: m.storage_path!, sha256: m.sha256!, source: m.source, license: m.license, shared: m.shared }; })
      .filter((m) => parts.some((p) => p.normalizedMpn === m.normalized_mpn && p.normalizedMfr === m.normalized_mfr));
  }

  // --- Concepts (M-CON) ---

  async claimConceptRound(workerId: string): Promise<ConceptRoundRow | null> {
    const r = await this.rpc<ConceptRoundRow | null>("claim_concept_round", { p_worker_id: workerId });
    return r && r.id ? r : null;
  }

  async completeConceptRound(id: string, workerId: string, brief: unknown, briefModel: string | null, provider: string | null,
                             model: string | null, variants: unknown[], error: string | null): Promise<string> {
    return this.rpc<string>("complete_concept_round", {
      p_round_id: id, p_worker_id: workerId, p_brief: brief, p_brief_model: briefModel, p_provider: provider, p_model: model,
      p_variants: variants, p_error: error,
    });
  }

  /** What the brief needs: project, requirements, the variant being refined, and the current design freeze. */
  async conceptContext(round: ConceptRoundRow): Promise<{
    project: { name: string; description: string | null };
    requirements: { ref_code: string; kind: string; text: string }[];
    parent: { name: string; prompt: string; cmf: Record<string, unknown>; image_path: string; mime_type: string; round_no: number } | null;
    freeze: { name: string; envelope: { length_mm: number; width_mm: number; height_mm: number } } | null;
  }> {
    const [{ data: project, error: e1 }, { data: reqs, error: e2 }, parent, { data: freeze, error: e4 }] = await Promise.all([
      this.client.from("projects").select("name, description").eq("id", round.project_id).single(),
      this.client.from("requirements").select("ref_code, kind, text").eq("project_id", round.project_id).neq("status", "rejected").order("ref_code"),
      round.parent_variant_id
        ? this.client.from("concept_variants").select("name, prompt, cmf, image_path, mime_type, concept_rounds!concept_variants_round_id_fkey(round_no)").eq("id", round.parent_variant_id).single()
        : Promise.resolve({ data: null, error: null }),
      this.client.from("current_design_freeze").select("envelope, concept_variants(name)").eq("project_id", round.project_id).maybeSingle(),
    ]);
    const err = e1 ?? e2 ?? parent.error ?? e4;
    if (err) throw new Error(`concept context: ${err.message}`);
    const p = parent.data as { name: string; prompt: string; cmf: Record<string, unknown>; image_path: string; mime_type: string;
                               concept_rounds: { round_no: number } } | null;
    return {
      project: project!, requirements: reqs ?? [],
      parent: p ? { name: p.name, prompt: p.prompt, cmf: p.cmf, image_path: p.image_path, mime_type: p.mime_type, round_no: p.concept_rounds.round_no } : null,
      freeze: freeze ? { name: (freeze.concept_variants as unknown as { name: string }).name,
                         envelope: freeze.envelope as { length_mm: number; width_mm: number; height_mm: number } } : null,
    };
  }

  /** A cost outside a run (concept generation is asked for directly, not by a plan task). */
  async recordProjectCost(projectId: string, kind: "ai_tokens" | "api_call", provider: string, resource: string,
                          quantity: number, unit: string, costUsd = 0): Promise<void> {
    const { error } = await this.client.from("cost_events").insert({ project_id: projectId, kind, provider, resource, quantity, unit, cost_usd: costUsd });
    if (error) throw new Error(`cost event: ${error.message}`);
  }

  // --- RFQ packets (M-RFQ) ---

  async claimRfqPacket(workerId: string): Promise<RfqRow | null> {
    const r = await this.rpc<RfqRow | null>("claim_rfq_packet", { p_worker_id: workerId });
    return r && r.id ? r : null;
  }

  async completeRfqPacket(id: string, workerId: string, path: string, sha256: string, files: unknown[], error: string | null): Promise<string> {
    return this.rpc<string>("complete_rfq_packet", { p_rfq_id: id, p_worker_id: workerId, p_path: path, p_sha256: sha256,
                                                    p_files: files, p_error: error });
  }

  /** Exactly what the RFQ selects: its committed attachments and the project's requirements (filtered by the builder). */
  async rfqContents(rfqId: string, projectId: string): Promise<{
    requirements: { ref_code: string; kind: string; priority: string; text: string }[];
    attachments: { name: string; version: number; sha256: string; ext: string; storage_path: string }[];
  }> {
    const [{ data: reqs, error: e1 }, { data: att, error: e2 }] = await Promise.all([
      this.client.from("requirements").select("ref_code, kind, priority, text").eq("project_id", projectId).neq("status", "rejected"),
      this.client.from("rfq_attachments").select("artifact_versions(version, sha256, storage_path, status, project_id, artifacts(name))").eq("rfq_id", rfqId),
    ]);
    const err = e1 ?? e2;
    if (err) throw new Error(`rfq contents: ${err.message}`);
    const attachments = (att ?? []).map((a) => {
      const v = a.artifact_versions as unknown as { version: number; sha256: string; storage_path: string; status: string; project_id: string;
                                                   artifacts: { name: string } };
      if (v.status !== "committed" || v.project_id !== projectId) throw new Error(`${v.artifacts.name} v${v.version} is not a committed file of this project`);
      const ext = /\.([A-Za-z0-9]{1,8})$/.exec(v.storage_path)?.[1] ?? "";
      return { name: v.artifacts.name, version: v.version, sha256: v.sha256, ext, storage_path: v.storage_path };
    });
    return { requirements: reqs ?? [], attachments };
  }

  async downloadBytes(path: string): Promise<Uint8Array> {
    const { data, error } = await this.client.storage.from(BUCKET).download(path);
    if (error) throw new Error(`download ${path}: ${error.message}`);
    return new Uint8Array(await data.arrayBuffer());
  }

  async downloadText(path: string): Promise<string> {
    const { data, error } = await this.client.storage.from(BUCKET).download(path);
    if (error) throw new Error(`download ${path}: ${error.message}`);
    return data.text();
  }
}

export interface ConceptRoundRow {
  id: string; project_id: string; round_no: number; direction: string; variant_count: number; parent_variant_id: string | null;
  attempts: number;
}


export interface RfqRow {
  id: string; project_id: string; rfq_no: number; title: string; category: ManufacturingCategory;
  sharing_scope: "summary_only" | "drawings" | "full_design"; response_deadline: string; manifest: unknown;
}
