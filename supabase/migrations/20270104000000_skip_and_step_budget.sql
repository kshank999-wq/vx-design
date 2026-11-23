-- Moving past a step that cannot finish now, without stopping the whole run:
--   - skip_step: the owner or an engineer marks the step done without its result ("skipped"), with a reason, so the
--     steps after it can run (they get no output from it). It is recorded as a warning check, audited, and can be
--     undone by trying the step again (retry_step works on a skipped step too).
--   - set_step_budget: a step's own AI spending limit, raised without revising the plan (the plan's per-task budget
--     stays as approved; the worker uses the higher of the two).
alter table public.tasks add column skipped_at timestamptz, add column skipped_note text, add column budget_override_usd numeric(12, 4)
  check (budget_override_usd is null or budget_override_usd > 0);

create function public.skip_step(p_task uuid, p_note text) returns void
language plpgsql security definer set search_path = '' as $$
declare t public.tasks;
begin
  select * into t from public.tasks where id = p_task for update;
  if t.id is null or not public.has_project_role(t.project_id, '{owner,engineer}') then raise exception 'step not found or not permitted' using errcode = '42501'; end if;
  if t.status not in ('failed', 'blocked', 'ready', 'draft') then raise exception 'a % step cannot be skipped', t.status; end if;
  if t.status in ('failed', 'blocked') then update public.tasks set status = 'ready' where id = t.id; end if;
  perform set_config('vx.task_reuse', 'on', true);
  update public.tasks set status = 'complete', skipped_at = now(), skipped_note = nullif(trim(coalesce(p_note, '')), ''),
         deferred_at = null, deferred_note = null, blocker_reason = null where id = t.id;
  perform set_config('vx.task_reuse', '', true);
  insert into public.validations (project_id, task_id, kind, result, evidence_category, summary)
  values (t.project_id, t.id, 'other', 'warning', 'unverified_assumption',
          'Skipped by the project owner/team: the steps after it run without its result.' || coalesce(' Reason: ' || nullif(trim(p_note), ''), ''));
  insert into public.audit_events (project_id, actor_id, actor_type, event_type, entity_type, entity_id, payload)
  values (t.project_id, auth.uid(), 'user', 'task.skipped', 'task', t.id, jsonb_build_object('note', p_note));
end;
$$;

create function public.set_step_budget(p_task uuid, p_usd numeric) returns void
language plpgsql security definer set search_path = '' as $$
declare t public.tasks;
begin
  select * into t from public.tasks where id = p_task;
  if t.id is null or not public.has_project_role(t.project_id, '{owner,engineer}') then raise exception 'step not found or not permitted' using errcode = '42501'; end if;
  if p_usd is null or p_usd <= 0 or p_usd > 1000 then raise exception 'the limit must be between $0 and $1000'; end if;
  update public.tasks set budget_override_usd = p_usd where id = t.id;
  insert into public.audit_events (project_id, actor_id, actor_type, event_type, entity_type, entity_id, payload)
  values (t.project_id, auth.uid(), 'user', 'task.budget_set', 'task', t.id, jsonb_build_object('usd', p_usd));
end;
$$;

-- Trying a skipped step again brings it back.
create or replace function public.retry_step(p_task uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare t public.tasks;
begin
  select * into t from public.tasks where id = p_task for update;
  if t.id is null or not public.has_project_role(t.project_id, '{owner,engineer}') then raise exception 'step not found or not permitted' using errcode = '42501'; end if;
  if t.status = 'complete' and t.skipped_at is not null then
    perform set_config('vx.task_reuse', 'on', true);
    update public.tasks set status = 'ready', skipped_at = null, skipped_note = null, retry_base = attempts, interruptions = 0 where id = t.id;
    perform set_config('vx.task_reuse', '', true);
  elsif t.status = 'failed' or (t.status = 'blocked' and t.blocker_reason like 'interrupted %') then
    update public.tasks set status = 'ready', deferred_at = null, deferred_note = null, deferred_by = null where id = t.id;
  else
    raise exception 'only a step that could not finish (or was skipped) can be tried again';
  end if;
  insert into public.audit_events (project_id, actor_id, actor_type, event_type, entity_type, entity_id, payload)
  values (t.project_id, auth.uid(), 'user', 'task.retried', 'task', t.id, '{}');
end;
$$;

revoke all on function public.skip_step(uuid, text), public.set_step_budget(uuid, numeric) from public, anon;
grant execute on function public.skip_step(uuid, text), public.set_step_budget(uuid, numeric) to authenticated;
