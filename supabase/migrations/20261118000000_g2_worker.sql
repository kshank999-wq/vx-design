-- G2: worker backbone.
--
-- Authorized runs, a durable task queue with leases and heartbeats, resumable checkpoints,
-- per-artifact write locks, budgets, and fenced commits: every state change a worker makes
-- names its execution, and only the worker that still holds that execution may make it.
-- A worker that lost its lease (crash, pause, network split) cannot commit anything, so
-- a run that resumes on another worker never produces duplicate committed work.

-- (execution_status 'interrupted' is added in 20261117030000_execution_interrupted.sql.)

-- ---------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------

alter table public.runs
  add column name        text,
  add column stop_reason text,
  add column report      jsonb,          -- in-app completion report, written when the run ends
  add column paused_at   timestamptz,
  add column updated_at  timestamptz not null default now();
create trigger runs_updated_at before update on public.runs
  for each row execute function public.set_updated_at();
create unique index runs_one_active_per_plan on public.runs (plan_id)
  where status in ('pending', 'running', 'paused');
create index runs_project_created_idx on public.runs (project_id, created_at desc);

alter table public.executions
  drop constraint executions_task_id_attempt_key,          -- a resumed attempt continues in a new row
  add column lease_seconds   integer not null default 60 check (lease_seconds between 5 and 3600),
  add column checkpoint_seq  integer not null default 0,
  add column resumed_from_id uuid references public.executions (id) on delete set null,
  add column compute_seconds numeric(12, 3) not null default 0 check (compute_seconds >= 0),
  add column summary         text;
create unique index executions_one_live_per_task on public.executions (task_id) where status = 'running';
create index executions_task_idx on public.executions (task_id, created_at);
create index executions_run_idx on public.executions (run_id);

alter table public.tasks
  add column interruptions integer not null default 0 check (interruptions >= 0),
  add column retry_base    integer not null default 0 check (retry_base >= 0);  -- attempts before the last manual retry/rework

alter table public.artifact_versions
  add column content_type text,
  add column summary      text,
  add column validated_at timestamptz;
-- The database itself guarantees a task commits at most one version of an artifact.
create unique index artifact_versions_one_commit_per_task on public.artifact_versions (artifact_id, produced_by_task_id)
  where status = 'committed';
create index artifact_versions_task_idx on public.artifact_versions (produced_by_task_id);


-- Activity log for executions (tool calls, steps, errors). Written by workers.
create table public.execution_logs (
  id           bigint generated always as identity primary key,
  project_id   uuid not null references public.projects (id) on delete cascade,
  execution_id uuid not null references public.executions (id) on delete cascade,
  level        text not null default 'info' check (level in ('debug', 'info', 'warn', 'error')),
  message      text not null,
  data         jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);
create index execution_logs_execution_idx on public.execution_logs (execution_id, id);
alter table public.execution_logs enable row level security;
create policy "members read execution logs" on public.execution_logs for select to authenticated
  using (public.is_project_member(project_id));

-- ---------------------------------------------------------------------------
-- Writes to run, artifact and validation state go through the functions below.
-- ---------------------------------------------------------------------------

drop policy "engineers write runs" on public.runs;
drop policy "engineers update runs" on public.runs;
drop policy "owners delete runs" on public.runs;
drop policy "engineers write artifacts" on public.artifacts;
drop policy "engineers update artifacts" on public.artifacts;
drop policy "owners delete artifacts" on public.artifacts;
drop policy "engineers write artifact_versions" on public.artifact_versions;
drop policy "engineers update artifact_versions" on public.artifact_versions;
drop policy "owners delete artifact_versions" on public.artifact_versions;
drop policy "engineers write validations" on public.validations;
drop policy "engineers update validations" on public.validations;
drop policy "owners delete validations" on public.validations;
drop policy "reviewers respond to approvals" on public.approvals;  -- decide_plan / decide_task

-- Signed-in users may hold, release, cancel or retry tasks; everything else is the worker's.
create function public.guard_task_status_source() returns trigger
language plpgsql as $$
begin
  if new.status is distinct from old.status then
    if current_user in ('authenticated', 'anon') and not (
         (old.status = 'ready' and new.status in ('blocked', 'canceled'))
      or (old.status in ('blocked', 'failed') and new.status in ('ready', 'canceled'))) then
      raise exception 'task status % -> % is set by the worker or the approval workflow', old.status, new.status;
    end if;
    if old.status in ('failed', 'blocked') and new.status = 'ready' then
      new.retry_base := new.attempts;   -- a manual retry gets a fresh retry allowance
      new.interruptions := 0;
      new.blocker_reason := null;
    end if;
  end if;
  return new;
end;
$$;
-- Named to fire after tasks_status_change, so invalid transitions report as such first.
create trigger tasks_status_source_guard before update of status on public.tasks
  for each row execute function public.guard_task_status_source();

-- ---------------------------------------------------------------------------
-- Internal helpers
-- ---------------------------------------------------------------------------

create function public.worker_audit(p_project uuid, p_event text, p_entity text, p_id uuid, p_payload jsonb)
returns void language sql security definer set search_path = '' as $$
  insert into public.audit_events (project_id, actor_id, actor_type, event_type, entity_type, entity_id, payload)
  values (p_project, auth.uid(),
          case when auth.uid() is null then 'worker'::public.actor_type else 'user'::public.actor_type end,
          p_event, p_entity, p_id, coalesce(p_payload, '{}'::jsonb));
$$;

create function public.run_spend(p_run_id uuid, out ai_usd numeric, out compute_usd numeric)
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(cost_usd) filter (where kind = 'ai_tokens'), 0),
         coalesce(sum(cost_usd) filter (where kind <> 'ai_tokens'), 0)
    from public.cost_events where run_id = p_run_id;
$$;

-- Is this task inside the run's authorized scope (ignoring its current status)?
create function public.task_in_run_scope(p_task public.tasks, p_run public.runs) returns boolean
language sql stable as $$
  select p_task.plan_id = p_run.plan_id
     and p_task.risk_level = any (p_run.allowed_risk_levels)
     and (p_run.authorized_task_ids is null or p_task.id = any (p_run.authorized_task_ids));
$$;

-- The task's latest execution, if it was interrupted during the current attempt (so a claim resumes it).
create function public.resumable_execution(p_task public.tasks) returns public.executions
language sql stable security definer set search_path = '' as $$
  select e.* from (select * from public.executions where task_id = p_task.id order by created_at desc limit 1) e
   where e.status = 'interrupted' and e.attempt = p_task.attempts;
$$;

-- Can a worker start (or resume) this task for this run right now? A fresh claim uses up an
-- attempt; resuming an interrupted attempt does not.
create function public.task_claimable(p_task public.tasks, p_run public.runs) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_task.status = 'ready'
     and public.task_in_run_scope(p_task, p_run)
     and p_task.attempts - p_task.retry_base
         + case when (public.resumable_execution(p_task)).id is null then 1 else 0 end
         <= least(p_run.max_retries_per_task + 1, p_task.max_attempts)
     and not exists (
       select 1 from public.task_dependencies d
       join public.tasks up on up.id = d.depends_on_task_id
       where d.task_id = p_task.id and up.status <> 'complete');
$$;

-- Fencing: the execution must still be live and held by this worker.
create function public.held_execution(p_execution_id uuid, p_worker_id text) returns public.executions
language plpgsql security definer set search_path = '' as $$
declare
  v_exec public.executions;
begin
  select * into v_exec from public.executions where id = p_execution_id for update;
  if not found or v_exec.status <> 'running' or v_exec.worker_id is distinct from p_worker_id then
    raise exception 'execution % is no longer held by worker %', p_execution_id, p_worker_id
      using errcode = 'P0001', hint = 'lease_lost';
  end if;
  return v_exec;
end;
$$;

create function public.release_locks(p_execution_id uuid) returns void
language sql security definer set search_path = '' as $$
  update public.artifacts set locked_by_execution_id = null, locked_at = null
   where locked_by_execution_id = p_execution_id;
$$;

-- Executions that make up one attempt of a task (the original plus any resumptions).
create function public.attempt_execution_ids(p_task_id uuid, p_attempt integer) returns uuid[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(id), '{}') from public.executions where task_id = p_task_id and attempt = p_attempt;
$$;

-- Promote an attempt's validated scratch outputs to committed, superseding older versions.
create function public.commit_task_outputs(p_task_id uuid, p_attempt integer) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_version public.artifact_versions;
  v_count integer := 0;
begin
  for v_version in
    select * from public.artifact_versions
     where produced_by_task_id = p_task_id and status = 'scratch' and validated_at is not null
       and produced_by_execution_id = any (public.attempt_execution_ids(p_task_id, p_attempt))
     order by artifact_id, version desc
  loop
    -- Only the newest validated version per artifact is committed.
    if exists (select 1 from public.artifact_versions
                where artifact_id = v_version.artifact_id and produced_by_task_id = p_task_id
                  and status = 'committed') then
      continue;
    end if;
    update public.artifact_versions set status = 'superseded'
     where artifact_id = v_version.artifact_id and status = 'committed';
    update public.artifact_versions set status = 'committed' where id = v_version.id;
    insert into public.task_artifacts (task_id, artifact_version_id, role)
    values (p_task_id, v_version.id, 'output') on conflict do nothing;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- User-facing run controls
-- ---------------------------------------------------------------------------

create function public.authorize_run(
  p_plan_id uuid,
  p_mode public.supervision_mode,
  p_max_ai_spend_usd numeric,
  p_max_compute_spend_usd numeric,
  p_allowed_risk_levels public.risk_level[] default '{low,medium}',
  p_max_retries_per_task integer default 2,
  p_task_ids uuid[] default null,
  p_stop_conditions jsonb default '{}'::jsonb,
  p_name text default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_plan public.plans;
  v_run_id uuid;
begin
  select * into v_plan from public.plans where id = p_plan_id;
  if not found or not public.has_project_role(v_plan.project_id, '{owner,engineer}') then
    raise exception 'plan not found or not permitted';
  end if;
  if v_plan.status <> 'approved' then
    raise exception 'only the approved baseline can run (plan is %)', v_plan.status;
  end if;
  if 'critical' = any (p_allowed_risk_levels) and not public.has_project_role(v_plan.project_id, '{owner}') then
    raise exception 'only the project owner can authorize critical-risk tasks';
  end if;
  if coalesce(array_length(p_allowed_risk_levels, 1), 0) = 0 then
    raise exception 'allow at least one risk level';
  end if;
  if p_task_ids is not null and exists (
       select 1 from unnest(p_task_ids) x(id)
        where not exists (select 1 from public.tasks t where t.id = x.id and t.plan_id = p_plan_id)) then
    raise exception 'authorized tasks must belong to the plan';
  end if;
  if exists (select 1 from public.runs where plan_id = p_plan_id and status in ('pending', 'running', 'paused')) then
    raise exception 'this plan already has an active run; pause, resume or cancel it instead';
  end if;

  insert into public.runs (project_id, plan_id, mode, status, authorized_task_ids, allowed_risk_levels,
                           max_ai_spend_usd, max_compute_spend_usd, max_retries_per_task, stop_conditions,
                           name, started_by, started_at)
  values (v_plan.project_id, p_plan_id, p_mode, 'running', p_task_ids, p_allowed_risk_levels,
          p_max_ai_spend_usd, p_max_compute_spend_usd, p_max_retries_per_task, coalesce(p_stop_conditions, '{}'),
          p_name, auth.uid(), now())
  returning id into v_run_id;

  perform public.worker_audit(v_plan.project_id, 'run.authorized', 'run', v_run_id, jsonb_build_object(
    'plan_version', v_plan.version, 'mode', p_mode, 'max_ai_spend_usd', p_max_ai_spend_usd,
    'max_compute_spend_usd', p_max_compute_spend_usd, 'allowed_risk_levels', p_allowed_risk_levels,
    'max_retries_per_task', p_max_retries_per_task, 'task_ids', p_task_ids));
  return v_run_id;
end;
$$;

-- pause: no new tasks start; in-flight work stops at its next checkpoint and resumes later.
-- resume: continue a paused run. cancel: end the run; in-flight work stops at its next checkpoint.
create function public.control_run(p_run_id uuid, p_action text) returns public.run_status
language plpgsql security definer set search_path = '' as $$
declare
  v_run public.runs;
  v_to public.run_status;
begin
  select * into v_run from public.runs where id = p_run_id for update;
  if not found or not public.has_project_role(v_run.project_id, '{owner,engineer}') then
    raise exception 'run not found or not permitted';
  end if;
  v_to := case
    when p_action = 'pause'  and v_run.status = 'running'               then 'paused'
    when p_action = 'resume' and v_run.status = 'paused'                then 'running'
    when p_action = 'cancel' and v_run.status in ('running', 'paused', 'pending') then 'canceled'
  end::public.run_status;
  if v_to is null then
    raise exception 'cannot % a run that is %', p_action, v_run.status;
  end if;
  update public.runs
     set status = v_to,
         paused_at = case when v_to = 'paused' then now() end,
         finished_at = case when v_to = 'canceled' then now() else finished_at end,
         stop_reason = case when v_to = 'canceled' then 'canceled by user' else stop_reason end
   where id = p_run_id;
  perform public.worker_audit(v_run.project_id, 'run.' || p_action, 'run', p_run_id,
                              jsonb_build_object('from', v_run.status, 'to', v_to));
  return v_to;
end;
$$;

-- Approve or return a task whose outputs passed validation but need a person's sign-off.
create function public.decide_task(p_task_id uuid, p_approve boolean, p_note text default null) returns public.task_status
language plpgsql security definer set search_path = '' as $$
declare
  v_task public.tasks;
  v_committed integer;
begin
  select * into v_task from public.tasks where id = p_task_id for update;
  if not found or not public.has_project_role(v_task.project_id, '{owner,reviewer}') then
    raise exception 'task not found or not permitted';
  end if;
  if v_task.status <> 'awaiting_approval' then
    raise exception 'task is %, not awaiting approval', v_task.status;
  end if;
  if not p_approve and coalesce(btrim(p_note), '') = '' then
    raise exception 'say what needs to change when returning a task';
  end if;

  update public.approvals
     set status = case when p_approve then 'approved' else 'rejected' end::public.approval_status,
         responded_by = auth.uid(), responded_at = now(), response_note = p_note
   where task_id = p_task_id and status = 'pending';

  if p_approve then
    v_committed := public.commit_task_outputs(p_task_id, v_task.attempts);
    update public.tasks set status = 'complete' where id = p_task_id;
  else
    -- Rework: the reviewer's note is passed to the next attempt; it gets a fresh retry allowance.
    update public.tasks set status = 'ready', retry_base = attempts, interruptions = 0 where id = p_task_id;
  end if;
  perform public.worker_audit(v_task.project_id, case when p_approve then 'task.approved' else 'task.returned' end,
                              'task', p_task_id, jsonb_build_object('note', p_note, 'committed_versions', v_committed));
  return case when p_approve then 'complete' else 'ready' end::public.task_status;
end;
$$;

-- ---------------------------------------------------------------------------
-- Worker functions (service role only)
-- ---------------------------------------------------------------------------

drop function public.claim_next_task(text, uuid);

-- Claim the next runnable task of a run, in plan order. If the task's current attempt was
-- interrupted, the new execution resumes it: same attempt number, checkpoint carried over.
create function public.claim_next_task(p_worker_id text, p_run_id uuid, p_lease_seconds integer default 60)
returns public.executions
language plpgsql security definer set search_path = '' as $$
declare
  v_run  public.runs;
  v_task public.tasks;
  v_prev public.executions;
  v_exec public.executions;
  v_spend record;
begin
  select * into v_run from public.runs where id = p_run_id;
  if not found or v_run.status <> 'running' then
    return null;
  end if;
  v_spend := public.run_spend(p_run_id);
  if v_spend.ai_usd >= v_run.max_ai_spend_usd or v_spend.compute_usd >= v_run.max_compute_spend_usd then
    return null;
  end if;

  select t.* into v_task
    from public.tasks t
   where t.plan_id = v_run.plan_id and t.status = 'ready'
     and public.task_claimable(t, v_run)
   order by t.position, t.created_at
   for update of t skip locked
   limit 1;
  if not found then
    return null;
  end if;

  v_prev := public.resumable_execution(v_task);

  update public.tasks
     set status = 'running', assigned_worker = p_worker_id,
         attempts = case when v_prev.id is null then attempts + 1 else attempts end
   where id = v_task.id;

  insert into public.executions (project_id, task_id, run_id, attempt, status, worker_id, started_at, heartbeat_at,
                                 lease_seconds, checkpoint, checkpoint_seq, resumed_from_id)
  values (v_task.project_id, v_task.id, p_run_id,
          case when v_prev.id is null then v_task.attempts + 1 else v_task.attempts end,
          'running', p_worker_id, now(), now(), p_lease_seconds,
          v_prev.checkpoint, coalesce(v_prev.checkpoint_seq, 0), v_prev.id)
  returning * into v_exec;

  perform public.worker_audit(v_task.project_id, case when v_prev.id is null then 'execution.started' else 'execution.resumed' end,
                              'execution', v_exec.id, jsonb_build_object('task_id', v_task.id, 'attempt', v_exec.attempt,
                              'worker_id', p_worker_id, 'run_id', p_run_id, 'resumed_from', v_prev.id,
                              'checkpoint_seq', v_exec.checkpoint_seq));
  return v_exec;
end;
$$;

-- Renew the lease and optionally save a checkpoint. Returns what the worker should do next:
--   continue | yield (run paused, canceled or stopped: stop at this checkpoint) | lost (lease gone)
create function public.heartbeat_execution(p_execution_id uuid, p_worker_id text, p_checkpoint jsonb default null)
returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_exec public.executions;
  v_run_status public.run_status;
begin
  update public.executions
     set heartbeat_at = now(),
         checkpoint = coalesce(p_checkpoint, checkpoint),
         checkpoint_seq = checkpoint_seq + case when p_checkpoint is null then 0 else 1 end
   where id = p_execution_id and status = 'running' and worker_id = p_worker_id
  returning * into v_exec;
  if not found then
    return 'lost';
  end if;
  select status into v_run_status from public.runs where id = v_exec.run_id;
  return case when v_run_status = 'running' then 'continue' else 'yield' end;
end;
$$;

-- Stop at a checkpoint without using up a retry (pause, cancel, budget stop, lock contention, shutdown).
create function public.yield_execution(p_execution_id uuid, p_worker_id text, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_exec public.executions := public.held_execution(p_execution_id, p_worker_id);
begin
  update public.executions set status = 'interrupted', error = p_reason, finished_at = now() where id = v_exec.id;
  update public.tasks set status = 'ready', assigned_worker = null
   where id = v_exec.task_id and status in ('running', 'validating');
  perform public.release_locks(v_exec.id);
  perform public.worker_audit(v_exec.project_id, 'execution.yielded', 'execution', v_exec.id,
                              jsonb_build_object('reason', p_reason, 'checkpoint_seq', v_exec.checkpoint_seq));
end;
$$;

-- Reclaim work from workers that stopped heartbeating. Their attempts become resumable;
-- a task interrupted three times in a row is blocked (it may be what crashes the worker).
create function public.reap_stale_executions(p_max_interruptions integer default 3) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_exec public.executions;
  v_count integer := 0;
  v_interruptions integer;
begin
  for v_exec in
    select * from public.executions
     where status = 'running' and heartbeat_at < now() - make_interval(secs => lease_seconds)
     for update skip locked
  loop
    update public.executions
       set status = 'interrupted', finished_at = now(),
           error = format('worker %s stopped heartbeating (last %s)', v_exec.worker_id, v_exec.heartbeat_at)
     where id = v_exec.id;
    update public.tasks set interruptions = interruptions + 1 where id = v_exec.task_id
    returning interruptions into v_interruptions;
    if v_interruptions >= p_max_interruptions then
      update public.tasks set status = 'blocked', assigned_worker = null,
             blocker_reason = format('interrupted %s times without finishing; check the execution logs', v_interruptions)
       where id = v_exec.task_id and status in ('running', 'validating');
    else
      update public.tasks set status = 'ready', assigned_worker = null
       where id = v_exec.task_id and status in ('running', 'validating');
    end if;
    perform public.release_locks(v_exec.id);
    perform public.worker_audit(v_exec.project_id, 'execution.reaped', 'execution', v_exec.id,
                                jsonb_build_object('worker_id', v_exec.worker_id, 'heartbeat_at', v_exec.heartbeat_at,
                                                   'checkpoint_seq', v_exec.checkpoint_seq));
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- Per-artifact write lock. Returns the artifact id, or null if another live execution holds it.
create function public.acquire_artifact_lock(p_execution_id uuid, p_worker_id text, p_name text,
                                             p_kind public.artifact_kind) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_exec public.executions := public.held_execution(p_execution_id, p_worker_id);
  v_artifact public.artifacts;
begin
  insert into public.artifacts (project_id, kind, name, created_by)
  values (v_exec.project_id, p_kind, p_name, null)
  on conflict (project_id, name) do nothing;
  select * into v_artifact from public.artifacts where project_id = v_exec.project_id and name = p_name for update;
  if v_artifact.locked_by_execution_id is not null and v_artifact.locked_by_execution_id <> v_exec.id
     and exists (select 1 from public.executions where id = v_artifact.locked_by_execution_id and status = 'running') then
    return null;
  end if;
  update public.artifacts set locked_by_execution_id = v_exec.id, locked_at = now() where id = v_artifact.id;
  return v_artifact.id;
end;
$$;

-- Record an output file as a scratch version. Idempotent within an attempt: re-registering
-- the same content (e.g. after resuming from a checkpoint) returns the existing version.
create function public.add_scratch_version(
  p_execution_id uuid, p_worker_id text, p_artifact_id uuid, p_storage_path text, p_sha256 text,
  p_size_bytes bigint, p_content_type text, p_tool_name text, p_tool_version text,
  p_tool_config jsonb default '{}'::jsonb, p_summary text default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_exec public.executions := public.held_execution(p_execution_id, p_worker_id);
  v_id uuid;
begin
  if not exists (select 1 from public.artifacts where id = p_artifact_id and locked_by_execution_id = v_exec.id) then
    raise exception 'execution % does not hold the write lock for artifact %', v_exec.id, p_artifact_id;
  end if;
  select id into v_id from public.artifact_versions
   where artifact_id = p_artifact_id and produced_by_task_id = v_exec.task_id and sha256 = p_sha256
     and status = 'scratch'
     and produced_by_execution_id = any (public.attempt_execution_ids(v_exec.task_id, v_exec.attempt));
  if v_id is not null then
    return v_id;
  end if;
  insert into public.artifact_versions (artifact_id, project_id, version, status, storage_path, sha256, size_bytes,
                                        content_type, tool_name, tool_version, tool_config, summary,
                                        produced_by_task_id, produced_by_execution_id)
  values (p_artifact_id, v_exec.project_id,
          (select coalesce(max(version), 0) + 1 from public.artifact_versions where artifact_id = p_artifact_id),
          'scratch', p_storage_path, p_sha256, p_size_bytes, p_content_type, p_tool_name, p_tool_version,
          coalesce(p_tool_config, '{}'), p_summary, v_exec.task_id, v_exec.id)
  returning id into v_id;
  return v_id;
end;
$$;

create function public.begin_validation(p_execution_id uuid, p_worker_id text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_exec public.executions := public.held_execution(p_execution_id, p_worker_id);
begin
  update public.tasks set status = 'validating' where id = v_exec.task_id and status = 'running';
  if not found and not exists (select 1 from public.tasks where id = v_exec.task_id and status = 'validating') then
    raise exception 'task for execution % is not running', v_exec.id;
  end if;
end;
$$;

-- Finish an attempt whose checks passed. Records validations, then either commits the outputs
-- (task complete) or holds them for sign-off (task awaiting_approval). Returns the task status.
--   p_validations: [{kind, result, evidence_category, summary, details?, artifact_version_id?, tool_name?, tool_version?}]
--   p_review_reason: the executor asks for sign-off (e.g. an acceptance test that needs human review).
create function public.complete_execution(p_execution_id uuid, p_worker_id text, p_validations jsonb,
                                          p_summary text default null, p_review_reason text default null)
returns public.task_status
language plpgsql security definer set search_path = '' as $$
declare
  v_exec public.executions := public.held_execution(p_execution_id, p_worker_id);
  v_task public.tasks;
  v_run  public.runs;
  v_v jsonb;
  v_gate text;
  v_status public.task_status;
  v_committed integer := 0;
begin
  select * into v_task from public.tasks where id = v_exec.task_id for update;
  if v_task.status <> 'validating' then
    raise exception 'task % is %, expected validating', v_task.id, v_task.status;
  end if;
  select * into v_run from public.runs where id = v_exec.run_id;

  for v_v in select * from jsonb_array_elements(coalesce(p_validations, '[]'::jsonb)) loop
    if v_v ->> 'result' in ('fail', 'error') then
      raise exception 'complete_execution called with a failing validation (%); use fail_execution', v_v ->> 'summary';
    end if;
    insert into public.validations (project_id, task_id, execution_id, artifact_version_id, kind, result,
                                    evidence_category, summary, details, tool_name, tool_version)
    values (v_exec.project_id, v_task.id, v_exec.id, (v_v ->> 'artifact_version_id')::uuid,
            (v_v ->> 'kind')::public.validation_kind, (v_v ->> 'result')::public.validation_result,
            (v_v ->> 'evidence_category')::public.evidence_category, v_v ->> 'summary',
            coalesce(v_v -> 'details', '{}'::jsonb), v_v ->> 'tool_name', v_v ->> 'tool_version');
  end loop;

  update public.artifact_versions set validated_at = now()
   where produced_by_task_id = v_task.id and status = 'scratch' and validated_at is null
     and produced_by_execution_id = any (public.attempt_execution_ids(v_task.id, v_exec.attempt));

  -- Sign-off: the plan's approval policy always applies; Guided mode also gates design disciplines.
  v_gate := case
    when p_review_reason is not null then p_review_reason
    when coalesce((v_task.approval_policy ->> 'required')::boolean, false)
      then coalesce(v_task.approval_policy ->> 'reason', 'approval required by the plan')
    when v_run.mode = 'guided' and v_task.discipline in
         ('architecture', 'components', 'schematic', 'pcb_layout', 'power', 'mechanical', 'enclosure')
      then format('Guided mode: %s results need your review', v_task.discipline)
  end;

  if v_gate is not null then
    update public.tasks set status = 'awaiting_approval', assigned_worker = null where id = v_task.id;
    insert into public.approvals (project_id, task_id, reason, requested_by)
    values (v_exec.project_id, v_task.id, v_gate, null);
    v_status := 'awaiting_approval';
  else
    v_committed := public.commit_task_outputs(v_task.id, v_exec.attempt);
    update public.tasks set status = 'complete', assigned_worker = null where id = v_task.id;
    v_status := 'complete';
  end if;

  update public.executions set status = 'succeeded', finished_at = now(), summary = p_summary where id = v_exec.id;
  perform public.release_locks(v_exec.id);
  perform public.worker_audit(v_exec.project_id, 'execution.succeeded', 'execution', v_exec.id,
                              jsonb_build_object('task_status', v_status, 'committed_versions', v_committed, 'gate', v_gate));
  return v_status;
end;
$$;

-- Finish an attempt that did not succeed.
--   p_outcome: 'retry' (task back to ready if retries remain, else failed) | 'fail' | 'block'
create function public.fail_execution(p_execution_id uuid, p_worker_id text, p_error text, p_outcome text,
                                      p_validations jsonb default '[]'::jsonb) returns public.task_status
language plpgsql security definer set search_path = '' as $$
declare
  v_exec public.executions := public.held_execution(p_execution_id, p_worker_id);
  v_task public.tasks;
  v_run  public.runs;
  v_v jsonb;
  v_status public.task_status;
begin
  if p_outcome not in ('retry', 'fail', 'block') then
    raise exception 'unknown outcome %', p_outcome;
  end if;
  select * into v_task from public.tasks where id = v_exec.task_id for update;
  select * into v_run from public.runs where id = v_exec.run_id;

  for v_v in select * from jsonb_array_elements(coalesce(p_validations, '[]'::jsonb)) loop
    insert into public.validations (project_id, task_id, execution_id, artifact_version_id, kind, result,
                                    evidence_category, summary, details, tool_name, tool_version)
    values (v_exec.project_id, v_task.id, v_exec.id, (v_v ->> 'artifact_version_id')::uuid,
            (v_v ->> 'kind')::public.validation_kind, (v_v ->> 'result')::public.validation_result,
            (v_v ->> 'evidence_category')::public.evidence_category, v_v ->> 'summary',
            coalesce(v_v -> 'details', '{}'::jsonb), v_v ->> 'tool_name', v_v ->> 'tool_version');
  end loop;

  v_status := case
    when p_outcome = 'block' then 'blocked'
    when p_outcome = 'retry'
         and v_task.attempts - v_task.retry_base <= coalesce(v_run.max_retries_per_task, 0)
         and v_task.attempts - v_task.retry_base < v_task.max_attempts then 'ready'
    else 'failed'
  end::public.task_status;

  update public.executions set status = 'failed', error = p_error, finished_at = now() where id = v_exec.id;
  update public.tasks set status = v_status, assigned_worker = null,
         blocker_reason = case when v_status = 'ready' then null else p_error end
   where id = v_task.id and status in ('running', 'validating');
  perform public.release_locks(v_exec.id);
  perform public.worker_audit(v_exec.project_id, 'execution.failed', 'execution', v_exec.id,
                              jsonb_build_object('error', p_error, 'outcome', p_outcome, 'task_status', v_status));

  if v_status in ('failed', 'blocked') and coalesce((v_run.stop_conditions ->> 'stop_on_failure')::boolean, false) then
    update public.runs set status = 'stopped', stop_reason = format('task %s %s: %s', v_task.key, v_status, p_error)
     where id = v_run.id and status = 'running';
  end if;
  return v_status;
end;
$$;

-- Record spend. Stops the run (in-flight work yields at its next heartbeat) when a budget is exhausted.
-- Returns 'ok' or 'over_budget'.
create function public.record_cost(p_execution_id uuid, p_kind public.cost_kind, p_provider text, p_resource text,
                                   p_quantity numeric, p_unit text, p_cost_usd numeric) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_exec public.executions;
  v_run public.runs;
  v_spend record;
  v_reason text;
begin
  select * into v_exec from public.executions where id = p_execution_id;
  if not found then
    raise exception 'unknown execution %', p_execution_id;
  end if;
  insert into public.cost_events (project_id, run_id, task_id, execution_id, kind, provider, resource, quantity, unit, cost_usd)
  values (v_exec.project_id, v_exec.run_id, v_exec.task_id, v_exec.id, p_kind, p_provider, p_resource,
          coalesce(p_quantity, 0), p_unit, greatest(coalesce(p_cost_usd, 0), 0));
  if v_exec.run_id is null then
    return 'ok';
  end if;
  select * into v_run from public.runs where id = v_exec.run_id for update;
  v_spend := public.run_spend(v_run.id);
  v_reason := case
    when v_spend.ai_usd >= v_run.max_ai_spend_usd
      then format('AI budget reached: $%s of $%s', round(v_spend.ai_usd, 4), v_run.max_ai_spend_usd)
    when v_spend.compute_usd >= v_run.max_compute_spend_usd
      then format('compute budget reached: $%s of $%s', round(v_spend.compute_usd, 4), v_run.max_compute_spend_usd)
  end;
  if v_reason is null then
    return 'ok';
  end if;
  if v_run.status in ('running', 'paused') then
    update public.runs set status = 'stopped', stop_reason = v_reason where id = v_run.id;
    perform public.worker_audit(v_run.project_id, 'run.budget_stop', 'run', v_run.id,
                                jsonb_build_object('reason', v_reason, 'ai_usd', v_spend.ai_usd, 'compute_usd', v_spend.compute_usd));
  end if;
  return 'over_budget';
end;
$$;

-- Snapshot of a run's scope for the worker's scheduler and the completion report.
create function public.run_progress(p_run_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_run public.runs;
  v_result jsonb;
begin
  select * into v_run from public.runs where id = p_run_id;
  if not found then
    return null;
  end if;
  select jsonb_build_object(
           'claimable', count(*) filter (where public.task_claimable(t, v_run)),
           'in_flight', count(*) filter (where t.status in ('running', 'validating')),
           'total', count(*))
    into v_result
    from public.tasks t where public.task_in_run_scope(t, v_run);
  return v_result || jsonb_build_object(
    'by_status', coalesce((select jsonb_object_agg(s, n) from (
        select t.status as s, count(*) as n from public.tasks t
         where public.task_in_run_scope(t, v_run) group by t.status) x), '{}'::jsonb),
    'live_executions', (select count(*) from public.executions e where e.run_id = p_run_id and e.status = 'running'));
end;
$$;

-- End a run and store its completion report. Runs that were canceled or stopped keep that
-- status; a running run becomes completed (or the given status).
create function public.finish_run(p_run_id uuid, p_status public.run_status, p_report jsonb, p_reason text default null)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_run public.runs;
begin
  select * into v_run from public.runs where id = p_run_id for update;
  if not found then
    raise exception 'unknown run %', p_run_id;
  end if;
  if v_run.status = 'paused' then
    raise exception 'run is paused; resume or cancel it first';
  end if;
  if v_run.report is not null then
    return;   -- already finished (another worker got here first)
  end if;
  update public.runs
     set status = case when v_run.status in ('running', 'pending') then p_status else v_run.status end,
         stop_reason = coalesce(v_run.stop_reason, p_reason),
         report = p_report,
         finished_at = coalesce(finished_at, now())
   where id = p_run_id;
  perform public.worker_audit(v_run.project_id, 'run.finished', 'run', p_run_id,
                              jsonb_build_object('status', p_status, 'reason', p_reason));
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

do $$
declare
  f text;
begin
  foreach f in array array[
    'worker_audit(uuid, text, text, uuid, jsonb)', 'run_spend(uuid)', 'task_claimable(public.tasks, public.runs)',
    'held_execution(uuid, text)', 'resumable_execution(public.tasks)', 'release_locks(uuid)', 'attempt_execution_ids(uuid, integer)',
    'commit_task_outputs(uuid, integer)', 'claim_next_task(text, uuid, integer)',
    'heartbeat_execution(uuid, text, jsonb)', 'yield_execution(uuid, text, text)', 'reap_stale_executions(integer)',
    'acquire_artifact_lock(uuid, text, text, public.artifact_kind)',
    'add_scratch_version(uuid, text, uuid, text, text, bigint, text, text, text, jsonb, text)',
    'begin_validation(uuid, text)', 'complete_execution(uuid, text, jsonb, text, text)',
    'fail_execution(uuid, text, text, text, jsonb)',
    'record_cost(uuid, public.cost_kind, text, text, numeric, text, numeric)', 'run_progress(uuid)',
    'finish_run(uuid, public.run_status, jsonb, text)'
  ] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end;
$$;

revoke execute on function public.authorize_run(uuid, public.supervision_mode, numeric, numeric, public.risk_level[], integer, uuid[], jsonb, text) from public, anon;
revoke execute on function public.control_run(uuid, text) from public, anon;
revoke execute on function public.decide_task(uuid, boolean, text) from public, anon;
grant execute on function public.authorize_run(uuid, public.supervision_mode, numeric, numeric, public.risk_level[], integer, uuid[], jsonb, text) to authenticated;
grant execute on function public.control_run(uuid, text) to authenticated;
grant execute on function public.decide_task(uuid, boolean, text) to authenticated;
grant select on public.execution_logs to authenticated;
grant all on public.execution_logs to service_role;
