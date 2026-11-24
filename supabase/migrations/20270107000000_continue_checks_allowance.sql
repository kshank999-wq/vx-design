-- A run can only be continued or restarted while its account may spend: otherwise it said "running" while no
-- worker would take its work (the account's monthly AI allowance was used up). Now the continue is refused with the
-- reason, which the page shows.

create or replace function public.enforce_account_spend_on_resume() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_account uuid;
  v_problem text;
begin
  if new.status in ('pending', 'running') and old.status not in ('pending', 'running', 'paused') then
    select created_by into v_account from public.projects where id = new.project_id;
    v_problem := public.account_quota_problem(v_account, 'spend');
    if v_problem is not null then
      raise exception 'Plan limit: the run cannot continue because %. An administrator can move the account to a bigger plan on the Admin page.', v_problem
        using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists runs_account_spend_on_resume on public.runs;
create trigger runs_account_spend_on_resume before update of status on public.runs
  for each row execute function public.enforce_account_spend_on_resume();

-- Run 1 of plan v7 was continued after the allowance ran out and has sat "running" with nothing to do: say why.
update public.runs r set status = 'stopped', finished_at = now(),
       stop_reason = 'Plan limit: ' || public.account_quota_problem((select created_by from public.projects p where p.id = r.project_id), 'spend')
 where r.id = '767bf8e0-d620-455f-a1aa-0b6f55f2ecdc' and r.status = 'running'
   and public.account_quota_problem((select created_by from public.projects p where p.id = r.project_id), 'spend') is not null
   and not exists (select 1 from public.executions e where e.run_id = r.id and e.status = 'running');

revoke all on function public.enforce_account_spend_on_resume() from public, anon, authenticated;

-- Administrators: every account that owns projects, its plan and this month's use, and changing its plan.
create or replace function public.admin_accounts()
returns table (user_id uuid, email text, plan_id text, plan_name text, monthly_ai_usd numeric, monthly_compute_usd numeric,
               ai_usd numeric, compute_usd numeric, projects integer)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_platform_admin() then raise exception 'administrators only' using errcode = '42501'; end if;
  return query
    select u.id, u.email::text, pl.id, pl.name, pl.monthly_ai_usd, pl.monthly_compute_usd, c.ai_usd, c.compute_usd, c.projects
      from (select distinct created_by as id from public.projects where created_by is not null) o
      join auth.users u on u.id = o.id
      cross join lateral public.account_plan_of(u.id) pl
      cross join lateral public.account_counts(u.id) c
     order by c.ai_usd desc;
end;
$$;

create or replace function public.admin_set_account_plan(p_user uuid, p_plan text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_platform_admin() then raise exception 'administrators only' using errcode = '42501'; end if;
  perform public.set_account_plan(p_user, p_plan, null);
  insert into public.audit_events (project_id, actor_id, actor_type, event_type, entity_type, entity_id, payload)
  select p.id, auth.uid(), 'user', 'account.plan_changed', 'account', p_user, jsonb_build_object('plan', p_plan)
    from public.projects p where p.created_by = p_user order by p.created_at limit 1;
end;
$$;

revoke all on function public.admin_accounts(), public.admin_set_account_plan(uuid, text) from public, anon;
grant execute on function public.admin_accounts(), public.admin_set_account_plan(uuid, text) to authenticated;
