-- Stage gates (§3.1) and the S0 risk register with feasibility findings.
--
-- Stages S0–S8 are the product's phases. Every task carries one (default from its discipline; editable while the plan
-- is a draft). A project with stage gates on works one stage at a time: a task is claimable only when every earlier
-- stage has been signed off. Sign-off (owners and reviewers) checks the stage's blockers; an owner may sign off past
-- them with a written reason (a recorded waiver). Reopening a stage (owner, with a reason) stops later stages' tasks
-- from starting until it is signed off again.
--
-- Risks: a numbered register per project, scored likelihood × impact (5 × 5), with a mitigation and a status. High and
-- critical risks block their stage's sign-off until mitigated, closed, or accepted by the owner with a note. The
-- feasibility check (deterministic rules in @vx/planning over the intake facts and requirements) files its findings as
-- risks keyed by rule, refreshing them on each run and closing those no longer detected; people's edits are kept.

create type public.project_stage as enum ('S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8');

-- ---------------------------------------------------------------------------
-- Task stages
-- ---------------------------------------------------------------------------
create function public.stage_for_discipline(p public.discipline) returns public.project_stage
language sql immutable set search_path = '' as $$
  select (case p
    when 'architecture' then 'S2' when 'components' then 'S2' when 'power' then 'S2' when 'documentation' then 'S2'
    when 'schematic' then 'S3' when 'pcb_layout' then 'S3' when 'thermal' then 'S3' when 'simulation' then 'S3'
    when 'mechanical' then 'S3' when 'enclosure' then 'S3'
    when 'sourcing' then 'S4' when 'manufacturing' then 'S5' when 'verification' then 'S6'
  end)::public.project_stage;
$$;

alter table public.tasks add column stage public.project_stage;
create function public.default_task_stage() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.stage is null then new.stage := public.stage_for_discipline(new.discipline); end if;
  return new;
end;
$$;
create trigger tasks_default_stage before insert on public.tasks for each row execute function public.default_task_stage();
update public.tasks set stage = public.stage_for_discipline(discipline) where stage is null;
alter table public.tasks alter column stage set not null;

alter table public.projects add column stage_gates boolean not null default false;

-- ---------------------------------------------------------------------------
-- Intake facts (S0)
-- ---------------------------------------------------------------------------
create table public.project_intake (
  project_id        uuid primary key references public.projects (id) on delete cascade,
  intended_use      text,
  regions           text[] not null default '{}',     -- markets, e.g. {US, EU}
  quantity          integer check (quantity > 0),     -- first production quantity
  target_unit_cost  numeric(12, 2) check (target_unit_cost >= 0),
  currency          text not null default 'USD',
  max_dimensions    text,                             -- e.g. "120 × 80 × 25 mm"
  power_source      text,                             -- e.g. "Li-ion 2S, USB-C charging"
  radios            text[] not null default '{}',     -- e.g. {Bluetooth LE}
  target_standards  text[] not null default '{}',
  notes             text,
  feasibility_checked_at timestamptz,
  feasibility_gaps  jsonb not null default '[]'::jsonb, -- intake facts the check needed and did not find
  updated_by        uuid references auth.users (id) on delete set null,
  updated_at        timestamptz not null default now()
);
alter table public.project_intake enable row level security;
create policy "members read intake" on public.project_intake for select to authenticated using (public.is_project_member(project_id));
grant select on public.project_intake to authenticated;
grant all on public.project_intake to service_role;

-- ---------------------------------------------------------------------------
-- Risk register
-- ---------------------------------------------------------------------------
create table public.risks (
  id               uuid primary key default gen_random_uuid(),
  project_id       uuid not null references public.projects (id) on delete cascade,
  risk_no          integer not null,
  title            text not null check (length(trim(title)) > 0),
  description      text,
  category         text not null check (category in ('technical', 'safety', 'regulatory', 'supply', 'cost', 'schedule',
                                                       'requirements', 'platform')),
  stage            public.project_stage not null,
  likelihood       integer not null check (likelihood between 1 and 5),
  impact           integer not null check (impact between 1 and 5),
  score            integer generated always as (likelihood * impact) stored,
  level            public.risk_level generated always as (case when likelihood * impact >= 20 then 'critical'::public.risk_level
                                                              when likelihood * impact >= 10 then 'high'::public.risk_level
                                                              when likelihood * impact >= 5 then 'medium'::public.risk_level
                                                              else 'low'::public.risk_level end) stored,
  status           text not null default 'open' check (status in ('open', 'mitigating', 'accepted', 'closed')),
  mitigation       text,
  requirement_refs text[] not null default '{}',
  source           text not null default 'manual' check (source in ('manual', 'feasibility')),
  rule_key         text,
  evidence         jsonb not null default '[]'::jsonb,   -- [{ref, excerpt}] the finding was based on
  decision_note    text,
  decided_by       uuid references auth.users (id) on delete set null,
  created_by       uuid references auth.users (id) on delete set null default auth.uid(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (project_id, risk_no),
  unique (project_id, rule_key),
  check (status <> 'accepted' or decision_note is not null)
);
create index risks_project_idx on public.risks (project_id, stage);
alter table public.risks enable row level security;
create policy "members read risks" on public.risks for select to authenticated using (public.is_project_member(project_id));
grant select on public.risks to authenticated;
grant all on public.risks to service_role;

-- ---------------------------------------------------------------------------
-- Stage gates
-- ---------------------------------------------------------------------------
create table public.stage_gates (
  project_id   uuid not null references public.projects (id) on delete cascade,
  stage        public.project_stage not null,
  status       text not null check (status in ('signed_off', 'reopened')),
  note         text,
  waived       jsonb not null default '[]'::jsonb,   -- blockers the owner signed off past, as they stood
  signed_by    uuid references auth.users (id) on delete set null,
  signed_at    timestamptz,
  reopened_by  uuid references auth.users (id) on delete set null,
  reopened_at  timestamptz,
  reopen_reason text,
  primary key (project_id, stage)
);
alter table public.stage_gates enable row level security;
create policy "members read gates" on public.stage_gates for select to authenticated using (public.is_project_member(project_id));
grant select on public.stage_gates to authenticated;
grant all on public.stage_gates to service_role;

-- Are all stages before p_stage signed off?
create function public.stage_unlocked(p_project uuid, p_stage public.project_stage) returns boolean
language sql stable security definer set search_path = '' as $$
  select not exists (
    select 1 from unnest(enum_range(null::public.project_stage)) s
     where s < p_stage
       and not exists (select 1 from public.stage_gates g where g.project_id = p_project and g.stage = s and g.status = 'signed_off'));
$$;

-- As in G2, plus: in a project with stage gates, a task waits until every earlier stage is signed off.
create or replace function public.task_claimable(p_task public.tasks, p_run public.runs) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_task.status = 'ready'
     and public.task_in_run_scope(p_task, p_run)
     and p_task.attempts - p_task.retry_base
         + case when (public.resumable_execution(p_task)).id is null then 1 else 0 end
         <= least(p_run.max_retries_per_task + 1, p_task.max_attempts)
     and not exists (
       select 1 from public.task_dependencies d
       join public.tasks up on up.id = d.depends_on_task_id
       where d.task_id = p_task.id and up.status <> 'complete')
     and (not (select pr.stage_gates from public.projects pr where pr.id = p_task.project_id)
          or public.stage_unlocked(p_task.project_id, p_task.stage));
$$;

-- What stands between a stage and its sign-off: [{kind, text}].
create function public.stage_blockers(p_project uuid, p_stage public.project_stage) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  b jsonb := '[]'::jsonb;
  v_plan uuid;
  i public.project_intake;
  r record;
begin
  select id into v_plan from public.plans where project_id = p_project and status = 'approved' order by version desc limit 1;
  if p_stage = 'S0' then
    select * into i from public.project_intake where project_id = p_project;
    if i.project_id is null or i.feasibility_checked_at is null then
      b := b || jsonb_build_array(jsonb_build_object('kind', 'feasibility', 'text', 'run the feasibility check'));
    end if;
    if coalesce(trim(i.intended_use), '') = '' then b := b || '[{"kind":"intake","text":"intended use is not recorded"}]'; end if;
    if coalesce(array_length(i.regions, 1), 0) = 0 then b := b || '[{"kind":"intake","text":"target markets (regions) are not recorded"}]'; end if;
    if i.quantity is null then b := b || '[{"kind":"intake","text":"first production quantity is not recorded"}]'; end if;
    if i.target_unit_cost is null then b := b || '[{"kind":"intake","text":"target unit cost is not recorded"}]'; end if;
    if coalesce(trim(i.power_source), '') = '' then b := b || '[{"kind":"intake","text":"power source is not recorded"}]'; end if;
    for r in select ref_code, status from public.requirements
              where project_id = p_project and status in ('extracted', 'ambiguous') order by ref_code loop
      b := b || jsonb_build_array(jsonb_build_object('kind', 'requirement',
             'text', format('%s is %s: confirm or reject it', r.ref_code, r.status)));
    end loop;
    if not exists (select 1 from public.requirements where project_id = p_project and status = 'confirmed') then
      b := b || '[{"kind":"requirement","text":"no confirmed requirements yet"}]';
    end if;
  elsif p_stage = 'S1' then
    if not exists (select 1 from public.design_freezes where project_id = p_project) then
      b := b || '[{"kind":"design_freeze","text":"no design freeze recorded (choose a concept, or sign off with a reason if the product needs no industrial design)"}]';
    end if;
  else
    if v_plan is null then
      b := b || '[{"kind":"plan","text":"no approved plan"}]';
    else
      for r in select key, status from public.tasks where plan_id = v_plan and stage = p_stage
                and status not in ('complete', 'canceled', 'superseded') order by position loop
        b := b || jsonb_build_array(jsonb_build_object('kind', 'task', 'text', format('task %s is %s', r.key, replace(r.status::text, '_', ' '))));
      end loop;
    end if;
    if p_stage = 'S6' then
      for r in select fault_no, title from public.faults where project_id = p_project and status in ('open', 'corrected') order by fault_no loop
        b := b || jsonb_build_array(jsonb_build_object('kind', 'fault', 'text', format('fault F-%s is not verified: %s', lpad(r.fault_no::text, 3, '0'), r.title)));
      end loop;
    end if;
  end if;
  for r in select risk_no, title, level from public.risks
            where project_id = p_project and stage = p_stage and level in ('high', 'critical') and status in ('open', 'mitigating')
            order by risk_no loop
    b := b || jsonb_build_array(jsonb_build_object('kind', 'risk', 'text',
           format('RISK-%s (%s) is unresolved: %s', lpad(r.risk_no::text, 3, '0'), r.level, r.title)));
  end loop;
  return b;
end;
$$;

-- The stage board for a project: one entry per stage, in order.
create function public.stage_status(p_project uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_plan uuid;
  v_out jsonb := '[]'::jsonb;
  v_current public.project_stage;
  s public.project_stage;
  g public.stage_gates;
begin
  if auth.uid() is not null and not public.is_project_member(p_project) then
    raise exception 'project not found or not permitted' using errcode = '42501';
  end if;
  select id into v_plan from public.plans where project_id = p_project and status = 'approved' order by version desc limit 1;
  select min(x) into v_current from unnest(enum_range(null::public.project_stage)) x
   where not exists (select 1 from public.stage_gates gg where gg.project_id = p_project and gg.stage = x and gg.status = 'signed_off');
  foreach s in array enum_range(null::public.project_stage) loop
    select * into g from public.stage_gates where project_id = p_project and stage = s;
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'stage', s, 'status', coalesce(g.status, 'open'), 'current', s = v_current,
      'unlocked', public.stage_unlocked(p_project, s),
      'tasks_total', (select count(*) from public.tasks where plan_id = v_plan and stage = s),
      'tasks_done', (select count(*) from public.tasks where plan_id = v_plan and stage = s and status in ('complete', 'canceled', 'superseded')),
      'tasks_ready', (select count(*) from public.tasks where plan_id = v_plan and stage = s and status = 'ready'),
      'risks_open', (select count(*) from public.risks where project_id = p_project and stage = s and status in ('open', 'mitigating')),
      'blockers', case when coalesce(g.status, 'open') = 'signed_off' then '[]'::jsonb else public.stage_blockers(p_project, s) end,
      'note', g.note, 'waived', coalesce(g.waived, '[]'::jsonb), 'signed_at', g.signed_at, 'reopen_reason', g.reopen_reason));
  end loop;
  return v_out;
end;
$$;

create function public.sign_off_stage(p_project uuid, p_stage public.project_stage, p_note text default null, p_waive boolean default false)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_blockers jsonb;
begin
  if not public.has_project_role(p_project, '{owner,reviewer}') then
    raise exception 'only owners and reviewers of the project can sign off a stage' using errcode = '42501';
  end if;
  if not public.stage_unlocked(p_project, p_stage) then
    raise exception 'sign off the earlier stages first';
  end if;
  if exists (select 1 from public.stage_gates where project_id = p_project and stage = p_stage and status = 'signed_off') then
    raise exception '% is already signed off', p_stage;
  end if;
  v_blockers := public.stage_blockers(p_project, p_stage);
  if jsonb_array_length(v_blockers) > 0 then
    if not p_waive then
      raise exception '% cannot be signed off yet: %', p_stage,
        (select string_agg(x ->> 'text', '; ') from jsonb_array_elements(v_blockers) x);
    end if;
    if not public.has_project_role(p_project, '{owner}') then
      raise exception 'only the project owner can sign off past open items' using errcode = '42501';
    end if;
    if coalesce(trim(p_note), '') = '' then
      raise exception 'say why the stage is signed off with open items';
    end if;
  else
    v_blockers := '[]'::jsonb;
  end if;
  insert into public.stage_gates (project_id, stage, status, note, waived, signed_by, signed_at)
  values (p_project, p_stage, 'signed_off', nullif(trim(p_note), ''), v_blockers, auth.uid(), now())
  on conflict (project_id, stage) do update set status = 'signed_off', note = excluded.note, waived = excluded.waived,
    signed_by = excluded.signed_by, signed_at = excluded.signed_at;
  perform public.worker_audit(p_project, 'stage.signed_off', 'project', p_project,
    jsonb_build_object('stage', p_stage, 'note', p_note, 'waived', v_blockers));
end;
$$;

create function public.reopen_stage(p_project uuid, p_stage public.project_stage, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.has_project_role(p_project, '{owner}') then
    raise exception 'only the project owner can reopen a stage' using errcode = '42501';
  end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'say why the stage is reopened'; end if;
  update public.stage_gates set status = 'reopened', reopened_by = auth.uid(), reopened_at = now(), reopen_reason = trim(p_reason)
   where project_id = p_project and stage = p_stage and status = 'signed_off';
  if not found then raise exception '% is not signed off', p_stage; end if;
  perform public.worker_audit(p_project, 'stage.reopened', 'project', p_project, jsonb_build_object('stage', p_stage, 'reason', p_reason));
end;
$$;

create function public.set_stage_gates(p_project uuid, p_on boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.has_project_role(p_project, '{owner}') then
    raise exception 'only the project owner can turn stage gates on or off' using errcode = '42501';
  end if;
  update public.projects set stage_gates = p_on where id = p_project;
  perform public.worker_audit(p_project, case when p_on then 'stage.gates_on' else 'stage.gates_off' end, 'project', p_project, '{}');
end;
$$;

-- Move a task to another stage while its plan is still a draft.
create function public.set_task_stage(p_task uuid, p_stage public.project_stage) returns void
language plpgsql security definer set search_path = '' as $$
declare
  t public.tasks;
begin
  select * into t from public.tasks where id = p_task;
  if t.id is null or not public.has_project_role(t.project_id, '{owner,engineer}') then
    raise exception 'task not found or not permitted' using errcode = '42501';
  end if;
  if public.plan_status_of_task(p_task) <> 'draft' then
    raise exception 'the plan is %; revise it to change task stages', public.plan_status_of_task(p_task);
  end if;
  update public.tasks set stage = p_stage where id = p_task;
end;
$$;

-- ---------------------------------------------------------------------------
-- Intake and risks
-- ---------------------------------------------------------------------------
create function public.save_intake(p_project uuid, p_intake jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.has_project_role(p_project, '{owner,engineer}') then
    raise exception 'only owners and engineers of the project can edit the intake' using errcode = '42501';
  end if;
  insert into public.project_intake (project_id, intended_use, regions, quantity, target_unit_cost, currency, max_dimensions,
                                     power_source, radios, target_standards, notes, updated_by, updated_at)
  values (p_project, nullif(trim(p_intake ->> 'intended_use'), ''),
          coalesce(array(select trim(x) from jsonb_array_elements_text(p_intake -> 'regions') x where trim(x) <> ''), '{}'),
          nullif(p_intake ->> 'quantity', '')::integer, nullif(p_intake ->> 'target_unit_cost', '')::numeric,
          coalesce(nullif(trim(p_intake ->> 'currency'), ''), 'USD'), nullif(trim(p_intake ->> 'max_dimensions'), ''),
          nullif(trim(p_intake ->> 'power_source'), ''),
          coalesce(array(select trim(x) from jsonb_array_elements_text(p_intake -> 'radios') x where trim(x) <> ''), '{}'),
          coalesce(array(select trim(x) from jsonb_array_elements_text(p_intake -> 'target_standards') x where trim(x) <> ''), '{}'),
          nullif(trim(p_intake ->> 'notes'), ''), auth.uid(), now())
  on conflict (project_id) do update set intended_use = excluded.intended_use, regions = excluded.regions,
    quantity = excluded.quantity, target_unit_cost = excluded.target_unit_cost, currency = excluded.currency,
    max_dimensions = excluded.max_dimensions, power_source = excluded.power_source, radios = excluded.radios,
    target_standards = excluded.target_standards, notes = excluded.notes, updated_by = excluded.updated_by, updated_at = now();
  perform public.worker_audit(p_project, 'intake.saved', 'project', p_project, '{}');
end;
$$;

create function public.add_risk(p_project uuid, p_title text, p_category text, p_stage public.project_stage,
                                p_likelihood integer, p_impact integer, p_description text default null,
                                p_mitigation text default null, p_requirement_refs text[] default '{}') returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  v_no integer;
begin
  if not public.has_project_role(p_project, '{owner,engineer,reviewer}') then
    raise exception 'only owners, engineers and reviewers of the project can add risks' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtext('risks:' || p_project::text));
  select coalesce(max(risk_no), 0) + 1 into v_no from public.risks where project_id = p_project;
  insert into public.risks (project_id, risk_no, title, description, category, stage, likelihood, impact, mitigation, requirement_refs)
  values (p_project, v_no, trim(p_title), nullif(trim(p_description), ''), p_category, p_stage, p_likelihood, p_impact,
          nullif(trim(p_mitigation), ''), coalesce(p_requirement_refs, '{}'))
  returning id into v_id;
  perform public.worker_audit(p_project, 'risk.added', 'risk', v_id, jsonb_build_object('risk_no', v_no, 'title', p_title));
  return v_id;
end;
$$;

-- Rescore, update the mitigation, or change status. Accepting a high or critical risk is the owner's call, with a note.
create function public.update_risk(p_risk uuid, p_status text, p_likelihood integer default null, p_impact integer default null,
                                   p_mitigation text default null, p_stage public.project_stage default null,
                                   p_note text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  r public.risks;
  v_level public.risk_level;
begin
  select * into r from public.risks where id = p_risk for update;
  if r.id is null or not public.has_project_role(r.project_id, '{owner,engineer,reviewer}') then
    raise exception 'risk not found or not permitted' using errcode = '42501';
  end if;
  if p_status not in ('open', 'mitigating', 'accepted', 'closed') then raise exception 'unknown risk status %', p_status; end if;
  v_level := case when coalesce(p_likelihood, r.likelihood) * coalesce(p_impact, r.impact) >= 20 then 'critical'
                  when coalesce(p_likelihood, r.likelihood) * coalesce(p_impact, r.impact) >= 10 then 'high'
                  when coalesce(p_likelihood, r.likelihood) * coalesce(p_impact, r.impact) >= 5 then 'medium' else 'low' end;
  if p_status in ('accepted', 'closed') and coalesce(trim(p_note), '') = '' then
    raise exception 'say why the risk is %', p_status;
  end if;
  if p_status = 'accepted' and v_level in ('high', 'critical') and not public.has_project_role(r.project_id, '{owner}') then
    raise exception 'only the project owner can accept a % risk', v_level using errcode = '42501';
  end if;
  update public.risks set status = p_status, likelihood = coalesce(p_likelihood, likelihood), impact = coalesce(p_impact, impact),
         mitigation = coalesce(nullif(trim(p_mitigation), ''), mitigation), stage = coalesce(p_stage, stage),
         decision_note = case when p_status in ('accepted', 'closed') then trim(p_note) else coalesce(nullif(trim(p_note), ''), decision_note) end,
         decided_by = case when p_status in ('accepted', 'closed') then auth.uid() else decided_by end, updated_at = now()
   where id = p_risk;
  perform public.worker_audit(r.project_id, 'risk.' || p_status, 'risk', p_risk,
    jsonb_build_object('risk_no', r.risk_no, 'from', r.status, 'level', v_level, 'note', p_note));
end;
$$;

-- File the feasibility check's findings ([{rule_key, title, description, category, stage, likelihood, impact,
-- mitigation, requirement_refs, evidence}]) and intake gaps. New findings become risks; known ones keep people's
-- scoring and status but get fresh evidence (and reopen if they were closed as no longer detected); open findings
-- no longer detected are closed.
create function public.record_feasibility(p_project uuid, p_findings jsonb, p_gaps jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  f jsonb;
  v_no integer;
  v_added integer := 0;
  v_updated integer := 0;
  v_closed integer := 0;
  v_keys text[] := array(select x ->> 'rule_key' from jsonb_array_elements(p_findings) x);
begin
  if not public.has_project_role(p_project, '{owner,engineer}') then
    raise exception 'only owners and engineers of the project can run the feasibility check' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtext('risks:' || p_project::text));
  for f in select * from jsonb_array_elements(p_findings) loop
    update public.risks set evidence = coalesce(f -> 'evidence', '[]'::jsonb),
           requirement_refs = coalesce(array(select jsonb_array_elements_text(f -> 'requirement_refs')), '{}'),
           status = case when status = 'closed' and decision_note = 'no longer detected by the feasibility check' then 'open' else status end,
           decision_note = case when status = 'closed' and decision_note = 'no longer detected by the feasibility check' then null else decision_note end,
           updated_at = now()
     where project_id = p_project and rule_key = f ->> 'rule_key';
    if found then
      v_updated := v_updated + 1;
    else
      select coalesce(max(risk_no), 0) + 1 into v_no from public.risks where project_id = p_project;
      insert into public.risks (project_id, risk_no, title, description, category, stage, likelihood, impact, mitigation,
                                requirement_refs, source, rule_key, evidence, created_by)
      values (p_project, v_no, f ->> 'title', f ->> 'description', f ->> 'category', (f ->> 'stage')::public.project_stage,
              (f ->> 'likelihood')::integer, (f ->> 'impact')::integer, f ->> 'mitigation',
              coalesce(array(select jsonb_array_elements_text(f -> 'requirement_refs')), '{}'), 'feasibility', f ->> 'rule_key',
              coalesce(f -> 'evidence', '[]'::jsonb), auth.uid());
      v_added := v_added + 1;
    end if;
  end loop;
  update public.risks set status = 'closed', decision_note = 'no longer detected by the feasibility check', updated_at = now()
   where project_id = p_project and source = 'feasibility' and status in ('open', 'mitigating')
     and not (rule_key = any (v_keys));
  get diagnostics v_closed = row_count;
  insert into public.project_intake (project_id, feasibility_checked_at, feasibility_gaps, updated_by)
  values (p_project, now(), coalesce(p_gaps, '[]'::jsonb), auth.uid())
  on conflict (project_id) do update set feasibility_checked_at = now(), feasibility_gaps = coalesce(p_gaps, '[]'::jsonb);
  perform public.worker_audit(p_project, 'feasibility.checked', 'project', p_project,
    jsonb_build_object('added', v_added, 'refreshed', v_updated, 'closed', v_closed, 'gaps', jsonb_array_length(coalesce(p_gaps, '[]'::jsonb))));
  return jsonb_build_object('added', v_added, 'refreshed', v_updated, 'closed', v_closed);
end;
$$;

revoke all on function public.stage_for_discipline(public.discipline), public.default_task_stage(),
  public.stage_unlocked(uuid, public.project_stage), public.stage_blockers(uuid, public.project_stage) from public, anon, authenticated;
grant execute on function public.stage_for_discipline(public.discipline) to authenticated, service_role;
grant execute on function public.stage_unlocked(uuid, public.project_stage), public.stage_blockers(uuid, public.project_stage) to service_role;
revoke all on function public.stage_status(uuid), public.sign_off_stage(uuid, public.project_stage, text, boolean),
  public.reopen_stage(uuid, public.project_stage, text), public.set_stage_gates(uuid, boolean),
  public.set_task_stage(uuid, public.project_stage), public.save_intake(uuid, jsonb),
  public.add_risk(uuid, text, text, public.project_stage, integer, integer, text, text, text[]),
  public.update_risk(uuid, text, integer, integer, text, public.project_stage, text),
  public.record_feasibility(uuid, jsonb, jsonb) from public, anon;
grant execute on function public.stage_status(uuid), public.sign_off_stage(uuid, public.project_stage, text, boolean),
  public.reopen_stage(uuid, public.project_stage, text), public.set_stage_gates(uuid, boolean),
  public.set_task_stage(uuid, public.project_stage), public.save_intake(uuid, jsonb),
  public.add_risk(uuid, text, text, public.project_stage, integer, integer, text, text, text[]),
  public.update_risk(uuid, text, integer, integer, text, public.project_stage, text),
  public.record_feasibility(uuid, jsonb, jsonb) to authenticated, service_role;
