-- Mechanical analyses. Uses the lifecycle test project (Alice owns, Carol engineers, Dave reviews, Cleo is a client).
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

select pg_temp.act_as('00000000-0000-0000-0000-0000000000e3');   -- client
select pg_temp.expect_error($$select public.save_mech_analysis('ffffffff-0000-0000-0000-000000000001', null, 'gasket', 'x', null, '{}', '{}', 'pass', 0, 'mech-v1')$$, 'only owner, engineer%');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000c');   -- engineer
insert into ids select 'a', public.save_mech_analysis('ffffffff-0000-0000-0000-000000000001', null, 'tolerance_stack', 'Board to wall', null,
  '{"contributors": []}', '{"worst": {"min": -0.1}}', 'pass_statistical', 2, 'mech-v1');
select pg_temp.expect_error($$select public.save_mech_analysis('ffffffff-0000-0000-0000-000000000001', null, 'stress', 'x', null, '{}', '{}', 'pass', 0, 'mech-v1')$$, '%mech_analyses_kind_check%');
select pg_temp.expect_error(format($$select public.review_mech_analysis(%L, 'ok')$$, pg_temp.id('a')), 'only owner, reviewer%');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000d');   -- reviewer
select pg_temp.expect_error(format($$select public.review_mech_analysis(%L, ' ')$$, pg_temp.id('a')), 'write the review note');
select public.review_mech_analysis(pg_temp.id('a'), 'RSS clear; board shift assumption to confirm with the screw size.');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000c');
select pg_temp.expect_error(format($$select public.delete_mech_analysis(%L)$$, pg_temp.id('a')), 'a reviewed analysis is kept%');
select public.save_mech_analysis('ffffffff-0000-0000-0000-000000000001', pg_temp.id('a'), 'tolerance_stack', 'Board to wall', 'gap raised to 0.7', '{"contributors": []}', '{}', 'pass', 2, 'mech-v1');
select pg_temp.check((select reviewed_at is null and analysis_no = 1 and note = 'gap raised to 0.7' from public.mech_analyses where id = pg_temp.id('a')), 'an edit clears the review');
select pg_temp.expect_error(format($$select public.save_mech_analysis('ffffffff-0000-0000-0000-000000000001', %L, 'gasket', 'x', null, '{}', '{}', 'pass', 0, 'mech-v1')$$, pg_temp.id('a')), 'analysis not found');
select public.delete_mech_analysis(pg_temp.id('a'));
select pg_temp.act_as('00000000-0000-0000-0000-0000000000e2');
select pg_temp.check((select count(*) = 0 from public.mech_analyses), 'outsiders see none');
select pg_temp.act_as(null);
select pg_temp.check((select count(*) = 4 from public.audit_events where event_type like 'mech.%' and project_id = 'ffffffff-0000-0000-0000-000000000001'), 'audited');

\o
select 'All mechanical analysis tests passed.' as result;
