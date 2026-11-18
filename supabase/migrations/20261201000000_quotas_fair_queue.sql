-- Fair queueing and per-account quotas.
--
-- An account is the person who created a project (projects.created_by): their plan's limits cover all of their
-- projects, whoever in the project starts the work. Plans hold the limits (null = unlimited); accounts without a row
-- are on the 'standard' plan. Billing is not built: plans are assigned with set_account_plan (service role / SQL).
--
-- Quotas are enforced where the work is created, by triggers, so every path (web, RPC, SQL) is covered:
--   projects        at most max_projects per account
--   runs            at most max_active_runs active (pending, running, paused) runs; none once a monthly allowance is spent
--   concept rounds  at most monthly_concept_rounds per calendar month (UTC)
--   spend           monthly_ai_usd / monthly_compute_usd over cost_events this month; reaching one stops the account's
--                   running runs (in-flight work yields at its next heartbeat) and no new work is claimed for it
--
-- Fair queueing: workers claim with claim_next_fair instead of walking runs oldest-first. Among runs with ready work it
-- serves the account with the fewest running tasks (divided by its plan's queue_weight), then the account served least
-- recently, then the run with the fewest running tasks, then the oldest run; accounts at max_concurrent_tasks or over a
-- monthly allowance are skipped. A per-account advisory lock makes the concurrency limit hold across workers.

create table public.account_plans (
  id                     text primary key check (id ~ '^[a-z][a-z0-9_]*$'),
  name                   text not null,
  description            text,
  max_projects           integer check (max_projects >= 0),
  max_active_runs        integer check (max_active_runs >= 0),
  max_concurrent_tasks   integer check (max_concurrent_tasks >= 1),
  monthly_ai_usd         numeric(12, 2) check (monthly_ai_usd >= 0),
  monthly_compute_usd    numeric(12, 2) check (monthly_compute_usd >= 0),
  monthly_concept_rounds integer check (monthly_concept_rounds >= 0),
  queue_weight           numeric(6, 2) not null default 1 check (queue_weight > 0),
  created_at             timestamptz not null default now()
);
alter table public.account_plans enable row level security;
create policy "signed-in users read plans" on public.account_plans for select to authenticated using (true);
grant select on public.account_plans to authenticated;
grant all on public.account_plans to service_role;

-- Starting limits until pricing is decided. Change them with an update; every account follows its plan at once.
insert into public.account_plans (id, name, description, max_projects, max_active_runs, max_concurrent_tasks,
                                  monthly_ai_usd, monthly_compute_usd, monthly_concept_rounds, queue_weight) values
  ('standard', 'Standard', 'Default for every account. Placeholder limits until pricing is decided.', 25, 3, 4, 200, 100, 30, 1),
  ('unlimited', 'Unlimited', 'Staff and internal projects: no limits, double share of the queue.', null, null, null, null, null, null, 2);

create table public.accounts (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  plan_id    text not null default 'standard' references public.account_plans (id),
  note       text,
  updated_at timestamptz not null default now()
);
alter table public.accounts enable row level security;
create policy "users read their own account" on public.accounts for select to authenticated using (user_id = (select auth.uid()));
grant select on public.accounts to authenticated;
grant all on public.accounts to service_role;

create index if not exists executions_project_running_idx on public.executions (project_id) where status = 'running';
create index if not exists cost_events_project_created_idx on public.cost_events (project_id, created_at);
create index if not exists projects_created_by_idx on public.projects (created_by);

-- The plan an account is on ('standard' without an accounts row).
create function public.account_plan_of(p_user uuid) returns public.account_plans
language sql stable security definer set search_path = '' as $$
  select pl.* from public.account_plans pl
   where pl.id = coalesce((select a.plan_id from public.accounts a where a.user_id = p_user), 'standard');
$$;

-- This calendar month's (UTC) use by an account, across all the projects it created.
create function public.account_counts(p_user uuid, out projects integer, out active_runs integer, out running_tasks integer,
                                      out ai_usd numeric, out compute_usd numeric, out concept_rounds integer,
                                      out month_start timestamptz)
language sql stable security definer set search_path = '' as $$
  with mine as (select id from public.projects where created_by = p_user),
       m as (select date_trunc('month', now() at time zone 'utc') at time zone 'utc' as start)
  select (select count(*) from mine)::integer,
         (select count(*) from public.runs r where r.project_id in (select id from mine)
            and r.status in ('pending', 'running', 'paused'))::integer,
         (select count(*) from public.executions e where e.project_id in (select id from mine) and e.status = 'running')::integer,
         coalesce((select sum(c.cost_usd) from public.cost_events c, m where c.project_id in (select id from mine)
            and c.created_at >= m.start and c.kind = 'ai_tokens'), 0),
         coalesce((select sum(c.cost_usd) from public.cost_events c, m where c.project_id in (select id from mine)
            and c.created_at >= m.start and c.kind <> 'ai_tokens'), 0),
         (select count(*) from public.concept_rounds cr, m where cr.project_id in (select id from mine)
            and cr.created_at >= m.start)::integer,
         (select start from m);
$$;

-- Why an account may not take on more work of this kind ('project', 'run', 'concepts', 'task', 'spend'), or null.
create function public.account_quota_problem(p_user uuid, p_what text) returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  pl public.account_plans := public.account_plan_of(p_user);
  u record;
begin
  select * into u from public.account_counts(p_user);
  if p_what in ('run', 'task', 'spend') then
    if pl.monthly_ai_usd is not null and u.ai_usd >= pl.monthly_ai_usd then
      return format('this account has used its monthly AI allowance ($%s of $%s on the %s plan); it renews on the 1st',
                    round(u.ai_usd, 2), pl.monthly_ai_usd, pl.name);
    end if;
    if pl.monthly_compute_usd is not null and u.compute_usd >= pl.monthly_compute_usd then
      return format('this account has used its monthly compute allowance ($%s of $%s on the %s plan); it renews on the 1st',
                    round(u.compute_usd, 2), pl.monthly_compute_usd, pl.name);
    end if;
  end if;
  if p_what = 'project' and pl.max_projects is not null and u.projects >= pl.max_projects then
    return format('the %s plan allows %s projects per account; ask us to raise the limit', pl.name, pl.max_projects);
  elsif p_what = 'run' and pl.max_active_runs is not null and u.active_runs >= pl.max_active_runs then
    return format('the %s plan allows %s active runs at once per account; finish, pause or cancel one first',
                  pl.name, pl.max_active_runs);
  elsif p_what = 'concepts' and pl.monthly_concept_rounds is not null and u.concept_rounds >= pl.monthly_concept_rounds then
    return format('the %s plan allows %s concept rounds a month per account; it renews on the 1st',
                  pl.name, pl.monthly_concept_rounds);
  elsif p_what = 'task' and pl.max_concurrent_tasks is not null and u.running_tasks >= pl.max_concurrent_tasks then
    return format('%s of %s task slots in use', u.running_tasks, pl.max_concurrent_tasks);
  end if;
  return null;
end;
$$;

-- What the signed-in user sees on their account page: plan, limits and this month's use.
create function public.my_account() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  pl public.account_plans;
  u record;
begin
  if v_user is null then raise exception 'sign in first'; end if;
  pl := public.account_plan_of(v_user);
  select * into u from public.account_counts(v_user);
  return jsonb_build_object('plan', to_jsonb(pl), 'usage', to_jsonb(u));
end;
$$;

-- Staff: put an account on a plan (service role / SQL editor only).
create function public.set_account_plan(p_user uuid, p_plan text, p_note text default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.account_plans where id = p_plan) then raise exception 'no plan %', p_plan; end if;
  insert into public.accounts (user_id, plan_id, note) values (p_user, p_plan, p_note)
  on conflict (user_id) do update set plan_id = excluded.plan_id, note = coalesce(excluded.note, public.accounts.note), updated_at = now();
end;
$$;

-- Enforcement where work is created.
create function public.enforce_account_quota() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_account uuid;
  v_problem text;
begin
  if tg_table_name = 'projects' then
    v_account := new.created_by;
    v_problem := public.account_quota_problem(v_account, 'project');
  elsif tg_table_name = 'runs' then
    select created_by into v_account from public.projects where id = new.project_id;
    v_problem := public.account_quota_problem(v_account, 'run');
  elsif tg_table_name = 'concept_rounds' then
    select created_by into v_account from public.projects where id = new.project_id;
    v_problem := public.account_quota_problem(v_account, 'concepts');
  end if;
  if v_problem is not null then
    raise exception 'Plan limit: %', v_problem using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger projects_account_quota before insert on public.projects for each row execute function public.enforce_account_quota();
create trigger runs_account_quota before insert on public.runs for each row execute function public.enforce_account_quota();
create trigger concept_rounds_account_quota before insert on public.concept_rounds for each row execute function public.enforce_account_quota();

-- Spending past a monthly allowance stops the account's running runs.
create function public.enforce_account_spend() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_account uuid;
  v_problem text;
  r record;
begin
  select created_by into v_account from public.projects where id = new.project_id;
  v_problem := public.account_quota_problem(v_account, 'spend');
  if v_problem is null then return null; end if;
  for r in update public.runs set status = 'stopped', stop_reason = 'Plan limit: ' || v_problem
            where status = 'running' and project_id in (select id from public.projects where created_by = v_account)
        returning id, project_id loop
    perform public.worker_audit(r.project_id, 'run.quota_stop', 'run', r.id, jsonb_build_object('reason', v_problem));
  end loop;
  return null;
end;
$$;
create trigger cost_events_account_spend after insert on public.cost_events for each row execute function public.enforce_account_spend();

-- Fair claim across every running run (workers only).
create function public.claim_next_fair(p_worker_id text, p_lease_seconds integer default 60, p_disciplines text[] default null)
returns public.executions
language plpgsql security definer set search_path = '' as $$
declare
  c record;
  v_exec public.executions;
begin
  for c in
    with candidates as (
      select r.id as run_id, r.started_at, p.created_by as account_id
        from public.runs r join public.projects p on p.id = r.project_id
       where r.status = 'running'
         and exists (select 1 from public.tasks t where t.plan_id = r.plan_id and t.status = 'ready'
                       and (p_disciplines is null or t.discipline::text = any (p_disciplines)))
    ), accts as (
      select a.account_id,
             (select count(*) from public.executions e join public.projects p on p.id = e.project_id
               where p.created_by = a.account_id and e.status = 'running') as running,
             (select max(e.started_at) from public.executions e join public.projects p on p.id = e.project_id
               where p.created_by = a.account_id) as last_served,
             (public.account_plan_of(a.account_id)).queue_weight as weight
        from (select distinct account_id from candidates) a
    )
    select cd.run_id, cd.account_id
      from candidates cd join accts a using (account_id)
     order by a.running / a.weight, a.last_served nulls first,
              (select count(*) from public.executions e where e.run_id = cd.run_id and e.status = 'running'),
              cd.started_at
  loop
    -- One claim at a time per account, so concurrent workers cannot both take its last slot.
    perform pg_advisory_xact_lock(hashtextextended('vx-account:' || c.account_id::text, 0));
    if public.account_quota_problem(c.account_id, 'task') is not null then
      continue;
    end if;
    v_exec := public.claim_next_task(p_worker_id, c.run_id, p_lease_seconds, p_disciplines);
    if v_exec.id is not null then
      return v_exec;
    end if;
  end loop;
  return null;
end;
$$;

revoke all on function public.account_plan_of(uuid), public.account_counts(uuid), public.account_quota_problem(uuid, text),
  public.set_account_plan(uuid, text, text), public.enforce_account_quota(), public.enforce_account_spend(),
  public.claim_next_fair(text, integer, text[]) from public, anon, authenticated;
grant execute on function public.account_plan_of(uuid), public.account_counts(uuid), public.account_quota_problem(uuid, text),
  public.set_account_plan(uuid, text, text), public.claim_next_fair(text, integer, text[]) to service_role;
revoke all on function public.my_account() from public, anon;
grant execute on function public.my_account() to authenticated;
