-- Restarting a run moves the replaced run's steps in progress over to it, so every step that is being worked on
-- belongs to the one run that is going (and is counted and billed there). The replaced run says so.

create or replace function public.restart_run(p_run uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare
  r public.runs;
  o public.runs;
  n integer;
  stopped text[] := '{}';
begin
  select * into r from public.runs where id = p_run for update;
  if r.id is null or not public.has_project_role(r.project_id, '{owner,engineer}') then
    raise exception 'run not found or not permitted' using errcode = '42501';
  end if;
  if r.status in ('pending', 'running', 'paused') then return 'already going'; end if;
  if r.status in ('canceled', 'failed') then raise exception 'a % run cannot be restarted: start a new one', r.status; end if;
  n := public.run_number(p_run);
  for o in select * from public.runs where plan_id = r.plan_id and id <> r.id and status in ('pending', 'running', 'paused') for update loop
    update public.runs set status = 'canceled', paused_at = null, finished_at = now(),
           stop_reason = format('Replaced by Run %s (only one run of a plan works at a time). Its finished work is kept and its steps in progress moved to Run %s.', n, n)
     where id = o.id;
    -- Steps that run was in the middle of carry on as this run's work (their progress and cost move with them),
    -- instead of finishing under a run that no longer exists.
    update public.executions set run_id = r.id where run_id = o.id and status = 'running';
    perform public.worker_audit(o.project_id, 'run.cancel', 'run', o.id,
                                jsonb_build_object('from', o.status, 'to', 'canceled', 'because_restarted', p_run));
    stopped := stopped || format('Run %s', public.run_number(o.id));
  end loop;
  perform public.continue_run(p_run, 0, coalesce((r.stop_conditions ->> 'auto_approve')::boolean, false), true, false, null);
  return case when cardinality(stopped) > 0 then array_to_string(stopped, ', ') else '' end;
end;
$$;

-- The two layout steps still working under the replaced run of plan v7 move to the run that replaced it.
update public.executions e set run_id = '767bf8e0-d620-455f-a1aa-0b6f55f2ecdc'
 where e.run_id = '50e5a637-ab00-413d-8589-c779d6e24087' and e.status = 'running'
   and exists (select 1 from public.runs w where w.id = '767bf8e0-d620-455f-a1aa-0b6f55f2ecdc' and w.status = 'running');
update public.runs c set stop_reason = replace(replace(c.stop_reason, 'Stopped because Run', 'Replaced by Run'), ' was restarted instead (only one run of a plan works at a time). Its finished work is kept.', ' (only one run of a plan works at a time). Its finished work is kept and its steps in progress moved to Run ' || substring(c.stop_reason from 'Run ([0-9]+)') || '.')
 where c.id = '50e5a637-ab00-413d-8589-c779d6e24087' and c.stop_reason like 'Stopped because Run % was restarted instead%';
