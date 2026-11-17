-- VX Design — initial schema
-- Implements spec v0.1 §6 (task data contract), §7 (approvals / unattended runs),
-- §8 (evidence, versioned artifacts, audit) and §14 (initial tables).
--
-- Access model: every project-scoped row is visible only to members of that
-- project (RLS). Engineering workers use the service role, which bypasses RLS.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

create type public.project_role as enum ('owner', 'engineer', 'reviewer', 'viewer');

create type public.supervision_mode as enum ('guided', 'professional', 'autonomous');

create type public.document_kind as enum (
  'specification', 'datasheet', 'flux_export', 'bom', 'step_model', 'image', 'other'
);

create type public.requirement_kind as enum (
  'functional', 'electrical', 'power', 'mechanical', 'thermal', 'interface',
  'environmental', 'regulatory', 'manufacturing', 'cost', 'other'
);

create type public.requirement_status as enum ('extracted', 'confirmed', 'ambiguous', 'rejected');

create type public.plan_status as enum ('draft', 'awaiting_approval', 'approved', 'superseded');

create type public.discipline as enum (
  'architecture', 'components', 'sourcing', 'schematic', 'pcb_layout', 'power',
  'thermal', 'simulation', 'mechanical', 'enclosure', 'verification',
  'manufacturing', 'documentation'
);

create type public.task_status as enum (
  'draft', 'ready', 'running', 'validating', 'awaiting_approval', 'complete',
  'blocked', 'failed', 'canceled', 'superseded'
);

create type public.risk_level as enum ('low', 'medium', 'high', 'critical');

create type public.decision_class as enum (
  'component_selection', 'passive_substitution', 'processor_family',
  'power_architecture', 'battery_chemistry', 'board_dimensions', 'layer_stackup',
  'connector_assignment', 'mechanical', 'bom_budget', 'manufacturing', 'other'
);

create type public.approval_status as enum ('pending', 'approved', 'rejected', 'withdrawn');

create type public.run_status as enum ('pending', 'running', 'paused', 'completed', 'stopped', 'failed', 'canceled');

create type public.execution_status as enum ('queued', 'running', 'succeeded', 'failed', 'canceled', 'timed_out');

create type public.artifact_kind as enum (
  'specification', 'requirements', 'plan', 'kicad_project', 'schematic', 'pcb',
  'netlist', 'bom', 'power_budget', 'simulation', 'step', 'stl', 'enclosure',
  'fab_package', 'report', 'other'
);

create type public.artifact_version_status as enum ('scratch', 'committed', 'superseded');

create type public.evidence_category as enum (
  'datasheet_verified', 'deterministic_calculation', 'simulation', 'cad_check',
  'hardware_test', 'unverified_assumption'
);

create type public.validation_kind as enum (
  'erc', 'drc', 'bom_check', 'footprint_check', 'fit_check', 'simulation',
  'power_budget', 'dfm', 'acceptance_test', 'other'
);

create type public.validation_result as enum ('pass', 'warning', 'fail', 'error');

create type public.capability_status as enum ('untested', 'verified', 'partial', 'blocked');

create type public.cost_kind as enum ('ai_tokens', 'compute', 'api_call', 'other');

create type public.actor_type as enum ('user', 'worker', 'system');

-- ---------------------------------------------------------------------------
-- Shared helpers
-- ---------------------------------------------------------------------------

create function public.set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Projects & membership
-- ---------------------------------------------------------------------------

create table public.projects (
  id               uuid primary key default gen_random_uuid(),
  name             text not null check (length(trim(name)) > 0),
  description      text,
  supervision_mode public.supervision_mode not null default 'guided',
  created_by       uuid not null default auth.uid() references auth.users (id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create table public.project_members (
  project_id uuid not null references public.projects (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  role       public.project_role not null default 'viewer',
  created_at timestamptz not null default now(),
  primary key (project_id, user_id)
);
create index project_members_user_idx on public.project_members (user_id);

-- Membership checks used by RLS. SECURITY DEFINER avoids recursive RLS on
-- project_members; search_path is pinned for safety.
create function public.is_project_member(p_project_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.project_members m
    where m.project_id = p_project_id and m.user_id = auth.uid()
  );
$$;

create function public.has_project_role(p_project_id uuid, p_roles public.project_role[]) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.project_members m
    where m.project_id = p_project_id and m.user_id = auth.uid() and m.role = any (p_roles)
  );
$$;

-- The creator of a project becomes its owner.
create function public.add_project_owner() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.project_members (project_id, user_id, role)
  values (new.id, new.created_by, 'owner')
  on conflict do nothing;
  return new;
end;
$$;

create trigger projects_add_owner after insert on public.projects
  for each row execute function public.add_project_owner();
create trigger projects_updated_at before update on public.projects
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Source documents & requirements (§5 intake)
-- ---------------------------------------------------------------------------

create table public.documents (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references public.projects (id) on delete cascade,
  kind         public.document_kind not null,
  title        text not null,
  storage_path text not null,                      -- path in the project-files bucket
  sha256       text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes   bigint check (size_bytes >= 0),
  mime_type    text,
  supersedes_id uuid references public.documents (id),
  uploaded_by  uuid default auth.uid() references auth.users (id),
  created_at   timestamptz not null default now(),
  unique (project_id, sha256)
);
create index documents_project_idx on public.documents (project_id);

create table public.requirements (
  id                  uuid primary key default gen_random_uuid(),
  project_id          uuid not null references public.projects (id) on delete cascade,
  document_id         uuid references public.documents (id) on delete set null,
  ref_code            text not null,               -- e.g. REQ-PWR-004
  kind                public.requirement_kind not null default 'other',
  status              public.requirement_status not null default 'extracted',
  text                text not null,
  source_section      text,                        -- citation back to the source document
  source_page         integer,
  source_excerpt      text,
  acceptance_criteria text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (project_id, ref_code)
);
create index requirements_project_idx on public.requirements (project_id);
create trigger requirements_updated_at before update on public.requirements
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Plans & tasks (§5, §6)
-- ---------------------------------------------------------------------------

create table public.plans (
  id               uuid primary key default gen_random_uuid(),
  project_id       uuid not null references public.projects (id) on delete cascade,
  version          integer not null check (version > 0),
  status           public.plan_status not null default 'draft',
  supervision_mode public.supervision_mode not null default 'guided',
  summary          text,
  created_by       uuid default auth.uid() references auth.users (id),
  approved_by      uuid references auth.users (id),
  approved_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (project_id, version),
  check (status <> 'approved' or (approved_by is not null and approved_at is not null))
);
-- At most one approved (frozen baseline) plan per project.
create unique index plans_one_approved_idx on public.plans (project_id) where status = 'approved';
create trigger plans_updated_at before update on public.plans
  for each row execute function public.set_updated_at();

create table public.tasks (
  id               uuid primary key default gen_random_uuid(),
  project_id       uuid not null references public.projects (id) on delete cascade,
  plan_id          uuid not null references public.plans (id) on delete cascade,
  key              text not null,                  -- stable slug within a plan, e.g. "pwr-tree"
  title            text not null,
  discipline       public.discipline not null,
  description      text,
  required_tools   text[] not null default '{}',
  acceptance_tests jsonb not null default '[]'::jsonb,
  approval_policy  jsonb not null default '{}'::jsonb,
  risk_level       public.risk_level not null default 'medium',
  status           public.task_status not null default 'draft',
  assigned_worker  text,
  attempts         integer not null default 0 check (attempts >= 0),
  max_attempts     integer not null default 3 check (max_attempts > 0),
  timeout_seconds  integer not null default 3600 check (timeout_seconds > 0),
  cost_budget_usd  numeric(12, 4) check (cost_budget_usd >= 0),
  blocker_reason   text,
  started_at       timestamptz,
  completed_at     timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (plan_id, key)
);
create index tasks_project_idx on public.tasks (project_id);
create index tasks_ready_idx on public.tasks (created_at) where status = 'ready';
create trigger tasks_updated_at before update on public.tasks
  for each row execute function public.set_updated_at();

create table public.task_dependencies (
  task_id            uuid not null references public.tasks (id) on delete cascade,
  depends_on_task_id uuid not null references public.tasks (id) on delete cascade,
  primary key (task_id, depends_on_task_id),
  check (task_id <> depends_on_task_id)
);
create index task_dependencies_upstream_idx on public.task_dependencies (depends_on_task_id);

-- Dependencies must stay inside one plan and must not form a cycle.
create function public.check_task_dependency() returns trigger
language plpgsql as $$
begin
  if (select plan_id from public.tasks where id = new.task_id)
     is distinct from (select plan_id from public.tasks where id = new.depends_on_task_id) then
    raise exception 'task dependency must stay within one plan';
  end if;

  if exists (
    with recursive upstream(id) as (
      select new.depends_on_task_id
      union
      select d.depends_on_task_id
      from public.task_dependencies d join upstream u on d.task_id = u.id
    )
    select 1 from upstream where id = new.task_id
  ) then
    raise exception 'task dependency would create a cycle';
  end if;
  return new;
end;
$$;

create trigger task_dependencies_check before insert or update on public.task_dependencies
  for each row execute function public.check_task_dependency();

-- Task state machine (§6). Every transition is validated and written to the audit log.
create function public.task_transition_allowed(p_from public.task_status, p_to public.task_status)
returns boolean language sql immutable as $$
  select case p_from
    when 'draft'             then p_to in ('ready', 'canceled', 'superseded')
    when 'ready'             then p_to in ('running', 'blocked', 'canceled', 'superseded')
    when 'running'           then p_to in ('validating', 'failed', 'blocked', 'canceled', 'ready')
    when 'validating'        then p_to in ('awaiting_approval', 'complete', 'failed', 'blocked', 'ready')
    when 'awaiting_approval' then p_to in ('complete', 'ready', 'blocked', 'canceled')
    when 'blocked'           then p_to in ('ready', 'canceled', 'superseded')
    when 'failed'            then p_to in ('ready', 'canceled', 'superseded')
    when 'complete'          then p_to in ('superseded')
    else false               -- canceled, superseded are terminal
  end;
$$;

create function public.on_task_status_change() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status is distinct from old.status then
    if not public.task_transition_allowed(old.status, new.status) then
      raise exception 'invalid task transition % -> %', old.status, new.status;
    end if;
    if new.status = 'running' and new.started_at is null then
      new.started_at := now();
    end if;
    if new.status = 'complete' then
      new.completed_at := now();
    end if;
    insert into public.audit_events (project_id, actor_id, actor_type, event_type, entity_type, entity_id, payload)
    values (
      new.project_id, auth.uid(),
      case when auth.uid() is null then 'worker'::public.actor_type else 'user'::public.actor_type end,
      'task.status_changed', 'task', new.id,
      jsonb_build_object('from', old.status, 'to', new.status, 'blocker_reason', new.blocker_reason)
    );
  end if;
  return new;
end;
$$;

create trigger tasks_status_change before update of status on public.tasks
  for each row execute function public.on_task_status_change();

-- ---------------------------------------------------------------------------
-- Engineering decisions (immutable; superseded by new rows) & approvals (§7)
-- ---------------------------------------------------------------------------

create table public.decisions (
  id                uuid primary key default gen_random_uuid(),
  project_id        uuid not null references public.projects (id) on delete cascade,
  task_id           uuid references public.tasks (id) on delete set null,
  decision_class    public.decision_class not null,
  title             text not null,
  statement         text not null,
  rationale         text,
  alternatives      jsonb not null default '[]'::jsonb,
  evidence_category public.evidence_category not null default 'unverified_assumption',
  evidence_refs     jsonb not null default '[]'::jsonb,   -- datasheet URLs, artifact version ids, etc.
  supersedes_id     uuid unique references public.decisions (id),
  created_by        uuid default auth.uid() references auth.users (id),
  created_at        timestamptz not null default now()
);
create index decisions_project_idx on public.decisions (project_id);

-- Current (non-superseded) decisions.
create view public.current_decisions with (security_invoker = true) as
  select d.* from public.decisions d
  where not exists (select 1 from public.decisions n where n.supersedes_id = d.id);

create function public.forbid_modification() returns trigger
language plpgsql as $$
begin
  raise exception '% rows are immutable', tg_table_name;
end;
$$;

create trigger decisions_immutable before update or delete on public.decisions
  for each row execute function public.forbid_modification();

-- Unattended / authorized runs (§7 "Unattended run fields").
create table public.runs (
  id                    uuid primary key default gen_random_uuid(),
  project_id            uuid not null references public.projects (id) on delete cascade,
  plan_id               uuid not null references public.plans (id) on delete cascade,
  mode                  public.supervision_mode not null,
  status                public.run_status not null default 'pending',
  authorized_task_ids   uuid[],                    -- null = all ready tasks in the plan
  allowed_risk_levels   public.risk_level[] not null default '{low,medium}',
  max_ai_spend_usd      numeric(12, 4) not null check (max_ai_spend_usd >= 0),
  max_compute_spend_usd numeric(12, 4) not null check (max_compute_spend_usd >= 0),
  max_retries_per_task  integer not null default 2 check (max_retries_per_task >= 0),
  stop_conditions       jsonb not null default '{}'::jsonb,
  report_preference     jsonb not null default '{}'::jsonb,
  started_by            uuid default auth.uid() references auth.users (id),
  created_at            timestamptz not null default now(),
  started_at            timestamptz,
  finished_at           timestamptz
);
create index runs_project_idx on public.runs (project_id);

create table public.approvals (
  id               uuid primary key default gen_random_uuid(),
  project_id       uuid not null references public.projects (id) on delete cascade,
  plan_id          uuid references public.plans (id) on delete cascade,
  task_id          uuid references public.tasks (id) on delete cascade,
  decision_id      uuid references public.decisions (id) on delete cascade,
  status           public.approval_status not null default 'pending',
  reason           text not null,                  -- why approval is required
  requested_by     uuid default auth.uid() references auth.users (id),
  requested_at     timestamptz not null default now(),
  responded_by     uuid references auth.users (id),
  responded_at     timestamptz,
  response_note    text,
  check (num_nonnulls(plan_id, task_id, decision_id) = 1),
  check (status = 'pending' or (responded_by is not null and responded_at is not null))
);
create index approvals_project_pending_idx on public.approvals (project_id) where status = 'pending';

-- ---------------------------------------------------------------------------
-- Executions (worker attempts, checkpoints)
-- ---------------------------------------------------------------------------

create table public.executions (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references public.projects (id) on delete cascade,
  task_id       uuid not null references public.tasks (id) on delete cascade,
  run_id        uuid references public.runs (id) on delete set null,
  attempt       integer not null check (attempt > 0),
  status        public.execution_status not null default 'queued',
  worker_id     text,
  tool_versions jsonb not null default '{}'::jsonb,
  checkpoint    jsonb,                             -- resumable progress
  log_path      text,
  error         text,
  started_at    timestamptz,
  heartbeat_at  timestamptz,
  finished_at   timestamptz,
  created_at    timestamptz not null default now(),
  unique (task_id, attempt)
);
create index executions_running_idx on public.executions (heartbeat_at) where status = 'running';

-- ---------------------------------------------------------------------------
-- Artifacts & versions (§8 reproducibility, per-artifact write locks)
-- ---------------------------------------------------------------------------

create table public.artifacts (
  id                     uuid primary key default gen_random_uuid(),
  project_id             uuid not null references public.projects (id) on delete cascade,
  kind                   public.artifact_kind not null,
  name                   text not null,            -- e.g. "smart-slate/timecode-board"
  locked_by_execution_id uuid references public.executions (id) on delete set null,
  locked_at              timestamptz,
  created_by             uuid default auth.uid() references auth.users (id),
  created_at             timestamptz not null default now(),
  unique (project_id, name)
);

create table public.artifact_versions (
  id                    uuid primary key default gen_random_uuid(),
  artifact_id           uuid not null references public.artifacts (id) on delete cascade,
  project_id            uuid not null references public.projects (id) on delete cascade,
  version               integer not null check (version > 0),
  status                public.artifact_version_status not null default 'scratch',
  storage_path          text not null,
  sha256                text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes            bigint check (size_bytes >= 0),
  tool_name             text,
  tool_version          text,
  tool_config           jsonb not null default '{}'::jsonb,
  produced_by_task_id   uuid references public.tasks (id) on delete set null,
  produced_by_execution_id uuid references public.executions (id) on delete set null,
  created_at            timestamptz not null default now(),
  committed_at          timestamptz,
  unique (artifact_id, version)
);
create index artifact_versions_project_idx on public.artifact_versions (project_id);

-- Committed versions are frozen: only status may move committed -> superseded.
create function public.protect_committed_artifact_version() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'scratch' then
      raise exception 'committed artifact versions cannot be deleted';
    end if;
    return old;
  end if;

  if old.status = 'scratch' then
    if new.status = 'committed' and new.committed_at is null then
      new.committed_at := now();
    end if;
    return new;
  end if;

  if old.status = 'committed' and new.status = 'superseded'
     and (new.storage_path, new.sha256, new.version, new.artifact_id)
         is not distinct from (old.storage_path, old.sha256, old.version, old.artifact_id) then
    return new;
  end if;

  raise exception 'artifact version % is % and cannot be modified', old.id, old.status;
end;
$$;

create trigger artifact_versions_protect before update or delete on public.artifact_versions
  for each row execute function public.protect_committed_artifact_version();

create table public.task_artifacts (
  task_id             uuid not null references public.tasks (id) on delete cascade,
  artifact_version_id uuid not null references public.artifact_versions (id) on delete cascade,
  role                text not null check (role in ('input', 'output')),
  primary key (task_id, artifact_version_id, role)
);

-- ---------------------------------------------------------------------------
-- Validations (evidence; ERC/DRC/fit/BOM are separate gates — §8)
-- ---------------------------------------------------------------------------

create table public.validations (
  id                  uuid primary key default gen_random_uuid(),
  project_id          uuid not null references public.projects (id) on delete cascade,
  task_id             uuid references public.tasks (id) on delete set null,
  artifact_version_id uuid references public.artifact_versions (id) on delete set null,
  execution_id        uuid references public.executions (id) on delete set null,
  kind                public.validation_kind not null,
  result              public.validation_result not null,
  evidence_category   public.evidence_category not null,
  summary             text not null,
  details             jsonb not null default '{}'::jsonb,
  report_path         text,
  tool_name           text,
  tool_version        text,
  created_at          timestamptz not null default now()
);
create index validations_project_idx on public.validations (project_id);
create index validations_task_idx on public.validations (task_id);

-- ---------------------------------------------------------------------------
-- Tool capability matrix (§4 G0 gate) — global, not per project
-- ---------------------------------------------------------------------------

create table public.tool_capabilities (
  id              uuid primary key default gen_random_uuid(),
  tool_name       text not null,                   -- e.g. "kicad", "digikey"
  operation       text not null,                   -- e.g. "drc", "gerber_export", "product_search"
  status          public.capability_status not null default 'untested',
  tool_version    text,
  deployment_mode text,                            -- e.g. "docker worker", "hosted API"
  auth_notes      text,
  quota_notes     text,
  license         text,
  commercial_ok   boolean,
  sample_io_path  text,
  errors_seen     text,
  fallback        text,
  test_owner      text,
  verified_at     timestamptz,
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (tool_name, operation)
);
create trigger tool_capabilities_updated_at before update on public.tool_capabilities
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Cost tracking & audit log
-- ---------------------------------------------------------------------------

create table public.cost_events (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references public.projects (id) on delete cascade,
  run_id       uuid references public.runs (id) on delete set null,
  task_id      uuid references public.tasks (id) on delete set null,
  execution_id uuid references public.executions (id) on delete set null,
  kind         public.cost_kind not null,
  provider     text not null,                      -- e.g. "anthropic", "worker-vm", "nexar"
  resource     text,                               -- e.g. model id, machine type, endpoint
  quantity     numeric(18, 4) not null default 0,
  unit         text,                               -- e.g. "input_tokens", "cpu_seconds", "requests"
  cost_usd     numeric(12, 6) not null default 0 check (cost_usd >= 0),
  created_at   timestamptz not null default now()
);
create index cost_events_run_idx on public.cost_events (run_id);
create index cost_events_task_idx on public.cost_events (task_id);

create table public.audit_events (
  id          bigint generated always as identity primary key,
  project_id  uuid references public.projects (id) on delete cascade,
  actor_id    uuid references auth.users (id) on delete set null,
  actor_type  public.actor_type not null,
  event_type  text not null,                       -- e.g. "task.status_changed"
  entity_type text,
  entity_id   uuid,
  payload     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index audit_events_project_idx on public.audit_events (project_id, created_at desc);

-- Append-only. Row deletes are allowed only via project cascade.
create trigger audit_events_no_update before update on public.audit_events
  for each row execute function public.forbid_modification();

-- ---------------------------------------------------------------------------
-- Worker queue: claim the next ready task whose upstream tasks are complete.
-- Uses SKIP LOCKED so multiple workers never claim the same task.
-- ---------------------------------------------------------------------------

create function public.claim_next_task(p_worker_id text, p_run_id uuid default null)
returns public.executions
language plpgsql security definer set search_path = '' as $$
declare
  v_task public.tasks;
  v_exec public.executions;
  v_run  public.runs;
begin
  if p_run_id is not null then
    select * into v_run from public.runs where id = p_run_id;
    if not found or v_run.status <> 'running' then
      return null;
    end if;
  end if;

  select t.* into v_task
  from public.tasks t
  where t.status = 'ready'
    and t.attempts < t.max_attempts
    and (v_run.id is null or (
          t.plan_id = v_run.plan_id
          and t.risk_level = any (v_run.allowed_risk_levels)
          and (v_run.authorized_task_ids is null or t.id = any (v_run.authorized_task_ids))
          and t.attempts <= v_run.max_retries_per_task))
    and not exists (
      select 1 from public.task_dependencies d
      join public.tasks up on up.id = d.depends_on_task_id
      where d.task_id = t.id and up.status <> 'complete'
    )
  order by t.created_at
  for update of t skip locked
  limit 1;

  if not found then
    return null;
  end if;

  update public.tasks
     set status = 'running', assigned_worker = p_worker_id, attempts = attempts + 1
   where id = v_task.id;

  insert into public.executions (project_id, task_id, run_id, attempt, status, worker_id, started_at, heartbeat_at)
  values (v_task.project_id, v_task.id, p_run_id, v_task.attempts + 1, 'running', p_worker_id, now(), now())
  returning * into v_exec;

  return v_exec;
end;
$$;

revoke execute on function public.claim_next_task(text, uuid) from public;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.projects          enable row level security;
alter table public.project_members   enable row level security;
alter table public.documents         enable row level security;
alter table public.requirements      enable row level security;
alter table public.plans             enable row level security;
alter table public.tasks             enable row level security;
alter table public.task_dependencies enable row level security;
alter table public.decisions         enable row level security;
alter table public.runs              enable row level security;
alter table public.approvals         enable row level security;
alter table public.executions        enable row level security;
alter table public.artifacts         enable row level security;
alter table public.artifact_versions enable row level security;
alter table public.task_artifacts    enable row level security;
alter table public.validations       enable row level security;
alter table public.tool_capabilities enable row level security;
alter table public.cost_events       enable row level security;
alter table public.audit_events      enable row level security;

-- Projects
create policy "members read projects" on public.projects for select to authenticated
  using (public.is_project_member(id));
create policy "users create projects" on public.projects for insert to authenticated
  with check (created_by = auth.uid());
create policy "owners update projects" on public.projects for update to authenticated
  using (public.has_project_role(id, '{owner}')) with check (public.has_project_role(id, '{owner}'));
create policy "owners delete projects" on public.projects for delete to authenticated
  using (public.has_project_role(id, '{owner}'));

-- Membership
create policy "members read membership" on public.project_members for select to authenticated
  using (public.is_project_member(project_id));
create policy "owners manage membership" on public.project_members for all to authenticated
  using (public.has_project_role(project_id, '{owner}'))
  with check (public.has_project_role(project_id, '{owner}'));

-- Engineering data: members read; owners/engineers write.
do $$
declare
  t text;
begin
  foreach t in array array[
    'documents', 'requirements', 'plans', 'tasks', 'runs', 'artifacts',
    'artifact_versions', 'validations'
  ] loop
    execute format(
      'create policy "members read %1$s" on public.%1$I for select to authenticated
         using (public.is_project_member(project_id))', t);
    execute format(
      'create policy "engineers write %1$s" on public.%1$I for insert to authenticated
         with check (public.has_project_role(project_id, ''{owner,engineer}''))', t);
    execute format(
      'create policy "engineers update %1$s" on public.%1$I for update to authenticated
         using (public.has_project_role(project_id, ''{owner,engineer}''))
         with check (public.has_project_role(project_id, ''{owner,engineer}''))', t);
    execute format(
      'create policy "owners delete %1$s" on public.%1$I for delete to authenticated
         using (public.has_project_role(project_id, ''{owner}''))', t);
  end loop;
end;
$$;

-- Decisions: append-only for owners/engineers.
create policy "members read decisions" on public.decisions for select to authenticated
  using (public.is_project_member(project_id));
create policy "engineers record decisions" on public.decisions for insert to authenticated
  with check (public.has_project_role(project_id, '{owner,engineer}'));

-- Approvals: engineers request; owners/reviewers respond.
create policy "members read approvals" on public.approvals for select to authenticated
  using (public.is_project_member(project_id));
create policy "engineers request approvals" on public.approvals for insert to authenticated
  with check (public.has_project_role(project_id, '{owner,engineer}') and status = 'pending');
create policy "reviewers respond to approvals" on public.approvals for update to authenticated
  using (public.has_project_role(project_id, '{owner,reviewer}'))
  with check (public.has_project_role(project_id, '{owner,reviewer}') and responded_by = auth.uid());

-- Task graph tables keyed through tasks.
create policy "members read task dependencies" on public.task_dependencies for select to authenticated
  using (exists (select 1 from public.tasks t where t.id = task_id and public.is_project_member(t.project_id)));
create policy "engineers write task dependencies" on public.task_dependencies for all to authenticated
  using (exists (select 1 from public.tasks t where t.id = task_id
                 and public.has_project_role(t.project_id, '{owner,engineer}')))
  with check (exists (select 1 from public.tasks t where t.id = task_id
                      and public.has_project_role(t.project_id, '{owner,engineer}')));

create policy "members read task artifacts" on public.task_artifacts for select to authenticated
  using (exists (select 1 from public.tasks t where t.id = task_id and public.is_project_member(t.project_id)));

-- Worker-written tables: members read; writes come from the service role.
create policy "members read executions" on public.executions for select to authenticated
  using (public.is_project_member(project_id));
create policy "members read cost events" on public.cost_events for select to authenticated
  using (public.is_project_member(project_id));
create policy "members read audit events" on public.audit_events for select to authenticated
  using (public.is_project_member(project_id));

-- Capability matrix: readable by any signed-in user; maintained by the service role.
create policy "authenticated read capabilities" on public.tool_capabilities for select to authenticated
  using (true);

-- ---------------------------------------------------------------------------
-- Storage: private bucket, objects stored under "<project_id>/..."
-- Skipped automatically when the storage schema is absent (plain Postgres tests).
-- ---------------------------------------------------------------------------

create function public.storage_path_project_id(p_name text) returns uuid
language sql immutable as $$
  select case
    when split_part(p_name, '/', 1) ~ '^[0-9a-fA-F-]{36}$' then split_part(p_name, '/', 1)::uuid
  end;
$$;

do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    insert into storage.buckets (id, name, public)
    values ('project-files', 'project-files', false)
    on conflict (id) do nothing;

    create policy "members read project files" on storage.objects for select to authenticated
      using (bucket_id = 'project-files'
             and public.is_project_member(public.storage_path_project_id(name)));
    create policy "engineers upload project files" on storage.objects for insert to authenticated
      with check (bucket_id = 'project-files'
                  and public.has_project_role(public.storage_path_project_id(name), '{owner,engineer}'));
  end if;
end;
$$;
