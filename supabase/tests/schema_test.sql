-- Behavior tests for the initial schema. Run via scripts/test-db.sh.
-- Each check raises an exception on failure; the script stops at the first error.
\set ON_ERROR_STOP on
\o /dev/null

-- Supabase grants table privileges to these roles by default; mirror that here.
grant usage on schema public to authenticated, service_role;
grant all on all tables in schema public to authenticated, service_role;
grant all on all sequences in schema public to authenticated, service_role;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'alice@test'),
  ('00000000-0000-0000-0000-00000000000b', 'bob@test');

-- Helper to act as a signed-in user.
create function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), false);
  if p_user is null then
    execute 'reset role';
  else
    execute 'set role authenticated';
  end if;
end;
$$;

create function pg_temp.expect_error(p_sql text, p_like text) returns void language plpgsql as $$
declare
  v_err text;
begin
  begin
    execute p_sql;
  exception when others then
    v_err := sqlerrm;
  end;
  if v_err is null then
    raise exception 'statement should have failed but succeeded: %', p_sql;
  elsif v_err not like p_like then
    raise exception 'expected error like "%", got "%"', p_like, v_err;
  end if;
end;
$$;

-- 1. Alice creates a project and becomes its owner.
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
insert into public.projects (id, name) values ('11111111-1111-1111-1111-111111111111', 'Smart Slate');
-- The API inserts with RETURNING (checked against SELECT policies); this must work too.
create temp table created_project as
  with ins as (insert into public.projects (name) values ('Returning check') returning id) select id from ins;
do $$ begin
  if (select role from public.project_members
      where project_id = '11111111-1111-1111-1111-111111111111'
        and user_id = '00000000-0000-0000-0000-00000000000a') <> 'owner' then
    raise exception 'creator should be owner';
  end if;
end $$;

-- 2. Plan + tasks with a dependency chain: arch -> pwr -> sch.
insert into public.plans (id, project_id, version) values
  ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 1);
insert into public.tasks (id, project_id, plan_id, key, title, discipline) values
  ('33333333-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'arch', 'Architecture', 'architecture'),
  ('33333333-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'pwr',  'Power tree',   'power'),
  ('33333333-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'sch',  'Schematic',    'schematic');
insert into public.task_dependencies values
  ('33333333-0000-0000-0000-000000000002', '33333333-0000-0000-0000-000000000001'),
  ('33333333-0000-0000-0000-000000000003', '33333333-0000-0000-0000-000000000002');

-- 3. Cycles are rejected.
select pg_temp.expect_error(
  $$insert into public.task_dependencies values
    ('33333333-0000-0000-0000-000000000001', '33333333-0000-0000-0000-000000000003')$$,
  '%cycle%');

-- Approve the plan (owner submits and decides); its tasks become ready.
select public.submit_plan('22222222-2222-2222-2222-222222222222');
select public.decide_plan('22222222-2222-2222-2222-222222222222', true);

-- 4. Invalid state transitions are rejected.
select pg_temp.expect_error(
  $$update public.tasks set status = 'complete' where key = 'arch'$$,
  '%invalid task transition ready -> complete%');

-- 5. Bob (not a member) sees nothing and cannot write.
select pg_temp.act_as('00000000-0000-0000-0000-00000000000b');
do $$ begin
  if exists (select 1 from public.projects) or exists (select 1 from public.tasks) then
    raise exception 'non-member can see project data';
  end if;
end $$;
select pg_temp.expect_error(
  $$insert into public.plans (project_id, version) values ('11111111-1111-1111-1111-111111111111', 2)$$,
  '%row-level security%');

-- 6. Bob as a viewer can read but not write.
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
insert into public.project_members (project_id, user_id, role) values
  ('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-00000000000b', 'viewer');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000b');
do $$ begin
  if (select count(*) from public.tasks) <> 3 then raise exception 'viewer should read tasks'; end if;
end $$;
select pg_temp.expect_error(
  $$insert into public.plans (project_id, version) values ('11111111-1111-1111-1111-111111111111', 2)$$,
  '%row-level security%');

-- 7. Decisions are immutable; superseding creates a new row.
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
insert into public.decisions (id, project_id, decision_class, title, statement) values
  ('44444444-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'processor_family', 'MCU', 'Use an STM32H7 module');
-- Users have no UPDATE policy, so their update matches zero rows...
update public.decisions set statement = 'x' where id = '44444444-0000-0000-0000-000000000001';
-- ...and even the service role (bypasses RLS) is stopped by the trigger.
select pg_temp.act_as(null);
set role service_role;
select pg_temp.expect_error(
  $$update public.decisions set statement = 'x' where id = '44444444-0000-0000-0000-000000000001'$$,
  '%immutable%');
reset role;
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
do $$ begin
  if (select statement from public.decisions where id = '44444444-0000-0000-0000-000000000001') <> 'Use an STM32H7 module' then
    raise exception 'decision was modified';
  end if;
end $$;
insert into public.decisions (project_id, decision_class, title, statement, supersedes_id) values
  ('11111111-1111-1111-1111-111111111111', 'processor_family', 'MCU', 'Use a compute module', '44444444-0000-0000-0000-000000000001');
do $$ begin
  if (select count(*) from public.current_decisions) <> 1
     or (select statement from public.current_decisions) <> 'Use a compute module' then
    raise exception 'current_decisions should show only the superseding decision';
  end if;
end $$;

-- 8. Worker queue: only tasks with completed upstream are claimable; no double claims.
select pg_temp.act_as(null);
insert into public.runs (id, project_id, plan_id, mode, status, max_ai_spend_usd, max_compute_spend_usd)
values ('77777777-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
        '22222222-2222-2222-2222-222222222222', 'autonomous', 'running', 10, 10);
set role service_role;
do $$
declare e public.executions;
  r constant uuid := '77777777-0000-0000-0000-000000000001';
begin
  e := public.claim_next_task('worker-1', r);
  if e.task_id <> '33333333-0000-0000-0000-000000000001' then
    raise exception 'first claim should be arch, got %', e.task_id;
  end if;
  e := public.claim_next_task('worker-2', r);
  if e.id is not null then raise exception 'pwr must wait for arch; claimed %', e.task_id; end if;

  update public.tasks set status = 'validating' where key = 'arch';
  update public.tasks set status = 'complete'   where key = 'arch';
  e := public.claim_next_task('worker-2', r);
  if e.task_id <> '33333333-0000-0000-0000-000000000002' or e.attempt <> 1 then
    raise exception 'second claim should be pwr attempt 1';
  end if;
end $$;
reset role;

-- 9. Status changes were audited (3 on approval + 4 during execution).
do $$ begin
  if (select count(*) from public.audit_events where event_type = 'task.status_changed') <> 7 then
    raise exception 'expected 7 audited transitions, got %',
      (select count(*) from public.audit_events where event_type = 'task.status_changed');
  end if;
end $$;

-- 10. Committed artifact versions are frozen.
insert into public.artifacts (id, project_id, kind, name, created_by) values
  ('55555555-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'kicad_project', 'timecode-board', '00000000-0000-0000-0000-00000000000a');
insert into public.artifact_versions (id, artifact_id, project_id, version, storage_path, sha256) values
  ('66666666-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 1,
   '11111111-1111-1111-1111-111111111111/timecode-board/v1.zip', repeat('a', 64));
update public.artifact_versions set status = 'committed' where id = '66666666-0000-0000-0000-000000000001';
select pg_temp.expect_error(
  $$update public.artifact_versions set sha256 = repeat('b', 64) where id = '66666666-0000-0000-0000-000000000001'$$,
  '%cannot be modified%');
update public.artifact_versions set status = 'superseded' where id = '66666666-0000-0000-0000-000000000001';

\echo 'All schema tests passed.'
