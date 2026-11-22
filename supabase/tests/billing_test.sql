-- Billing: prepaid balances, plan fees, per-call charges with markup and allowance, spend stop, signed payments,
-- statements. Fresh users: Bea (Studio, then Team), Pax (Pay as you go), Una (Unlimited, locked).
\set ON_ERROR_STOP on
\o /dev/null

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000007b1', 'bea@billing.test'),
  ('00000000-0000-0000-0000-0000000007b2', 'pax@billing.test'),
  ('00000000-0000-0000-0000-0000000007b3', 'una@billing.test');

create function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), false);
  if p_user is null then execute 'reset role'; else execute 'set role authenticated'; end if;
end;
$$;
create function pg_temp.expect_error(p_sql text, p_like text) returns void language plpgsql as $$
declare v_err text;
begin
  begin execute p_sql; exception when others then v_err := sqlerrm; end;
  if v_err is null then raise exception 'statement should have failed but succeeded: %', p_sql;
  elsif v_err not like p_like then raise exception 'expected error like "%", got "%"', p_like, v_err; end if;
end;
$$;
create function pg_temp.check(p_ok boolean, p_msg text) returns void language plpgsql as $$
begin if not coalesce(p_ok, false) then raise exception 'check failed: %', p_msg; end if; end;
$$;
create function pg_temp.balance(p_user uuid) returns numeric language sql as $$
  select coalesce(sum(amount_usd), 0) from public.billing_ledger where account_id = p_user $$;
-- One AI call in the project, recorded by its owner.
create function pg_temp.ai_call(p_user uuid, p_project uuid, p_cost numeric) returns void language plpgsql as $$
begin
  perform pg_temp.act_as(p_user);
  perform public.record_ai_call(p_project, null, 'workspace_chat', 'claude-opus-5-5', 1000, 100, 0, 0, p_cost, 1000, false);
  perform pg_temp.act_as(null);
end;
$$;

select pg_temp.act_as('00000000-0000-0000-0000-0000000007b1');
insert into public.projects (id, name) values ('bbbbbbbb-0000-0000-0000-0000000007b1', 'Bea project');
select pg_temp.act_as('00000000-0000-0000-0000-0000000007b2');
insert into public.projects (id, name) values ('bbbbbbbb-0000-0000-0000-0000000007b2', 'Pax project');
select pg_temp.act_as(null);

-- Internal plan (standard): calls are not charged.
select pg_temp.ai_call('00000000-0000-0000-0000-0000000007b1', 'bbbbbbbb-0000-0000-0000-0000000007b1', 0.5);
select pg_temp.check((select count(*) = 0 from public.billing_ledger where account_id = '00000000-0000-0000-0000-0000000007b1'), 'standard is not billed');

-- Studio needs its $50 fee in the balance first.
select pg_temp.act_as('00000000-0000-0000-0000-0000000007b1');
select pg_temp.check((select jsonb_array_length(public.my_billing()->'offers') = 3), 'three plans offered');
select pg_temp.expect_error($$select public.choose_plan('studio')$$, '%fee for this month is $50.00; add $50.00 of credit first%');
select pg_temp.expect_error($$select public.choose_plan('unlimited')$$, '%not on offer%');
select pg_temp.expect_error($$select public.add_credit('00000000-0000-0000-0000-0000000007b1', 1000, 'free money')$$, '%permission denied%');
select pg_temp.act_as(null);
select public.add_credit('00000000-0000-0000-0000-0000000007b1', 60, 'Bank transfer');
select pg_temp.act_as('00000000-0000-0000-0000-0000000007b1');
select public.choose_plan('studio');
select pg_temp.check((public.my_billing()->>'balance')::numeric = 10, 'fee charged: 60 - 50');
select public.my_billing();   -- visiting again charges nothing more
select pg_temp.act_as(null);
select pg_temp.check(pg_temp.balance('00000000-0000-0000-0000-0000000007b1') = 10, 'one fee a month');

-- Studio: AI at exact cost, one ledger line per call.
select pg_temp.ai_call('00000000-0000-0000-0000-0000000007b1', 'bbbbbbbb-0000-0000-0000-0000000007b1', 1.25);
select pg_temp.check((select amount_usd = -1.25 and cost_usd = 1.25 and kind = 'usage' and plan_id = 'studio' and cost_event_id is not null
  from public.billing_ledger where account_id = '00000000-0000-0000-0000-0000000007b1' and kind = 'usage'), 'charged at cost');
select pg_temp.check(pg_temp.balance('00000000-0000-0000-0000-0000000007b1') = 8.75, 'balance after the call');

-- Team mid-month: the fee difference ($100) is due; its $100 allowance covers this month's cost so far first.
select pg_temp.act_as('00000000-0000-0000-0000-0000000007b1');
select pg_temp.expect_error($$select public.choose_plan('team')$$, '%fee for this month is $100.00; add $91.25 of credit first%');
select pg_temp.act_as(null);
select public.add_credit('00000000-0000-0000-0000-0000000007b1', 200, 'Bank transfer');
select pg_temp.act_as('00000000-0000-0000-0000-0000000007b1');
select public.choose_plan('team');
select pg_temp.act_as(null);
select pg_temp.check(pg_temp.balance('00000000-0000-0000-0000-0000000007b1') = 108.75, 'difference charged: 208.75 - 100');
-- This month's cost so far is $1.75 (0.5 before billing + 1.25); a $3 call is inside the allowance.
select pg_temp.ai_call('00000000-0000-0000-0000-0000000007b1', 'bbbbbbbb-0000-0000-0000-0000000007b1', 3);
select pg_temp.check((select amount_usd = 0 and cost_usd = 3 and description like '%allowance%' from public.billing_ledger
  where account_id = '00000000-0000-0000-0000-0000000007b1' and kind = 'usage' order by id desc limit 1), 'inside the allowance: listed, not charged');
-- Past the allowance: only the part beyond $100 is charged.
select pg_temp.ai_call('00000000-0000-0000-0000-0000000007b1', 'bbbbbbbb-0000-0000-0000-0000000007b1', 97);
select pg_temp.check((select amount_usd = -1.75 from public.billing_ledger
  where account_id = '00000000-0000-0000-0000-0000000007b1' and kind = 'usage' order by id desc limit 1), 'the part beyond the allowance is charged');

-- Pay as you go: cost + 25%; at zero balance AI stops, plan builds too.
select public.add_credit('00000000-0000-0000-0000-0000000007b2', 1, 'Trial credit');
select pg_temp.act_as('00000000-0000-0000-0000-0000000007b2');
select public.choose_plan('pay_as_you_go');
select pg_temp.check(public.project_billing_rate('bbbbbbbb-0000-0000-0000-0000000007b2') = 1.25, 'rate for estimates');
select pg_temp.check(public.ai_spend_problem('bbbbbbbb-0000-0000-0000-0000000007b2') is null, 'can spend with credit');
select pg_temp.expect_error($$select public.ai_spend_problem('bbbbbbbb-0000-0000-0000-0000000007b1')$$, '%not a member%');
select pg_temp.act_as(null);
select pg_temp.ai_call('00000000-0000-0000-0000-0000000007b2', 'bbbbbbbb-0000-0000-0000-0000000007b2', 0.8);
select pg_temp.check(pg_temp.balance('00000000-0000-0000-0000-0000000007b2') = 0, 'charged 0.8 x 1.25 = 1.00');
select pg_temp.act_as('00000000-0000-0000-0000-0000000007b2');
select pg_temp.check(public.ai_spend_problem('bbbbbbbb-0000-0000-0000-0000000007b2') like '%prepaid balance is used up ($0.00)%', 'stopped at zero');
select pg_temp.act_as(null);
select pg_temp.check(public.account_quota_problem('00000000-0000-0000-0000-0000000007b2', 'run') like '%balance is used up%', 'runs wait too');

-- Card payments: only with the server's signature, for the signed-in account, once per payment.
insert into vx_private.secrets (name, value) values ('assistant_signing_key', repeat('k', 64)) on conflict (name) do nothing;
create temp table sigs as
  select vx_private.hmac_sha256(convert_to(k.value, 'UTF8'), convert_to(concat_ws(E'\n', 'vx-billing-v1',
           '00000000-0000-0000-0000-0000000007b2', '2000', 'stripe:cs_test_abcdef123', t.ts::text), 'UTF8')) as s, t.ts
    from vx_private.secrets k, (select (extract(epoch from now()) * 1000)::bigint as ts) t where k.name = 'assistant_signing_key';
grant select on sigs to authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-0000000007b2');
select public.note_checkout('cs_test_abcdef123', 2000);
select pg_temp.check(public.record_payment(2000, 'stripe:cs_test_abcdef123', 'Card payment', (select ts from sigs), (select s from sigs)) = 'recorded', 'payment recorded');
select pg_temp.check(public.record_payment(2000, 'stripe:cs_test_abcdef123', 'Card payment', (select ts from sigs), (select s from sigs)) = 'already recorded', 'recorded once');
select pg_temp.check((select status = 'paid' from public.billing_checkouts where session_id = 'cs_test_abcdef123'), 'checkout closed');
select pg_temp.expect_error($$select public.record_payment(200000, 'stripe:cs_test_abcdef123', 'x', (select ts from sigs), (select s from sigs))$$, '%signature does not match%');
select pg_temp.expect_error($$select public.record_payment(2000, 'stripe:cs_test_abcdef123', 'x', (select ts from sigs) - 600000, (select s from sigs))$$, '%must be signed by the server%');
-- Another account cannot replay the signature for itself.
select pg_temp.act_as('00000000-0000-0000-0000-0000000007b1');
select pg_temp.expect_error($$select public.record_payment(2000, 'stripe:cs_test_abcdef123', 'x', (select ts from sigs), (select s from sigs))$$, '%signature does not match%');
select pg_temp.act_as(null);
select pg_temp.check(pg_temp.balance('00000000-0000-0000-0000-0000000007b2') = 20, 'credit added');

-- Statements and privacy.
select pg_temp.act_as('00000000-0000-0000-0000-0000000007b1');
select pg_temp.check((select count(*) = 3 and min(opening_balance) = 0 and bool_or(project = 'Bea project' and activity = 'workspace_chat' and input_tokens = 1000)
  from public.my_statement(to_char(now() at time zone 'utc', 'YYYY-MM')) where kind in ('usage')
  ) , 'statement lists the calls with their detail');
select pg_temp.check((select count(*) = 0 from public.billing_ledger where account_id <> '00000000-0000-0000-0000-0000000007b1'), 'only my own ledger');
select pg_temp.expect_error($$select * from public.my_statement('2026-13')$$, '%YYYY-MM%');
select pg_temp.expect_error($$insert into public.billing_ledger (account_id, kind, amount_usd, description) values (auth.uid(), 'credit', 1000, 'x')$$, '%row-level security%');
select pg_temp.act_as(null);

-- Staff plans are locked.
select public.set_account_plan('00000000-0000-0000-0000-0000000007b3', 'unlimited');
select pg_temp.act_as('00000000-0000-0000-0000-0000000007b3');
select pg_temp.expect_error($$select public.choose_plan('studio')$$, '%set by staff%');
select pg_temp.act_as(null);

\o
select 'billing ok';
