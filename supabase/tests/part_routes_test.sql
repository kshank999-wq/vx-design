-- Manufacturing routes. Uses the lifecycle test project (Carol engineers, Dave reviews,
-- Cleo is a client).
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

select pg_temp.act_as('00000000-0000-0000-0000-00000000000c');
insert into ids select 'r1', public.save_part_route('ffffffff-0000-0000-0000-000000000001', null, 'Enclosure base', 'artifact:enc/base',
  '{"outdoor": true, "impact": true}', 'fdm_asa', 3, 'injection_molding', 'pc_abs', 5000, 'matte black', null);
select pg_temp.check((select production_process = 'injection_molding' and needs ->> 'outdoor' = 'true' from public.part_routes where id = pg_temp.id('r1')), 'saved');
select pg_temp.expect_error($$select public.save_part_route('ffffffff-0000-0000-0000-000000000001', null, 'enclosure BASE ', null, '{}', null, null, null, null, null, null, null)$$, '%already has a route%');
select pg_temp.expect_error($$select public.save_part_route('ffffffff-0000-0000-0000-000000000001', null, 'Lid', null, '{}', null, null, 'vacuum_forming', null, null, null, null)$$, '%check constraint%');
select pg_temp.expect_error($$select public.save_part_route('ffffffff-0000-0000-0000-000000000001', null, 'Lid', 'ref:00000000-0000-0000-0000-000000000000', '{}', null, null, null, null, null, null, null)$$, '%not in this project%');
select public.save_part_route('ffffffff-0000-0000-0000-000000000001', pg_temp.id('r1'), 'Enclosure base', null, '{}', 'mjf_pa12', 10, 'injection_molding', 'pc_abs', 5000, null, 'pilot batch');
select pg_temp.check((select prototype_option = 'mjf_pa12' and source_key = 'artifact:enc/base' from public.part_routes where id = pg_temp.id('r1')), 'edited; the model link stays');

select pg_temp.act_as('00000000-0000-0000-0000-00000000000d');
select pg_temp.check((select count(*) = 1 from public.part_routes where project_id = 'ffffffff-0000-0000-0000-000000000001'), 'reviewer reads routes');
select pg_temp.expect_error($$select public.remove_part_route(pg_temp.id('r1'))$$, 'only owner, engineer%');

select pg_temp.act_as('00000000-0000-0000-0000-00000000000c');
select public.remove_part_route(pg_temp.id('r1'));
select pg_temp.check((select count(*) = 0 from public.part_routes where project_id = 'ffffffff-0000-0000-0000-000000000001'), 'removed');

\o
select 'All manufacturing route tests passed.' as result;
