-- G3: run_progress also reports which disciplines the claimable tasks need, so a worker can
-- end a run (with its report) when nothing left can be done by any online worker.
create or replace function public.run_progress(p_run_id uuid) returns jsonb
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
           'total', count(*),
           'claimable_disciplines', coalesce(to_jsonb(array_agg(distinct t.discipline::text)
                                      filter (where public.task_claimable(t, v_run))), '[]'::jsonb))
    into v_result
    from public.tasks t where public.task_in_run_scope(t, v_run);
  return v_result || jsonb_build_object(
    'by_status', coalesce((select jsonb_object_agg(s, n) from (
        select t.status as s, count(*) as n from public.tasks t
         where public.task_in_run_scope(t, v_run) group by t.status) x), '{}'::jsonb),
    'live_executions', (select count(*) from public.executions e where e.run_id = p_run_id and e.status = 'running'));
end;
$$;
