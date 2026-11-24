-- Runs are numbered within their project (Run 1, Run 2, ...) so people can tell them apart, and "Restart this run"
-- is one step in the database: any other run of the same plan that is going is stopped with a reason that names the
-- run that took over, then this run continues where it stopped.

create or replace function public.run_number(p_run uuid) returns integer
language sql stable security definer set search_path = '' as $$
  select count(*)::integer from public.runs o, public.runs r
   where r.id = p_run and o.project_id = r.project_id and o.created_at <= r.created_at
     and public.is_project_member(r.project_id);
$$;
revoke all on function public.run_number(uuid) from public, anon;
grant execute on function public.run_number(uuid) to authenticated;

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
           stop_reason = format('Stopped because Run %s was restarted instead (only one run of a plan works at a time). Its finished work is kept.', n)
     where id = o.id;
    perform public.worker_audit(o.project_id, 'run.cancel', 'run', o.id,
                                jsonb_build_object('from', o.status, 'to', 'canceled', 'because_restarted', p_run));
    stopped := stopped || format('Run %s', public.run_number(o.id));
  end loop;
  perform public.continue_run(p_run, 0, coalesce((r.stop_conditions ->> 'auto_approve')::boolean, false), true, false, null);
  return case when cardinality(stopped) > 0 then array_to_string(stopped, ', ') else '' end;
end;
$$;
revoke all on function public.restart_run(uuid) from public, anon;
grant execute on function public.restart_run(uuid) to authenticated;

-- The run that took over earlier today was stopped as "canceled by user"; say what really happened.
update public.runs c set stop_reason = format('Stopped because Run %s was restarted instead (only one run of a plan works at a time). Its finished work is kept.',
       (select count(*) from public.runs o, public.runs w where w.id = '767bf8e0-d620-455f-a1aa-0b6f55f2ecdc' and o.project_id = w.project_id and o.created_at <= w.created_at))
 where c.id = '50e5a637-ab00-413d-8589-c779d6e24087' and c.status = 'canceled' and c.stop_reason = 'canceled by user';
