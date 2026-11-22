-- Continuing a stopped run also clears what stopped it, so one click gets the work going again:
--   - failed tasks go back to the queue with a fresh retry allowance (p_retry_failed, default on);
--   - the compute budget can be raised with the AI budget (p_compute);
--   - critical-risk tasks join the run's scope when the owner asks (p_include_critical; owners only, as when authorizing).
drop function public.continue_run(uuid, numeric, boolean);
create function public.continue_run(p_run uuid, p_ai numeric, p_auto_approve boolean,
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
    update public.tasks set status = 'ready' where plan_id = r.plan_id and status = 'failed';
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
revoke all on function public.continue_run(uuid, numeric, boolean, boolean, boolean, numeric) from public, anon;
grant execute on function public.continue_run(uuid, numeric, boolean, boolean, boolean, numeric) to authenticated;
