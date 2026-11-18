-- Inspection plans. Uses the lifecycle test project (Alice owns, Carol engineers, Dave reviews, Cleo is a client).
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
select pg_temp.expect_error($$select public.save_inspection_plan('ffffffff-0000-0000-0000-000000000001', null, 'pcba', 'x',
  '{}', '[{"key": "a", "stage": "later", "sample": "100%", "characteristic": "c", "method": "m", "acceptance": "a"}]')$$, 'a: stage is incoming%');
select pg_temp.expect_error($$select public.save_inspection_plan('ffffffff-0000-0000-0000-000000000001', null, 'pcba', 'x',
  '{}', '[{"key": "a", "stage": "final", "sample": "100%", "characteristic": "c", "method": "m", "acceptance": "a"}, {"key": "a", "stage": "final", "sample": "100%", "characteristic": "c", "method": "m", "acceptance": "a"}]')$$, 'item key a is used twice');
insert into ids select 'p1', public.save_inspection_plan('ffffffff-0000-0000-0000-000000000001', null, 'pcba', 'Main board', '{"artifact": "fab/fab-check"}',
  '[{"key": "outline", "stage": "incoming", "sample": "sample", "characteristic": "Outline", "method": "Calliper", "acceptance": "34 x 22 ± 0.2", "reference": "", "critical": false}]');
select pg_temp.expect_error(format($$select public.approve_inspection_plan(%L, 'ok')$$, pg_temp.id('p1')), 'only owner, reviewer%');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000d');
select public.approve_inspection_plan(pg_temp.id('p1'), 'Matches the fab notes.');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000c');
select pg_temp.expect_error(format($$select public.save_inspection_plan('ffffffff-0000-0000-0000-000000000001', %L, 'pcba', 'x', '{}', '[]')$$, pg_temp.id('p1')), '%approved (revise it%');
insert into ids select 'p2', public.revise_inspection_plan(pg_temp.id('p1'));
select pg_temp.check((select version = 2 and status = 'draft' and plan_no = 1 from public.inspection_plans where id = pg_temp.id('p2')), 'v2 draft');
select pg_temp.expect_error(format($$select public.revise_inspection_plan(%L)$$, pg_temp.id('p1')), 'a newer version of this plan already exists');
select public.save_inspection_plan('ffffffff-0000-0000-0000-000000000001', pg_temp.id('p2'), 'pcba', 'Main board', null,
  '[{"key": "outline", "stage": "incoming", "sample": "sample", "characteristic": "Outline", "method": "Calliper", "acceptance": "34 x 22 ± 0.15", "reference": "", "critical": false}]');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000d');
select public.approve_inspection_plan(pg_temp.id('p2'), null);
select pg_temp.check((select status = 'superseded' from public.inspection_plans where id = pg_temp.id('p1')), 'v1 superseded');
select pg_temp.act_as(null);
select pg_temp.expect_error(format($$update public.inspection_plans set items = '[]' where id = %L$$, pg_temp.id('p2')), '%cannot be changed%');

-- Lots use an approved plan of their project.
insert into public.releases (id, project_id, release_no, revision, status, manifest, manifest_sha256, released_at)
values ('ffffffff-0000-0000-0000-0000000000d1', 'ffffffff-0000-0000-0000-000000000001', 50, 'Z', 'released', '[]', repeat('a', 64), now());
insert into public.production_lots (id, project_id, lot_no, release_id, quantity, sample_size) values
  ('ffffffff-0000-0000-0000-0000000000d2', 'ffffffff-0000-0000-0000-000000000001', 50, 'ffffffff-0000-0000-0000-0000000000d1', 10, 5);
select pg_temp.act_as('00000000-0000-0000-0000-00000000000c');
select pg_temp.expect_error(format($$select public.set_lot_inspection_plan('ffffffff-0000-0000-0000-0000000000d2', %L)$$, pg_temp.id('p1')), 'choose an approved inspection plan%');
select public.set_lot_inspection_plan('ffffffff-0000-0000-0000-0000000000d2', pg_temp.id('p2'));
select pg_temp.check((select inspection_plan_id = pg_temp.id('p2') from public.production_lots where id = 'ffffffff-0000-0000-0000-0000000000d2'), 'lot linked');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000e3');
select pg_temp.check((select count(*) = 2 from public.inspection_plans), 'clients read plans');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000e2');
select pg_temp.check((select count(*) = 0 from public.inspection_plans), 'outsiders see none');

\o
select 'All inspection plan tests passed.' as result;
