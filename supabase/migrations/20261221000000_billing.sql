-- Billing groundwork: prepaid balances, transparent per-call charges, plan fees, card top-ups and statements.
--
-- Every account has a ledger (billing_ledger): credit adds to the balance (a card payment, or credit added by staff),
-- usage and plan fees take from it. The balance is the sum of the ledger. Accounts on a plan with billing = 'prepaid'
-- are charged for every cost event in their projects as it is recorded: our cost (the token price table) times
-- (1 + the plan's markup), after the plan's monthly included allowance (at cost) is used up. Each charge is one ledger
-- row tied to its cost event, so a statement lists every AI call with its tokens, its cost to us and what was charged.
-- Plans billed 'internal' (standard, unlimited) are not charged and keep their monthly allowances as before.
--
-- A plan fee is charged for the calendar month (UTC) when the plan is chosen and again with the month's first use or
-- account visit (one fee per plan per month; moving to a dearer plan mid-month charges the difference, moving to a
-- cheaper one refunds nothing). When the balance reaches zero, AI work stops the same way a used-up allowance does:
-- running runs stop at their next checkpoint, new runs, plan builds and AI actions wait until credit is added. One
-- call already in progress can take the balance a little below zero; the next credit covers it.
--
-- Card payments: the web server creates a Stripe Checkout session (noted in billing_checkouts) and, when Stripe reports
-- it paid, records the credit with record_payment, signed with the server's key (the assistant signing key, under its
-- own "vx-billing-v1" label), once per payment. It asks Stripe on the return page and again for any checkout still
-- open whenever the account opens its Billing page, so a payment whose browser closed early is still credited.

alter table public.account_plans
  add column billing         text not null default 'internal' check (billing in ('internal', 'prepaid')),
  add column monthly_fee_usd numeric(10, 2) not null default 0 check (monthly_fee_usd >= 0),
  add column included_ai_usd numeric(10, 2) not null default 0 check (included_ai_usd >= 0),
  add column ai_markup_pct   numeric(6, 2) not null default 0 check (ai_markup_pct >= 0),
  add column offered         boolean not null default false,
  add column locked          boolean not null default false,
  add column sort_order      integer not null default 0;
comment on column public.account_plans.offered is 'Shown in the plan picker; accounts may move to it themselves.';
comment on column public.account_plans.locked is 'Accounts on it cannot move off it themselves (set by staff).';

update public.account_plans set locked = true where id = 'unlimited';

-- Placeholder offers until pricing is decided; change them with an update.
insert into public.account_plans (id, name, description, max_projects, max_active_runs, max_concurrent_tasks,
                                  monthly_ai_usd, monthly_compute_usd, monthly_concept_rounds, queue_weight,
                                  billing, monthly_fee_usd, included_ai_usd, ai_markup_pct, offered, sort_order) values
  ('pay_as_you_go', 'Pay as you go', 'No monthly fee. AI and worker compute at our cost plus 25%, from your prepaid balance.',
   10, 2, 2, null, null, 10, 1, 'prepaid', 0, 0, 25, true, 1),
  ('studio', 'Studio', '$50 a month. AI and worker compute at exactly our cost, from your prepaid balance.',
   25, 3, 4, null, null, 30, 1, 'prepaid', 50, 0, 0, true, 2),
  ('team', 'Team', '$150 a month including $100 of AI and compute at cost; beyond that, at cost from your prepaid balance.',
   100, 6, 8, null, null, 100, 1.5, 'prepaid', 150, 100, 0, true, 3);

create table public.billing_ledger (
  id            bigint generated always as identity primary key,
  account_id    uuid not null references auth.users (id) on delete cascade,
  kind          text not null check (kind in ('credit', 'usage', 'plan_fee', 'adjustment')),
  amount_usd    numeric(14, 6) not null,          -- added to the balance (negative takes from it)
  cost_usd      numeric(14, 6),                   -- usage: our cost before the allowance and markup
  description   text not null,
  ref           text unique,                      -- once only: stripe:<session>, fee:<account>:<month>:<plan>, cost:<event>
  cost_event_id uuid references public.cost_events (id) on delete set null,
  project_id    uuid references public.projects (id) on delete set null,
  plan_id       text references public.account_plans (id),
  created_by    uuid references auth.users (id) on delete set null,
  created_at    timestamptz not null default now()
);
create index billing_ledger_account_idx on public.billing_ledger (account_id, created_at);
alter table public.billing_ledger enable row level security;
create policy "users read their own ledger" on public.billing_ledger for select to authenticated using (account_id = (select auth.uid()));
grant select on public.billing_ledger to authenticated;
grant all on public.billing_ledger to service_role;

create table public.billing_checkouts (
  session_id   text primary key check (session_id ~ '^cs_[A-Za-z0-9_]{8,200}$'),
  account_id   uuid not null references auth.users (id) on delete cascade default auth.uid(),
  amount_cents integer not null check (amount_cents > 0),
  status       text not null default 'open' check (status in ('open', 'paid', 'expired')),
  created_at   timestamptz not null default now()
);
alter table public.billing_checkouts enable row level security;
create policy "users read their own checkouts" on public.billing_checkouts for select to authenticated using (account_id = (select auth.uid()));
grant select on public.billing_checkouts to authenticated;
grant all on public.billing_checkouts to service_role;

-- The web server notes each Checkout session it opens for the signed-in account; expired ones are closed.
create function public.note_checkout(p_session text, p_amount_cents integer, p_status text default 'open') returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  if p_status not in ('open', 'expired') then raise exception 'bad checkout status'; end if;
  insert into public.billing_checkouts (session_id, account_id, amount_cents) values (p_session, auth.uid(), p_amount_cents)
  on conflict (session_id) do update set status = p_status
   where public.billing_checkouts.account_id = auth.uid() and public.billing_checkouts.status = 'open';
end;
$$;

create function public.account_balance(p_user uuid) returns numeric
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(amount_usd), 0) from public.billing_ledger where account_id = p_user;
$$;

create function public.month_label(p_at timestamptz) returns text
language sql immutable set search_path = '' as $$ select to_char(p_at at time zone 'utc', 'FMMonth YYYY') $$;

-- The plan fee still due for this month on the account's plan (the plan's fee less fees already paid this month).
create function public.plan_fee_due(p_user uuid, p_plan public.account_plans) returns numeric
language sql stable security definer set search_path = '' as $$
  select greatest(0, p_plan.monthly_fee_usd - coalesce((select -sum(amount_usd) from public.billing_ledger
     where account_id = p_user and kind = 'plan_fee'
       and created_at >= date_trunc('month', now() at time zone 'utc') at time zone 'utc'), 0));
$$;

-- Charges this month's plan fee once (no-op on internal plans or when already paid).
create function public.ensure_plan_fee(p_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  pl public.account_plans := public.account_plan_of(p_user);
  v_due numeric;
begin
  if p_user is null or pl.billing <> 'prepaid' or pl.monthly_fee_usd = 0 then return; end if;
  perform pg_advisory_xact_lock(hashtextextended('vx-billing:' || p_user::text, 0));
  v_due := public.plan_fee_due(p_user, pl);
  if v_due <= 0 then return; end if;
  insert into public.billing_ledger (account_id, kind, amount_usd, description, ref, plan_id)
  values (p_user, 'plan_fee', -v_due, format('%s plan, %s', pl.name, public.month_label(now())),
          format('fee:%s:%s:%s', p_user, to_char(now() at time zone 'utc', 'YYYY-MM'), pl.id), pl.id)
  on conflict (ref) do nothing;
end;
$$;

-- Each cost event in a prepaid account's project is charged as it is recorded.
create function public.bill_cost_event() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_account uuid;
  pl public.account_plans;
  v_prior numeric;
  v_covered numeric := 0;
  v_charge numeric;
begin
  if new.cost_usd <= 0 then return null; end if;
  select created_by into v_account from public.projects where id = new.project_id;
  if v_account is null then return null; end if;
  pl := public.account_plan_of(v_account);
  if pl.billing <> 'prepaid' then return null; end if;
  perform public.ensure_plan_fee(v_account);
  if pl.included_ai_usd > 0 then
    select coalesce(sum(c.cost_usd), 0) into v_prior from public.cost_events c
     where c.project_id in (select id from public.projects where created_by = v_account) and c.id <> new.id
       and c.created_at >= date_trunc('month', now() at time zone 'utc') at time zone 'utc';
    v_covered := greatest(0, least(new.cost_usd, pl.included_ai_usd - v_prior));
  end if;
  v_charge := round((new.cost_usd - v_covered) * (1 + pl.ai_markup_pct / 100), 6);
  insert into public.billing_ledger (account_id, kind, amount_usd, cost_usd, description, ref, cost_event_id, project_id, plan_id, created_by)
  values (v_account, 'usage', -v_charge, new.cost_usd,
          case when new.kind = 'ai_tokens' then 'AI' else 'Worker compute' end || coalesce(' · ' || new.resource, '')
            || case when v_covered > 0 then format(' (%s of it in the plan''s allowance)', to_char(v_covered, 'FM$999990.0000')) else '' end,
          'cost:' || new.id, new.id, new.project_id, pl.id, new.user_id)
  on conflict (ref) do nothing;
  return null;
end;
$$;
-- Named to run before cost_events_account_spend (triggers fire in name order), so the stop check sees the charge.
create trigger cost_events_a_bill after insert on public.cost_events for each row execute function public.bill_cost_event();

-- Why an account may not take on more work of this kind ('project', 'run', 'concepts', 'task', 'spend', 'ai'), or null.
-- Unchanged from the quotas migration except the prepaid balance check and the 'ai' kind (an AI call outside a run).
create or replace function public.account_quota_problem(p_user uuid, p_what text) returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  pl public.account_plans := public.account_plan_of(p_user);
  u record;
  v_balance numeric;
begin
  select * into u from public.account_counts(p_user);
  if p_what in ('run', 'task', 'spend', 'ai') then
    if pl.billing = 'prepaid' then
      v_balance := public.account_balance(p_user);
      if v_balance <= 0 then
        return format('the prepaid balance is used up (%s); add credit on the Billing page to continue',
                      to_char(v_balance, 'FM$999999990.00'));
      end if;
    end if;
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

-- Before an AI call outside a run: why the project's account may not spend now, or null. Members ask for their
-- project (the web app); workers ask with the service role.
create function public.ai_spend_problem(p_project uuid) returns text
language plpgsql stable security definer set search_path = '' as $$
declare v_account uuid;
begin
  if auth.uid() is not null and not public.is_project_member(p_project) then raise exception 'not a member of this project'; end if;
  select created_by into v_account from public.projects where id = p_project;
  if v_account is null then return null; end if;
  return public.account_quota_problem(v_account, 'ai');
end;
$$;

-- What one dollar of our cost is charged at for this project (for estimates): 1 + markup on prepaid plans, else 1.
create function public.project_billing_rate(p_project uuid) returns numeric
language sql stable security definer set search_path = '' as $$
  select case when pl.billing = 'prepaid' then 1 + pl.ai_markup_pct / 100 else 1 end
    from public.projects p, lateral public.account_plan_of(p.created_by) pl
   where p.id = p_project and public.is_project_member(p_project);
$$;

-- Plan fees and new AI work wait on a project whose plan builds would otherwise run past a used-up balance.
create function public.enforce_plan_request_spend() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_account uuid; v_problem text;
begin
  select created_by into v_account from public.projects where id = new.project_id;
  v_problem := public.account_quota_problem(v_account, 'ai');
  if v_problem is not null then raise exception 'Plan limit: %', v_problem using errcode = 'P0001'; end if;
  return new;
end;
$$;
create trigger plan_requests_account_spend before insert on public.plan_requests for each row execute function public.enforce_plan_request_spend();

-- The signed-in account's billing: plan, balance, this month's fee and allowance, and the plans on offer.
create function public.my_billing() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  pl public.account_plans;
  v_month timestamptz := date_trunc('month', now() at time zone 'utc') at time zone 'utc';
  v_cost numeric;
begin
  if v_user is null then raise exception 'sign in first'; end if;
  perform public.ensure_plan_fee(v_user);
  pl := public.account_plan_of(v_user);
  select coalesce(sum(c.cost_usd), 0) into v_cost from public.cost_events c
   where c.project_id in (select id from public.projects where created_by = v_user) and c.created_at >= v_month;
  return jsonb_build_object(
    'plan', to_jsonb(pl),
    'balance', public.account_balance(v_user),
    'month_cost', v_cost,
    'month_charged', coalesce((select -sum(amount_usd) from public.billing_ledger where account_id = v_user and kind = 'usage' and created_at >= v_month), 0),
    'month_fees', coalesce((select -sum(amount_usd) from public.billing_ledger where account_id = v_user and kind = 'plan_fee' and created_at >= v_month), 0),
    'offers', coalesce((select jsonb_agg(to_jsonb(o) order by o.sort_order) from public.account_plans o where o.offered), '[]'),
    'months', coalesce((select jsonb_agg(m order by m desc) from (select distinct to_char(created_at at time zone 'utc', 'YYYY-MM') m
                          from public.billing_ledger where account_id = v_user) x), '[]'));
end;
$$;

-- The signed-in account moves itself to a plan on offer. A plan fee is charged now and must be covered by the balance.
create function public.choose_plan(p_plan text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  cur public.account_plans;
  nxt public.account_plans;
  v_due numeric;
  v_balance numeric;
begin
  if v_user is null then raise exception 'sign in first'; end if;
  cur := public.account_plan_of(v_user);
  select * into nxt from public.account_plans where id = p_plan and offered;
  if nxt.id is null then raise exception 'that plan is not on offer'; end if;
  if cur.id = nxt.id then return; end if;
  if cur.locked then raise exception 'this account is on the % plan, set by staff; ask us to change it', cur.name; end if;
  perform pg_advisory_xact_lock(hashtextextended('vx-billing:' || v_user::text, 0));
  v_due := public.plan_fee_due(v_user, nxt);
  v_balance := public.account_balance(v_user);
  if v_due > 0 and v_balance < v_due then
    raise exception 'the % plan''s fee for this month is %; add % of credit first', nxt.name,
      to_char(v_due, 'FM$999990.00'), to_char(v_due - v_balance, 'FM$999990.00');
  end if;
  insert into public.accounts (user_id, plan_id) values (v_user, nxt.id)
  on conflict (user_id) do update set plan_id = excluded.plan_id, updated_at = now();
  perform public.ensure_plan_fee(v_user);
end;
$$;

-- One line per ledger row of a calendar month ('YYYY-MM'), with the AI call behind each usage charge.
create function public.my_statement(p_month text)
returns table (at timestamptz, kind text, description text, project text, activity text, model text,
               input_tokens bigint, output_tokens bigint, cache_read_tokens bigint, cache_write_tokens bigint,
               cost_usd numeric, amount_usd numeric, opening_balance numeric)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_from timestamptz;
begin
  if v_user is null then raise exception 'sign in first'; end if;
  if p_month !~ '^\d{4}-(0[1-9]|1[0-2])$' then raise exception 'month must be YYYY-MM'; end if;
  v_from := (p_month || '-01')::timestamp at time zone 'utc';
  return query
    select l.created_at, l.kind, l.description, pr.name, c.purpose, c.resource,
           c.input_tokens, c.output_tokens, c.cache_read_tokens, c.cache_write_tokens, l.cost_usd, l.amount_usd,
           (select coalesce(sum(b.amount_usd), 0) from public.billing_ledger b where b.account_id = v_user and b.created_at < v_from)
      from public.billing_ledger l
      left join public.cost_events c on c.id = l.cost_event_id
      left join public.projects pr on pr.id = l.project_id
     where l.account_id = v_user and l.created_at >= v_from and l.created_at < v_from + interval '1 month'
     order by l.created_at, l.id;
end;
$$;

-- A card payment for the signed-in account, reported by the web server once Stripe says it is paid, signed with the
-- server's key: HMAC-SHA256 over "vx-billing-v1", the account, the amount in cents, the reference and the signing time
-- (ms), one per line. Recorded once per reference; returns 'recorded' or 'already recorded'.
create function public.record_payment(p_amount_cents integer, p_ref text, p_description text,
                                      p_signed_at_ms bigint, p_signature text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_key text;
  v_msg text;
  v_id bigint;
begin
  if v_user is null then raise exception 'sign in first'; end if;
  select value into v_key from vx_private.secrets where name = 'assistant_signing_key';
  if v_key is null then raise exception 'payments are not configured (no signing key)'; end if;
  if p_signature is null or p_signed_at_ms is null or abs(extract(epoch from now()) * 1000 - p_signed_at_ms) > 300000 then
    raise exception 'payment must be signed by the server' using errcode = '42501';
  end if;
  v_msg := concat_ws(E'\n', 'vx-billing-v1', v_user::text, p_amount_cents::text, p_ref, p_signed_at_ms::text);
  if vx_private.hmac_sha256(convert_to(v_key, 'UTF8'), convert_to(v_msg, 'UTF8')) <> lower(p_signature) then
    raise exception 'payment signature does not match' using errcode = '42501';
  end if;
  if p_amount_cents <= 0 or p_amount_cents > 1000000 then raise exception 'payment amount out of range'; end if;
  if p_ref !~ '^stripe:cs_[A-Za-z0-9_]{8,200}$' then raise exception 'bad payment reference'; end if;
  insert into public.billing_ledger (account_id, kind, amount_usd, description, ref)
  values (v_user, 'credit', p_amount_cents / 100.0, left(coalesce(nullif(trim(p_description), ''), 'Card payment'), 200), p_ref)
  on conflict (ref) do nothing returning id into v_id;
  update public.billing_checkouts set status = 'paid' where session_id = substr(p_ref, 8) and account_id = v_user;
  return case when v_id is null then 'already recorded' else 'recorded' end;
end;
$$;

-- Staff: add credit (or take it back with a negative amount), e.g. a bank transfer or a goodwill credit.
create function public.add_credit(p_account uuid, p_amount_usd numeric, p_note text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(trim(p_note), '') = '' then raise exception 'say what the credit is for'; end if;
  insert into public.billing_ledger (account_id, kind, amount_usd, description)
  values (p_account, case when p_amount_usd >= 0 then 'credit' else 'adjustment' end, p_amount_usd, p_note);
end;
$$;

revoke all on function public.account_balance(uuid), public.month_label(timestamptz), public.plan_fee_due(uuid, public.account_plans),
  public.ensure_plan_fee(uuid), public.bill_cost_event(), public.enforce_plan_request_spend(), public.add_credit(uuid, numeric, text)
  from public, anon, authenticated;
grant execute on function public.account_balance(uuid), public.ensure_plan_fee(uuid), public.add_credit(uuid, numeric, text) to service_role;
revoke all on function public.ai_spend_problem(uuid), public.project_billing_rate(uuid), public.my_billing(), public.choose_plan(text),
  public.my_statement(text), public.note_checkout(text, integer, text), public.record_payment(integer, text, text, bigint, text) from public, anon;
grant execute on function public.ai_spend_problem(uuid), public.project_billing_rate(uuid) to authenticated, service_role;
grant execute on function public.my_billing(), public.choose_plan(text), public.my_statement(text),
  public.note_checkout(text, integer, text), public.record_payment(integer, text, text, bigint, text) to authenticated;
