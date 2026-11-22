-- AI usage records. Uses the lifecycle test project (Carol engineers, Cleo (…e3) is a client).
\set ON_ERROR_STOP on
\o /dev/null

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
create temp table ids (name text primary key, id uuid);
grant all on ids to authenticated, service_role;
create function pg_temp.id(p_name text) returns uuid language sql as $$ select id from ids where name = p_name $$;

-- A member records a call for the project; it is priced, timed and attributed.
select pg_temp.act_as('00000000-0000-0000-0000-00000000000c');
select pg_temp.check(public.record_ai_call('ffffffff-0000-0000-0000-000000000001', null, 'part_identify', 'claude-opus-5-5', 12000, 800, 3000, 0, 0.0646, 9100, false) = 'ok', 'recorded');
select pg_temp.check((select purpose = 'part_identify' and input_tokens = 12000 and output_tokens = 800 and cache_read_tokens = 3000 and duration_ms = 9100
  and cost_usd = 0.0646 and quantity = 15800 and user_id = '00000000-0000-0000-0000-00000000000c' and not failed and kind = 'ai_tokens'
  from public.cost_events where project_id = 'ffffffff-0000-0000-0000-000000000001' and purpose = 'part_identify' order by created_at desc limit 1), 'detail stored');
-- A failed call after the model ran is billed and marked.
select public.record_ai_call('ffffffff-0000-0000-0000-000000000001', null, 'generate_plan', 'claude-opus-5-5', 1000, 64000, 0, 0, 1.284, 300000, true);
select pg_temp.check((select failed from public.cost_events where purpose = 'generate_plan' and project_id = 'ffffffff-0000-0000-0000-000000000001' order by created_at desc limit 1), 'failed marked');
-- Members cannot charge a run, and outsiders cannot record against the project.
select pg_temp.expect_error($$select public.record_ai_call('ffffffff-0000-0000-0000-000000000001', gen_random_uuid(), 'x', 'claude-opus-5-5', 1, 1, 0, 0, 0, 1, false)$$, '%only workers%');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000ff');
select pg_temp.expect_error($$select public.record_ai_call('ffffffff-0000-0000-0000-000000000001', null, 'x', 'claude-opus-5-5', 1, 1, 0, 0, 0, 1, false)$$, '%not a member%');
-- Clients chat too: their questions are recorded, but cost reports stay with the staff.
select pg_temp.act_as('00000000-0000-0000-0000-0000000000e3');
select public.record_ai_call('ffffffff-0000-0000-0000-000000000001', null, 'workspace_chat', 'claude-opus-5-5', 5000, 400, 0, 0, 0.028, 6000, false);
select pg_temp.check((select count(*) = 0 from public.cost_events), 'clients do not read cost events');
select pg_temp.act_as(null);
select pg_temp.check((select count(*) = 1 from public.cost_events where purpose = 'workspace_chat' and user_id = '00000000-0000-0000-0000-0000000000e3'), 'client chat recorded');
delete from public.cost_events where project_id = 'ffffffff-0000-0000-0000-000000000001' and purpose in ('part_identify', 'generate_plan', 'workspace_chat');

\o
select 'ai usage ok';
