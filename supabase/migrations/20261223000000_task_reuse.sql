-- Reuse of unchanged work across plan versions (incremental recomputation).
--
-- When a plan is approved, every task gets a fingerprint: a SHA-256 over what decides its result (discipline, title,
-- description, acceptance tests, tools, board, basis, risk and approval policy, the exact text, kind, priority, status
-- and criteria of its linked requirements) and over the fingerprints of the tasks it depends on. A change anywhere
-- upstream therefore changes every fingerprint below it.
--
-- A task whose fingerprint equals that of a task finished in an earlier plan of the project takes that work over:
-- the earlier committed outputs are linked as its outputs, its checks are copied with "Reused from vN" in front, and
-- it is complete without running (tasks.reused_from_task_id says from where). Nothing is presented as newly checked.
-- Sourcing is reused only within 7 days (prices and stock move). redo_task undoes a reuse: the task and everything
-- downstream of it that was reused go back to ready and run again.

alter table public.tasks
  add column fingerprint text,
  add column reused_from_task_id uuid references public.tasks (id) on delete set null;
create index if not exists tasks_project_fingerprint_idx on public.tasks (project_id, fingerprint) where fingerprint is not null;

-- Reuse and redo move tasks straight to complete (or back to ready); only these functions may, under a flag they
-- set for their own transaction.
create or replace function public.task_transition_allowed(p_from public.task_status, p_to public.task_status)
returns boolean language sql stable as $$
  select case p_from
    when 'draft'             then p_to in ('ready', 'canceled', 'superseded')
    when 'ready'             then p_to in ('running', 'blocked', 'canceled', 'superseded')
    when 'running'           then p_to in ('validating', 'failed', 'blocked', 'canceled', 'ready')
    when 'validating'        then p_to in ('awaiting_approval', 'complete', 'failed', 'blocked', 'ready')
    when 'awaiting_approval' then p_to in ('complete', 'ready', 'blocked', 'canceled')
    when 'blocked'           then p_to in ('ready', 'canceled', 'superseded')
    when 'failed'            then p_to in ('ready', 'canceled', 'superseded')
    when 'complete'          then p_to in ('superseded')
    else false
  end
  or (coalesce(current_setting('vx.task_reuse', true), '') = 'on'
      and ((p_from in ('draft', 'ready') and p_to = 'complete') or (p_from = 'complete' and p_to = 'ready')));
$$;

create function public.compute_plan_fingerprints(p_plan_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare t record;
begin
  for t in select * from public.tasks where plan_id = p_plan_id order by position loop
    update public.tasks set fingerprint = encode(sha256(convert_to(jsonb_build_object(
        'v', 1,
        'discipline', t.discipline, 'title', t.title, 'description', coalesce(t.description, ''),
        'acceptance_tests', coalesce(t.acceptance_tests, '[]'::jsonb), 'required_tools', to_jsonb(coalesce(t.required_tools, '{}')),
        'board', t.board, 'basis', t.basis, 'risk', t.risk_level, 'approval', t.approval_policy,
        'requirements', (select coalesce(jsonb_agg(jsonb_build_array(r.ref_code, r.kind, r.priority, r.status, r.text, r.acceptance_criteria)
                                                   order by r.ref_code), '[]'::jsonb)
                           from public.task_requirements tr join public.requirements r on r.id = tr.requirement_id where tr.task_id = t.id),
        'upstream', (select coalesce(jsonb_agg(u.fingerprint order by u.fingerprint), '[]'::jsonb)
                       from public.task_dependencies d join public.tasks u on u.id = d.depends_on_task_id where d.task_id = t.id)
      )::text, 'UTF8')), 'hex')
     where id = t.id;
  end loop;
end;
$$;

-- Takes over finished, unchanged work from earlier plans. Returns how many tasks were reused.
create function public.reuse_unchanged_tasks(p_plan_id uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  t record;
  o record;
  n integer := 0;
begin
  perform public.compute_plan_fingerprints(p_plan_id);
  perform set_config('vx.task_reuse', 'on', true);
  for t in select * from public.tasks where plan_id = p_plan_id and status in ('draft', 'ready') order by position loop
    select ot.*, p.version as plan_version into o
      from public.tasks ot join public.plans p on p.id = ot.plan_id
     where ot.project_id = t.project_id and ot.plan_id <> t.plan_id and ot.fingerprint = t.fingerprint
       and ot.completed_at is not null and ot.status in ('complete', 'superseded')
       and (ot.discipline <> 'sourcing' or ot.completed_at > now() - interval '7 days')
       and exists (select 1 from public.task_artifacts ta join public.artifact_versions av on av.id = ta.artifact_version_id
                    where ta.task_id = ot.id and ta.role = 'output' and av.status = 'committed')
     order by ot.completed_at desc limit 1;
    if o.id is null then continue; end if;
    insert into public.task_artifacts (task_id, artifact_version_id, role)
    select t.id, ta.artifact_version_id, 'output' from public.task_artifacts ta join public.artifact_versions av on av.id = ta.artifact_version_id
     where ta.task_id = o.id and ta.role = 'output' and av.status = 'committed'
    on conflict do nothing;
    insert into public.validations (project_id, task_id, artifact_version_id, kind, result, evidence_category, summary, details, report_path, tool_name, tool_version)
    select v.project_id, t.id, v.artifact_version_id, v.kind, v.result, v.evidence_category,
           format('Reused from v%s (%s, unchanged): %s', o.plan_version, o.key, v.summary),
           v.details || jsonb_build_object('reused_from_task', o.id, 'reused_from_plan_version', o.plan_version),
           v.report_path, v.tool_name, v.tool_version
      from public.validations v
     where v.task_id = o.id
       and v.execution_id is not distinct from (select v2.execution_id from public.validations v2 where v2.task_id = o.id order by v2.created_at desc limit 1);
    update public.tasks set status = 'complete', completed_at = now(), reused_from_task_id = o.id, stage = coalesce(o.stage, stage)
     where id = t.id;
    n := n + 1;
  end loop;
  perform set_config('vx.task_reuse', '', true);
  if n > 0 then
    insert into public.audit_events (project_id, actor_id, actor_type, event_type, entity_type, entity_id, payload)
    select project_id, auth.uid(), (case when auth.uid() is null then 'system' else 'user' end)::public.actor_type, 'plan.reused_unchanged', 'plan', id,
           jsonb_build_object('tasks', n) from public.plans where id = p_plan_id;
  end if;
  return n;
end;
$$;

create function public.reuse_on_approval() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'approved' and old.status is distinct from 'approved' then
    perform public.reuse_unchanged_tasks(new.id);
  end if;
  return null;
end;
$$;
create trigger plans_reuse_on_approval after update of status on public.plans for each row execute function public.reuse_on_approval();

-- "Do again": a reused task, and every reused task downstream of it, runs afresh.
create function public.redo_task(p_task_id uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_task public.tasks;
  n integer;
begin
  select * into v_task from public.tasks where id = p_task_id;
  if v_task.id is null or not public.has_project_role(v_task.project_id, '{owner,engineer}') then
    raise exception 'task not found or not permitted';
  end if;
  if v_task.reused_from_task_id is null then raise exception 'only reused tasks can be done again this way'; end if;
  perform set_config('vx.task_reuse', 'on', true);
  with recursive down(id) as (
    select p_task_id
    union select d.task_id from public.task_dependencies d join down on d.depends_on_task_id = down.id
  ), reset as (
    select t.id from public.tasks t join down using (id) where t.reused_from_task_id is not null
  ), unlink as (
    delete from public.task_artifacts ta using reset where ta.task_id = reset.id and ta.role = 'output'
  ), unval as (
    delete from public.validations v using reset where v.task_id = reset.id and v.execution_id is null
  )
  update public.tasks t set status = 'ready', completed_at = null, reused_from_task_id = null from reset where t.id = reset.id;
  get diagnostics n = row_count;
  perform set_config('vx.task_reuse', '', true);
  insert into public.audit_events (project_id, actor_id, actor_type, event_type, entity_type, entity_id, payload)
  values (v_task.project_id, auth.uid(), 'user', 'task.redo', 'task', p_task_id, jsonb_build_object('tasks', n));
  return n;
end;
$$;

revoke all on function public.compute_plan_fingerprints(uuid), public.reuse_unchanged_tasks(uuid), public.reuse_on_approval() from public, anon, authenticated;
grant execute on function public.compute_plan_fingerprints(uuid), public.reuse_unchanged_tasks(uuid) to service_role;
revoke all on function public.redo_task(uuid) from public, anon;
grant execute on function public.redo_task(uuid) to authenticated;
