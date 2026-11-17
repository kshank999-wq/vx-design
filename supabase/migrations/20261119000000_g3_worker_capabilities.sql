-- G3: workers advertise which disciplines they can execute, so a worker without KiCad never
-- claims (and blocks) a schematic task. A registry of recently seen workers lets the app say
-- when no online worker can run part of a plan.

create table public.workers (
  id            text primary key,
  disciplines   text[] not null default '{}',
  tools         jsonb not null default '{}'::jsonb,     -- e.g. {"kicad": "10.0.8", "vx_eng": "0.3.0"}
  started_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now()
);
alter table public.workers enable row level security;
-- Worker names, disciplines and tool versions are not project data; any signed-in user may see them.
create policy "authenticated read workers" on public.workers for select to authenticated using (true);
grant select on public.workers to authenticated;
grant all on public.workers to service_role;

create function public.worker_checkin(p_worker_id text, p_disciplines text[], p_tools jsonb) returns void
language sql security definer set search_path = '' as $$
  insert into public.workers (id, disciplines, tools) values (p_worker_id, p_disciplines, coalesce(p_tools, '{}'))
  on conflict (id) do update set disciplines = excluded.disciplines, tools = excluded.tools, last_seen_at = now();
$$;

drop function public.claim_next_task(text, uuid, integer);

-- As in G2, plus p_disciplines: only tasks of these disciplines are claimed (null = any).
create function public.claim_next_task(p_worker_id text, p_run_id uuid, p_lease_seconds integer default 60,
                                       p_disciplines text[] default null)
returns public.executions
language plpgsql security definer set search_path = '' as $$
declare
  v_run  public.runs;
  v_task public.tasks;
  v_prev public.executions;
  v_exec public.executions;
  v_spend record;
begin
  select * into v_run from public.runs where id = p_run_id;
  if not found or v_run.status <> 'running' then
    return null;
  end if;
  v_spend := public.run_spend(p_run_id);
  if v_spend.ai_usd >= v_run.max_ai_spend_usd or v_spend.compute_usd >= v_run.max_compute_spend_usd then
    return null;
  end if;

  select t.* into v_task
    from public.tasks t
   where t.plan_id = v_run.plan_id and t.status = 'ready'
     and (p_disciplines is null or t.discipline::text = any (p_disciplines))
     and public.task_claimable(t, v_run)
   order by t.position, t.created_at
   for update of t skip locked
   limit 1;
  if not found then
    return null;
  end if;

  v_prev := public.resumable_execution(v_task);

  update public.tasks
     set status = 'running', assigned_worker = p_worker_id,
         attempts = case when v_prev.id is null then attempts + 1 else attempts end
   where id = v_task.id;

  insert into public.executions (project_id, task_id, run_id, attempt, status, worker_id, started_at, heartbeat_at,
                                 lease_seconds, checkpoint, checkpoint_seq, resumed_from_id)
  values (v_task.project_id, v_task.id, p_run_id,
          case when v_prev.id is null then v_task.attempts + 1 else v_task.attempts end,
          'running', p_worker_id, now(), now(), p_lease_seconds,
          v_prev.checkpoint, coalesce(v_prev.checkpoint_seq, 0), v_prev.id)
  returning * into v_exec;

  perform public.worker_audit(v_task.project_id, case when v_prev.id is null then 'execution.started' else 'execution.resumed' end,
                              'execution', v_exec.id, jsonb_build_object('task_id', v_task.id, 'attempt', v_exec.attempt,
                              'worker_id', p_worker_id, 'run_id', p_run_id, 'resumed_from', v_prev.id,
                              'checkpoint_seq', v_exec.checkpoint_seq));
  return v_exec;
end;
$$;

revoke execute on function public.claim_next_task(text, uuid, integer, text[]) from public, anon, authenticated;
grant execute on function public.claim_next_task(text, uuid, integer, text[]) to service_role;
revoke execute on function public.worker_checkin(text, text[], jsonb) from public, anon, authenticated;
grant execute on function public.worker_checkin(text, text[], jsonb) to service_role;
