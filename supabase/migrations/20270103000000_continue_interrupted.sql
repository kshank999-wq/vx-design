-- Resolving what stopped a run, step by step:
--   - continuing a run also puts back steps that were blocked only because their worker kept being stopped (a worker
--     update or restart mid-step), not because of anything in the work itself;
--   - one step can be tried again on its own (retry_step), or saved for later (defer_step, with a note) so continuing
--     leaves it alone until it is brought back (undefer_step).
alter table public.tasks add column deferred_at timestamptz, add column deferred_note text, add column deferred_by uuid references auth.users (id) on delete set null;

create function public.retry_step(p_task uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare t public.tasks;
begin
  select * into t from public.tasks where id = p_task for update;
  if t.id is null or not public.has_project_role(t.project_id, '{owner,engineer}') then raise exception 'step not found or not permitted' using errcode = '42501'; end if;
  if not (t.status = 'failed' or (t.status = 'blocked' and t.blocker_reason like 'interrupted %')) then
    raise exception 'only a step that could not finish can be tried again';
  end if;
  update public.tasks set status = 'ready', deferred_at = null, deferred_note = null, deferred_by = null where id = t.id;
  insert into public.audit_events (project_id, actor_id, actor_type, event_type, entity_type, entity_id, payload)
  values (t.project_id, auth.uid(), 'user', 'task.retried', 'task', t.id, '{}');
end;
$$;

create function public.defer_step(p_task uuid, p_note text) returns void
language plpgsql security definer set search_path = '' as $$
declare t public.tasks;
begin
  select * into t from public.tasks where id = p_task for update;
  if t.id is null or not public.has_project_role(t.project_id, '{owner,engineer}') then raise exception 'step not found or not permitted' using errcode = '42501'; end if;
  update public.tasks set deferred_at = now(), deferred_note = nullif(trim(coalesce(p_note, '')), ''), deferred_by = auth.uid() where id = t.id;
  insert into public.audit_events (project_id, actor_id, actor_type, event_type, entity_type, entity_id, payload)
  values (t.project_id, auth.uid(), 'user', 'task.deferred', 'task', t.id, jsonb_build_object('note', p_note));
end;
$$;

create function public.undefer_step(p_task uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare t public.tasks;
begin
  select * into t from public.tasks where id = p_task for update;
  if t.id is null or not public.has_project_role(t.project_id, '{owner,engineer}') then raise exception 'step not found or not permitted' using errcode = '42501'; end if;
  update public.tasks set deferred_at = null, deferred_note = null, deferred_by = null where id = t.id;
  insert into public.audit_events (project_id, actor_id, actor_type, event_type, entity_type, entity_id, payload)
  values (t.project_id, auth.uid(), 'user', 'task.undeferred', 'task', t.id, '{}');
end;
$$;
revoke all on function public.retry_step(uuid), public.defer_step(uuid, text), public.undefer_step(uuid) from public, anon;
grant execute on function public.retry_step(uuid), public.defer_step(uuid, text), public.undefer_step(uuid) to authenticated;

create or replace function public.continue_run(p_run uuid, p_ai numeric, p_auto_approve boolean,
                                    p_retry_failed boolean default true, p_include_critical boolean default false,
                                    p_compute numeric default null) returns text
language plpgsql security definer set search_path = '' as $$
declare
  r public.runs;
  t record;
  n integer := 0;
  v_retried integer := 0;
begin
  select * into r from public.runs where id = p_run for update;
  if r.id is null or not public.has_project_role(r.project_id, '{owner,engineer}') then raise exception 'run not found or not permitted'; end if;
  if r.status in ('canceled', 'failed') then raise exception 'a % run cannot be continued: start a new one', r.status; end if;
  if exists (select 1 from public.runs o where o.plan_id = r.plan_id and o.id <> r.id and o.status in ('pending', 'running', 'paused')) then
    raise exception 'another run of this plan is active';
  end if;
  if (select status from public.plans where id = r.plan_id) <> 'approved' then raise exception 'the plan is no longer the approved baseline'; end if;
  if p_include_critical and not public.has_project_role(r.project_id, '{owner}') then
    raise exception 'only the project owner can authorize critical-risk tasks';
  end if;
  if p_auto_approve then
    for t in select id from public.tasks where plan_id = r.plan_id and status = 'awaiting_approval' loop
      perform public.decide_task(t.id, true, 'Approved: every VX Design check passed (continued as an overnight run).');
      n := n + 1;
    end loop;
  end if;
  if coalesce(p_retry_failed, true) then
    -- The status trigger gives each a fresh retry allowance and clears the blocker.
    -- Failed steps, and steps blocked only because their worker kept being stopped (updates, restarts).
    update public.tasks set status = 'ready' where plan_id = r.plan_id
       and deferred_at is null
       and (status = 'failed' or (status = 'blocked' and blocker_reason like 'interrupted %'));
    get diagnostics v_retried = row_count;
  end if;
  update public.runs set status = 'running', stop_reason = null, finished_at = null, report = null, paused_at = null,
         max_ai_spend_usd = greatest(max_ai_spend_usd, coalesce(p_ai, 0)),
         max_compute_spend_usd = greatest(max_compute_spend_usd, coalesce(p_compute, 0)),
         allowed_risk_levels = case when p_include_critical and not ('critical' = any (allowed_risk_levels))
                                    then allowed_risk_levels || 'critical'::public.risk_level else allowed_risk_levels end,
         stop_conditions = stop_conditions || jsonb_build_object('auto_approve', coalesce(p_auto_approve, false)),
         started_by = case when p_auto_approve then auth.uid() else started_by end
   where id = r.id;
  insert into public.audit_events (project_id, actor_id, actor_type, event_type, entity_type, entity_id, payload)
  values (r.project_id, auth.uid(), 'user', 'run.continued', 'run', r.id,
          jsonb_build_object('ai_usd', greatest(r.max_ai_spend_usd, coalesce(p_ai, 0)), 'auto_approve', p_auto_approve, 'approved_waiting', n,
                             'retried_failed', v_retried, 'include_critical', coalesce(p_include_critical, false)));
  return format('%s', n);
end;
$$;
