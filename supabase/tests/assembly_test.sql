-- Assembly instructions. Uses the lifecycle test project (Carol engineers, Dave reviews,
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
insert into ids select 'a1', public.create_assembly_instructions('ffffffff-0000-0000-0000-000000000001',
  '{"title": "Slate", "steps": [{"title": "Fit the display"}]}', '[]', 'm', '[]', 'use the jig', null);
select public.update_assembly_instructions(pg_temp.id('a1'), '{"title": "Slate", "steps": [{"title": "Fit the display"}, {"title": "Close"}]}');
select pg_temp.expect_error($$select public.update_assembly_instructions(pg_temp.id('a1'), '{"steps": 3}')$$, '%check constraint%');
select pg_temp.expect_error($$select public.approve_assembly_instructions(pg_temp.id('a1'))$$, 'only owner, reviewer%');
insert into ids select 'a2', public.create_assembly_instructions('ffffffff-0000-0000-0000-000000000001', '{"title": "Slate", "steps": []}', '[]', 'm', '[]', null, null);
select pg_temp.check((select status = 'superseded' from public.assembly_instructions where id = pg_temp.id('a1')), 'one draft at a time');

select pg_temp.act_as('00000000-0000-0000-0000-00000000000d');
select pg_temp.expect_error($$select public.approve_assembly_instructions(pg_temp.id('a2'))$$, 'there are no steps%');
select pg_temp.expect_error($$select public.approve_assembly_instructions(pg_temp.id('a1'))$$, 'only a draft%');
select pg_temp.expect_error($$select public.update_assembly_instructions(pg_temp.id('a2'), '{"steps": []}')$$, 'only owner, engineer%');

select pg_temp.act_as('00000000-0000-0000-0000-00000000000c');
insert into ids select 'a3', public.create_assembly_instructions('ffffffff-0000-0000-0000-000000000001', '{"title": "Slate", "steps": [{"title": "x"}]}', '[]', 'm', '[]', null, pg_temp.id('a1'));
select pg_temp.act_as('00000000-0000-0000-0000-00000000000d');
select public.approve_assembly_instructions(pg_temp.id('a3'));
select pg_temp.check((select status = 'approved' and approved_by = '00000000-0000-0000-0000-00000000000d' and version = 3 from public.assembly_instructions where id = pg_temp.id('a3')), 'approved');

select pg_temp.act_as('00000000-0000-0000-0000-00000000000c');
select pg_temp.expect_error($$select public.update_assembly_instructions(pg_temp.id('a3'), '{"steps": []}')$$, 'version 3 is approved%');
insert into ids select 'a4', public.create_assembly_instructions('ffffffff-0000-0000-0000-000000000001', '{"title": "Slate", "steps": [{"title": "y"}]}', '[]', 'm', '[]', null, pg_temp.id('a3'));
select pg_temp.act_as('00000000-0000-0000-0000-00000000000d');
select public.approve_assembly_instructions(pg_temp.id('a4'));
select pg_temp.check((select status = 'superseded' from public.assembly_instructions where id = pg_temp.id('a3')), 'the previous approved version is superseded');

\o
select 'All assembly instruction tests passed.' as result;
