-- In-house administration of earnings. Customers see one price per AI call (our cost with their plan's markup); our
-- cost and the markup are shown only to VX Design administrators, who also see what in-house (internal-plan)
-- projects would have earned at a reference markup.
create table public.platform_admins (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  note       text,
  created_at timestamptz not null default now()
);
alter table public.platform_admins enable row level security;
revoke all on public.platform_admins from anon, authenticated;
grant all on public.platform_admins to service_role;

create function public.is_platform_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.platform_admins where user_id = auth.uid())
$$;
revoke all on function public.is_platform_admin() from public, anon;
grant execute on function public.is_platform_admin() to authenticated;

-- The markup in-house projects are measured against ("what we would have made"); admins can change it.
create table public.admin_settings (
  id                     boolean primary key default true check (id),
  reference_markup_pct   numeric(6, 2) not null default 25 check (reference_markup_pct >= 0),
  updated_at             timestamptz not null default now()
);
insert into public.admin_settings default values;
alter table public.admin_settings enable row level security;
revoke all on public.admin_settings from anon, authenticated;
grant all on public.admin_settings to service_role;

create function public.set_reference_markup(p_pct numeric) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_platform_admin() then raise exception 'administrators only' using errcode = '42501'; end if;
  if p_pct is null or p_pct < 0 or p_pct > 500 then raise exception 'markup must be between 0 and 500%%'; end if;
  update public.admin_settings set reference_markup_pct = p_pct, updated_at = now();
end;
$$;
revoke all on function public.set_reference_markup(numeric) from public, anon;
grant execute on function public.set_reference_markup(numeric) to authenticated;

-- The ledger's cost column is ours: customers read every other column.
revoke select on public.billing_ledger from authenticated;
grant select (id, account_id, kind, amount_usd, description, ref, cost_event_id, project_id, plan_id, created_by, created_at)
  on public.billing_ledger to authenticated;

-- Statements: our cost only for administrators.
create or replace function public.my_statement(p_month text)
returns table (at timestamptz, kind text, description text, project text, activity text, model text,
               input_tokens bigint, output_tokens bigint, cache_read_tokens bigint, cache_write_tokens bigint,
               cost_usd numeric, amount_usd numeric, opening_balance numeric)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_from timestamptz;
  v_admin boolean := public.is_platform_admin();
begin
  if v_user is null then raise exception 'sign in first'; end if;
  if p_month !~ '^\d{4}-(0[1-9]|1[0-2])$' then raise exception 'month must be YYYY-MM'; end if;
  v_from := (p_month || '-01')::timestamp at time zone 'utc';
  return query
    select l.created_at, l.kind, l.description, pr.name, c.purpose, c.resource,
           c.input_tokens, c.output_tokens, c.cache_read_tokens, c.cache_write_tokens,
           case when v_admin then l.cost_usd end, l.amount_usd,
           (select coalesce(sum(b.amount_usd), 0) from public.billing_ledger b where b.account_id = v_user and b.created_at < v_from)
      from public.billing_ledger l
      left join public.cost_events c on c.id = l.cost_event_id
      left join public.projects pr on pr.id = l.project_id
     where l.account_id = v_user and l.created_at >= v_from and l.created_at < v_from + interval '1 month'
     order by l.created_at, l.id;
end;
$$;

-- Plan descriptions customers read: the price, not how it is made up.
update public.account_plans set description = 'No monthly fee. Pay for AI and worker time as you use it, from your prepaid balance.' where id = 'pay_as_you_go';
update public.account_plans set description = '$50 a month, with lower usage prices for AI and worker time, from your prepaid balance.' where id = 'studio';
update public.account_plans set description = '$150 a month including $100 of usage; beyond that, usage from your prepaid balance.' where id = 'team';

-- Earnings for administrators, per month (UTC): customers' charges against our cost (actual markup), and what
-- in-house projects (accounts not billed) would have earned at the reference markup.
create function public.admin_earnings(p_month text)
returns table (section text, account text, plan text, calls bigint, cost_usd numeric, charged_usd numeric, markup_usd numeric)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_from timestamptz;
  v_ref numeric;
begin
  if not public.is_platform_admin() then raise exception 'administrators only' using errcode = '42501'; end if;
  if p_month !~ '^\d{4}-(0[1-9]|1[0-2])$' then raise exception 'month must be YYYY-MM'; end if;
  v_from := (p_month || '-01')::timestamp at time zone 'utc';
  select reference_markup_pct into v_ref from public.admin_settings;
  return query
    select 'customers'::text, coalesce(u.email, l.account_id::text)::text, max(p.name)::text, count(*)::bigint,
           round(sum(coalesce(l.cost_usd, 0)), 4), round(-sum(l.amount_usd), 4), round(-sum(l.amount_usd) - sum(coalesce(l.cost_usd, 0)), 4)
      from public.billing_ledger l
      join auth.users u on u.id = l.account_id
      left join public.account_plans p on p.id = l.plan_id
     where l.kind = 'usage' and l.created_at >= v_from and l.created_at < v_from + interval '1 month'
     group by 2
    union all
    select 'in_house'::text, coalesce(u.email, pm.user_id::text)::text, max(ap.name)::text, count(*)::bigint,
           round(sum(c.cost_usd), 4), round(sum(c.cost_usd) * (1 + v_ref / 100), 4), round(sum(c.cost_usd) * v_ref / 100, 4)
      from public.cost_events c
      join public.project_members pm on pm.project_id = c.project_id and pm.role = 'owner'
      join auth.users u on u.id = pm.user_id
      left join public.accounts a on a.user_id = pm.user_id
      left join public.account_plans ap on ap.id = coalesce(a.plan_id, 'standard')
     where coalesce(ap.billing, 'internal') <> 'prepaid'
       and c.created_at >= v_from and c.created_at < v_from + interval '1 month' and c.cost_usd is not null
     group by 2
    order by 1, 2;
end;
$$;
revoke all on function public.admin_earnings(text) from public, anon;
grant execute on function public.admin_earnings(text) to authenticated;

create function public.admin_reference_markup() returns numeric
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_platform_admin() then raise exception 'administrators only' using errcode = '42501'; end if;
  return (select reference_markup_pct from public.admin_settings);
end;
$$;
revoke all on function public.admin_reference_markup() from public, anon;
grant execute on function public.admin_reference_markup() to authenticated;

-- The billing summary: customers see their charges and each plan's price rate, not our cost or the markup.
create or replace function public.my_billing() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  pl public.account_plans;
  v_month timestamptz := date_trunc('month', now() at time zone 'utc') at time zone 'utc';
  v_cost numeric;
  v_admin boolean := public.is_platform_admin();
  v_hide text[] := case when public.is_platform_admin() then '{}'::text[] else '{ai_markup_pct}'::text[] end;
begin
  if v_user is null then raise exception 'sign in first'; end if;
  perform public.ensure_plan_fee(v_user);
  pl := public.account_plan_of(v_user);
  select coalesce(sum(c.cost_usd), 0) into v_cost from public.cost_events c
   where c.project_id in (select id from public.projects where created_by = v_user) and c.created_at >= v_month;
  return jsonb_build_object(
    'plan', (to_jsonb(pl) - v_hide) || jsonb_build_object('price_rate', 1 + pl.ai_markup_pct / 100),
    'admin', v_admin,
    'balance', public.account_balance(v_user),
    'month_cost', case when v_admin then v_cost end,
    'month_charged', coalesce((select -sum(amount_usd) from public.billing_ledger where account_id = v_user and kind = 'usage' and created_at >= v_month), 0),
    'month_fees', coalesce((select -sum(amount_usd) from public.billing_ledger where account_id = v_user and kind = 'plan_fee' and created_at >= v_month), 0),
    'offers', coalesce((select jsonb_agg((to_jsonb(o) - v_hide) || jsonb_build_object('price_rate', 1 + o.ai_markup_pct / 100) order by o.sort_order)
                          from public.account_plans o where o.offered), '[]'),
    'months', coalesce((select jsonb_agg(m order by m desc) from (select distinct to_char(created_at at time zone 'utc', 'YYYY-MM') m
                          from public.billing_ledger where account_id = v_user) x), '[]'));
end;
$$;

-- The plans table itself: customers read every column but the markup.
revoke select on public.account_plans from authenticated;
grant select (id, name, description, max_projects, max_active_runs, max_concurrent_tasks, monthly_ai_usd, monthly_compute_usd,
              monthly_concept_rounds, queue_weight, created_at, billing, monthly_fee_usd, included_ai_usd, offered, sort_order, locked)
  on public.account_plans to authenticated;
