-- Administrators see earnings and our cost; customers see neither. Fresh users Ada (admin, in-house), Cal (customer).
\set ON_ERROR_STOP on
\o /dev/null
insert into auth.users (id, email) values ('00000000-0000-0000-0000-00000000a0a1', 'ada@admin.test'), ('00000000-0000-0000-0000-00000000a0a2', 'cal@cust.test');
insert into public.platform_admins (user_id) values ('00000000-0000-0000-0000-00000000a0a1');
-- schema_test grants everything to authenticated after the migrations (as Supabase's defaults do before them):
-- replay the migration's column restriction in the order the real database sees it.
revoke select on public.billing_ledger from authenticated;
grant select (id, account_id, kind, amount_usd, description, ref, cost_event_id, project_id, plan_id, created_by, created_at)
  on public.billing_ledger to authenticated;
create function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), false);
  if p_user is null then execute 'reset role'; else execute 'set role authenticated'; end if;
end;
$$;
create function pg_temp.check(p_ok boolean, p_msg text) returns void language plpgsql as $$
begin if not coalesce(p_ok, false) then raise exception 'check failed: %', p_msg; end if; end;
$$;
create function pg_temp.expect_error(p_sql text, p_like text) returns void language plpgsql as $$
declare v_err text;
begin
  begin execute p_sql; exception when others then v_err := sqlerrm; end;
  if v_err is null then raise exception 'statement should have failed but succeeded: %', p_sql;
  elsif v_err not like p_like then raise exception 'expected error like "%", got "%"', p_like, v_err; end if;
end;
$$;
-- Ada's in-house project (internal plan) with $10 of AI.
select pg_temp.act_as('00000000-0000-0000-0000-00000000a0a1');
insert into public.projects (name) values ('In-house') returning id as p1 \gset
select pg_temp.act_as(null);
insert into public.cost_events (project_id, kind, provider, resource, quantity, unit, cost_usd) values (:'p1', 'ai_tokens', 'anthropic', 'claude', 1, 'call', 10);
-- Cal is a prepaid customer with a usage charge.
insert into public.billing_ledger (account_id, kind, amount_usd, cost_usd, description) values
  ('00000000-0000-0000-0000-00000000a0a2', 'usage', -12.5, 10, 'AI call');

select pg_temp.act_as('00000000-0000-0000-0000-00000000a0a1');
select pg_temp.check(public.is_platform_admin(), 'ada is admin');
select pg_temp.check((select markup_usd = 2.5 from public.admin_earnings(to_char(now() at time zone 'utc', 'YYYY-MM')) where section = 'in_house' and account = 'ada@admin.test'), 'in-house would-have markup at 25%');
select pg_temp.check((select markup_usd = 2.5 and charged_usd = 12.5 from public.admin_earnings(to_char(now() at time zone 'utc', 'YYYY-MM')) where section = 'customers' and account = 'cal@cust.test'), 'customer markup');
select public.set_reference_markup(10);
select pg_temp.check((select markup_usd = 1 from public.admin_earnings(to_char(now() at time zone 'utc', 'YYYY-MM')) where section = 'in_house' and account = 'ada@admin.test'), 'reference markup changed');

select pg_temp.act_as('00000000-0000-0000-0000-00000000a0a2');
select pg_temp.check(not public.is_platform_admin(), 'cal is not admin');
select pg_temp.expect_error($$select * from public.admin_earnings('2026-01')$$, '%administrators only%');
select pg_temp.expect_error($$select public.set_reference_markup(5)$$, '%administrators only%');
select pg_temp.expect_error($$select cost_usd from public.billing_ledger$$, '%permission denied%');
select pg_temp.check((select count(*) = 1 from public.billing_ledger), 'customer still reads the ledger (without our cost)');
select pg_temp.check((select bool_and(cost_usd is null) from public.my_statement(to_char(now() at time zone 'utc', 'YYYY-MM'))), 'statement hides our cost');
select pg_temp.act_as(null);
\o
select 'admin ok';
