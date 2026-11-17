-- G1: specification intake, requirement extraction, versioned plans and approval.
--
-- Plans are created atomically from a validated payload, edited only while in draft,
-- frozen on approval, and revised by copying into a new draft version.

-- ---------------------------------------------------------------------------
-- Documents: parsed structure and extraction report
-- ---------------------------------------------------------------------------

alter table public.documents
  add column filename          text,
  add column parsed            jsonb,                 -- sections/blocks with stable ids (citation targets)
  add column extraction_status text not null default 'pending'
    check (extraction_status in ('pending', 'running', 'done', 'failed')),
  add column extraction_report jsonb;                 -- prompt version, model, dropped citations, open questions, usage

-- ---------------------------------------------------------------------------
-- Requirements: priority, exact citation target, review notes
-- ---------------------------------------------------------------------------

alter table public.requirements
  add column priority text not null default 'must' check (priority in ('must', 'should', 'may')),
  add column block_id text,
  add column notes    text,
  add column origin   text not null default 'extracted' check (origin in ('extracted', 'manual'));

-- ---------------------------------------------------------------------------
-- Plans and tasks: generation metadata and approval policy
-- ---------------------------------------------------------------------------

alter table public.plans
  add column generator   jsonb not null default '{}'::jsonb,  -- model, prompt version, attempts, adjustments
  add column assumptions jsonb not null default '[]'::jsonb,
  add column deferred    jsonb not null default '[]'::jsonb,  -- [{ref, reason}]
  add column revised_from_id uuid references public.plans (id);

alter table public.tasks
  add column estimated_hours numeric(8, 2) check (estimated_hours >= 0),
  -- Display/execution order within the plan (dependency order). Tasks of one plan are
  -- inserted in a single transaction, so created_at cannot order them.
  add column position integer not null default 0;
create index tasks_plan_position_idx on public.tasks (plan_id, position);

create table public.task_requirements (
  task_id        uuid not null references public.tasks (id) on delete cascade,
  requirement_id uuid not null references public.requirements (id) on delete cascade,
  primary key (task_id, requirement_id)
);
create index task_requirements_requirement_idx on public.task_requirements (requirement_id);

alter table public.task_requirements enable row level security;
create policy "members read task requirements" on public.task_requirements for select to authenticated
  using (exists (select 1 from public.tasks t where t.id = task_id and public.is_project_member(t.project_id)));
create policy "engineers write task requirements" on public.task_requirements for all to authenticated
  using (exists (select 1 from public.tasks t where t.id = task_id
                 and public.has_project_role(t.project_id, '{owner,engineer}')))
  with check (exists (select 1 from public.tasks t where t.id = task_id
                      and public.has_project_role(t.project_id, '{owner,engineer}')));

-- ---------------------------------------------------------------------------
-- Edit lock: task definitions change only while their plan is a draft.
-- Execution fields (status, worker, attempts, timestamps, blocker) stay writable.
-- ---------------------------------------------------------------------------

-- Null when the task, plan or project no longer exists (e.g. during a cascading delete).
create function public.plan_status_of_task(p_task_id uuid) returns public.plan_status
language sql stable security definer set search_path = '' as $$
  select p.status from public.tasks t
    join public.plans p on p.id = t.plan_id
    join public.projects pr on pr.id = t.project_id
   where t.id = p_task_id;
$$;

create function public.guard_task_definition() returns trigger
language plpgsql as $$
declare
  v_status public.plan_status;
begin
  select p.status into v_status from public.plans p join public.projects pr on pr.id = p.project_id
   where p.id = case when tg_op = 'INSERT' then new.plan_id else old.plan_id end;
  if v_status is null and tg_op = 'DELETE' then
    return old;  -- cascading delete of the plan or project
  end if;
  -- Tasks become runnable only through plan approval.
  if tg_op <> 'DELETE' and new.status <> 'draft' and v_status is distinct from 'approved'
     and (tg_op = 'INSERT' or old.status = 'draft') then
    raise exception 'tasks leave draft only when their plan is approved';
  end if;
  if v_status = 'draft' then
    return coalesce(new, old);
  end if;
  if tg_op = 'UPDATE'
     and (new.plan_id, new.project_id, new.key, new.title, new.discipline, new.description, new.required_tools,
          new.acceptance_tests, new.approval_policy, new.risk_level, new.max_attempts, new.timeout_seconds,
          new.cost_budget_usd, new.estimated_hours, new.position)
     is not distinct from
         (old.plan_id, old.project_id, old.key, old.title, old.discipline, old.description, old.required_tools,
          old.acceptance_tests, old.approval_policy, old.risk_level, old.max_attempts, old.timeout_seconds,
          old.cost_budget_usd, old.estimated_hours, old.position) then
    return new;  -- execution-only change
  end if;
  raise exception 'plan is %; revise it to change task definitions', v_status;
end;
$$;

create trigger tasks_guard_definition before insert or update or delete on public.tasks
  for each row execute function public.guard_task_definition();

create function public.guard_task_links() returns trigger
language plpgsql as $$
declare
  v_status public.plan_status := public.plan_status_of_task(coalesce(new.task_id, old.task_id));
begin
  -- A task deleted from a draft plan cascades its links; the task row itself was already checked.
  if v_status is null or v_status = 'draft' then
    return coalesce(new, old);
  end if;
  raise exception 'plan is %; revise it to change task links', v_status;
end;
$$;

create trigger task_dependencies_guard before insert or update or delete on public.task_dependencies
  for each row execute function public.guard_task_links();
create trigger task_requirements_guard before insert or update or delete on public.task_requirements
  for each row execute function public.guard_task_links();

-- Plan status and approval fields change only inside the functions below, which set
-- a transaction-local flag. Direct inserts/updates by clients cannot approve a plan.
create function public.guard_plan_status() returns trigger
language plpgsql as $$
begin
  if coalesce(current_setting('vx.plan_transition', true), '') = 'on' then
    return new;
  end if;
  if tg_op = 'INSERT' and (new.status <> 'draft' or new.approved_by is not null or new.approved_at is not null) then
    raise exception 'new plans start as draft';
  end if;
  if tg_op = 'UPDATE' and (new.status, new.approved_by, new.approved_at, new.version, new.project_id)
                          is distinct from (old.status, old.approved_by, old.approved_at, old.version, old.project_id) then
    raise exception 'plan status changes go through submit_plan / decide_plan / revise_plan';
  end if;
  if tg_op = 'UPDATE' and old.status <> 'draft' then
    raise exception 'plan is %; revise it to make changes', old.status;
  end if;
  return new;
end;
$$;

create trigger plans_guard_status before insert or update on public.plans
  for each row execute function public.guard_plan_status();

create function public.begin_plan_transition() returns void
language sql as $$ select set_config('vx.plan_transition', 'on', true); $$;
create function public.end_plan_transition() returns void
language sql as $$ select set_config('vx.plan_transition', '', true); $$;

-- ---------------------------------------------------------------------------
-- create_plan_version: atomically store a validated plan as a new draft.
-- SECURITY DEFINER (writes the audit log) with an explicit owner/engineer check;
-- the service role (workers) may also call it.
-- ---------------------------------------------------------------------------

create function public.create_plan_version(p_project_id uuid, p_payload jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_plan_id uuid;
  v_version integer;
  v_task jsonb;
  v_task_id uuid;
  v_ids jsonb := '{}'::jsonb;
  v_ref text;
  v_req_id uuid;
  v_up text;
  v_pos integer;
  v_order jsonb := '{}'::jsonb;
begin
  if auth.uid() is not null and not public.has_project_role(p_project_id, '{owner,engineer}') then
    raise exception 'not permitted to create plans in this project';
  end if;
  if jsonb_typeof(p_payload -> 'tasks') <> 'array' or jsonb_array_length(p_payload -> 'tasks') = 0 then
    raise exception 'plan payload must contain at least one task';
  end if;

  -- Serialize version numbering per project.
  perform 1 from public.projects where id = p_project_id for update;
  select coalesce(max(version), 0) + 1 into v_version from public.plans where project_id = p_project_id;

  insert into public.plans (project_id, version, status, supervision_mode, summary, generator, assumptions, deferred, revised_from_id)
  values (
    p_project_id, v_version, 'draft',
    coalesce((p_payload ->> 'supervision_mode')::public.supervision_mode, 'guided'),
    p_payload ->> 'summary',
    coalesce(p_payload -> 'generator', '{}'::jsonb),
    coalesce(p_payload -> 'assumptions', '[]'::jsonb),
    coalesce(p_payload -> 'deferred', '[]'::jsonb),
    (p_payload ->> 'revised_from_id')::uuid
  )
  returning id into v_plan_id;

  for v_task, v_pos in select value, ordinality from jsonb_array_elements(p_payload -> 'tasks') with ordinality loop
    if v_ids ? (v_task ->> 'key') then
      raise exception 'duplicate task key %', v_task ->> 'key';
    end if;
    insert into public.tasks (project_id, plan_id, key, title, discipline, description, required_tools,
                              acceptance_tests, approval_policy, risk_level, estimated_hours, status, position)
    values (
      p_project_id, v_plan_id, v_task ->> 'key', v_task ->> 'title',
      (v_task ->> 'discipline')::public.discipline, v_task ->> 'description',
      coalesce(array(select jsonb_array_elements_text(v_task -> 'required_tools')), '{}'),
      coalesce(v_task -> 'acceptance_tests', '[]'::jsonb),
      jsonb_build_object('required', coalesce((v_task ->> 'approval_required')::boolean, false),
                         'reason', v_task ->> 'approval_reason'),
      coalesce((v_task ->> 'risk_level')::public.risk_level, 'medium'),
      (v_task ->> 'estimated_hours')::numeric,
      'draft',
      v_pos
    )
    returning id into v_task_id;
    v_ids := v_ids || jsonb_build_object(v_task ->> 'key', v_task_id);
    v_order := v_order || jsonb_build_object(v_task ->> 'key', v_pos);

    for v_ref in select jsonb_array_elements_text(coalesce(v_task -> 'requirement_refs', '[]'::jsonb)) loop
      select id into v_req_id from public.requirements where project_id = p_project_id and ref_code = v_ref;
      if v_req_id is null then
        raise exception 'task % references unknown requirement %', v_task ->> 'key', v_ref;
      end if;
      insert into public.task_requirements (task_id, requirement_id) values (v_task_id, v_req_id);
    end loop;
  end loop;

  for v_task in select * from jsonb_array_elements(p_payload -> 'tasks') loop
    for v_up in select jsonb_array_elements_text(coalesce(v_task -> 'upstream_keys', '[]'::jsonb)) loop
      if not v_ids ? v_up then
        raise exception 'task % depends on unknown task %', v_task ->> 'key', v_up;
      end if;
      if (v_order ->> v_up)::int >= (v_order ->> (v_task ->> 'key'))::int then
        raise exception 'tasks must be listed in dependency order: % comes before its dependency %', v_task ->> 'key', v_up;
      end if;
      insert into public.task_dependencies (task_id, depends_on_task_id)
      values ((v_ids ->> (v_task ->> 'key'))::uuid, (v_ids ->> v_up)::uuid);
    end loop;
  end loop;

  insert into public.audit_events (project_id, actor_id, actor_type, event_type, entity_type, entity_id, payload)
  values (p_project_id, auth.uid(), 'user', 'plan.created', 'plan', v_plan_id,
          jsonb_build_object('version', v_version, 'tasks', jsonb_array_length(p_payload -> 'tasks')));
  return v_plan_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- submit_plan: draft -> awaiting_approval (engineers); freezes edits for review.
-- ---------------------------------------------------------------------------

create function public.submit_plan(p_plan_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_plan public.plans;
begin
  select * into v_plan from public.plans where id = p_plan_id for update;
  if not found or not public.has_project_role(v_plan.project_id, '{owner,engineer}') then
    raise exception 'plan not found or not permitted';
  end if;
  if v_plan.status <> 'draft' then
    raise exception 'only draft plans can be submitted (plan is %)', v_plan.status;
  end if;
  perform public.begin_plan_transition();
  update public.plans set status = 'awaiting_approval' where id = p_plan_id;
  perform public.end_plan_transition();
  insert into public.approvals (project_id, plan_id, status, reason, requested_by)
  values (v_plan.project_id, p_plan_id, 'pending', 'Plan baseline approval', auth.uid());
  insert into public.audit_events (project_id, actor_id, actor_type, event_type, entity_type, entity_id, payload)
  values (v_plan.project_id, auth.uid(), 'user', 'plan.submitted', 'plan', p_plan_id, '{}'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- decide_plan: owner/reviewer approves or returns a plan awaiting approval.
-- Approval freezes the baseline, supersedes the previous approved plan and
-- makes its tasks runnable (draft -> ready).
-- ---------------------------------------------------------------------------

create function public.decide_plan(p_plan_id uuid, p_approve boolean, p_note text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_plan public.plans;
  v_previous uuid;
begin
  select * into v_plan from public.plans where id = p_plan_id for update;
  if not found or not public.has_project_role(v_plan.project_id, '{owner,reviewer}') then
    raise exception 'plan not found or not permitted';
  end if;
  if v_plan.status <> 'awaiting_approval' then
    raise exception 'only plans awaiting approval can be decided (plan is %)', v_plan.status;
  end if;

  update public.approvals
     set status = case when p_approve then 'approved' else 'rejected' end::public.approval_status,
         responded_by = auth.uid(), responded_at = now(), response_note = p_note
   where plan_id = p_plan_id and status = 'pending';

  perform public.begin_plan_transition();
  if not p_approve then
    update public.plans set status = 'draft' where id = p_plan_id;
    perform public.end_plan_transition();
    insert into public.audit_events (project_id, actor_id, actor_type, event_type, entity_type, entity_id, payload)
    values (v_plan.project_id, auth.uid(), 'user', 'plan.returned', 'plan', p_plan_id, jsonb_build_object('note', p_note));
    return;
  end if;

  select id into v_previous from public.plans
   where project_id = v_plan.project_id and status = 'approved' for update;
  if v_previous is not null then
    if exists (select 1 from public.tasks where plan_id = v_previous and status in ('running', 'validating')) then
      raise exception 'the current baseline has running tasks; wait for them or cancel them first';
    end if;
    update public.tasks set status = 'superseded'
     where plan_id = v_previous and status in ('draft', 'ready', 'blocked', 'failed', 'complete');
    update public.plans set status = 'superseded' where id = v_previous;
  end if;

  update public.plans set status = 'approved', approved_by = auth.uid(), approved_at = now() where id = p_plan_id;
  update public.tasks set status = 'ready' where plan_id = p_plan_id and status = 'draft';
  perform public.end_plan_transition();

  insert into public.audit_events (project_id, actor_id, actor_type, event_type, entity_type, entity_id, payload)
  values (v_plan.project_id, auth.uid(), 'user', 'plan.approved', 'plan', p_plan_id,
          jsonb_build_object('version', v_plan.version, 'superseded_plan_id', v_previous, 'note', p_note));
end;
$$;

-- ---------------------------------------------------------------------------
-- revise_plan: copy a non-draft plan into a new editable draft version.
-- ---------------------------------------------------------------------------

create function public.revise_plan(p_plan_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_plan public.plans;
  v_payload jsonb;
begin
  select * into v_plan from public.plans where id = p_plan_id;
  if not found or (auth.uid() is not null and not public.has_project_role(v_plan.project_id, '{owner,engineer}')) then
    raise exception 'plan not found or not permitted';
  end if;
  select jsonb_build_object(
    'summary', v_plan.summary,
    'supervision_mode', v_plan.supervision_mode,
    'generator', v_plan.generator || jsonb_build_object('revised_from_version', v_plan.version),
    'assumptions', v_plan.assumptions,
    'deferred', v_plan.deferred,
    'revised_from_id', v_plan.id,
    'tasks', coalesce(jsonb_agg(jsonb_build_object(
      'key', t.key, 'title', t.title, 'discipline', t.discipline, 'description', t.description,
      'required_tools', to_jsonb(t.required_tools), 'acceptance_tests', t.acceptance_tests,
      'approval_required', coalesce((t.approval_policy ->> 'required')::boolean, false),
      'approval_reason', t.approval_policy ->> 'reason',
      'risk_level', t.risk_level, 'estimated_hours', t.estimated_hours,
      'upstream_keys', (select coalesce(jsonb_agg(u.key order by u.key), '[]'::jsonb)
                          from public.task_dependencies d join public.tasks u on u.id = d.depends_on_task_id
                         where d.task_id = t.id),
      'requirement_refs', (select coalesce(jsonb_agg(r.ref_code order by r.ref_code), '[]'::jsonb)
                             from public.task_requirements tr join public.requirements r on r.id = tr.requirement_id
                            where tr.task_id = t.id)
    ) order by t.position), '[]'::jsonb))
  into v_payload
  from public.tasks t where t.plan_id = p_plan_id;
  return public.create_plan_version(v_plan.project_id, v_payload);
end;
$$;

revoke execute on function public.begin_plan_transition() from public, anon, authenticated;
revoke execute on function public.end_plan_transition() from public, anon, authenticated;
revoke execute on function public.create_plan_version(uuid, jsonb) from public, anon;
revoke execute on function public.revise_plan(uuid) from public, anon;
grant execute on function public.create_plan_version(uuid, jsonb) to authenticated, service_role;
grant execute on function public.revise_plan(uuid) to authenticated, service_role;
revoke execute on function public.submit_plan(uuid) from public, anon;
revoke execute on function public.decide_plan(uuid, boolean, text) from public, anon;
grant execute on function public.submit_plan(uuid) to authenticated;
grant execute on function public.decide_plan(uuid, boolean, text) to authenticated;
