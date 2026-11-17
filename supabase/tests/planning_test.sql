-- G1 planning workflow tests. Runs after schema_test.sql (reuses its users and helpers' patterns).
\set ON_ERROR_STOP on
\o /dev/null

grant all on public.task_requirements to authenticated, service_role;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000c', 'carol-engineer@test'),
  ('00000000-0000-0000-0000-00000000000d', 'dave-reviewer@test');

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

-- Alice (owner) sets up a project with an engineer and a reviewer, plus requirements.
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
insert into public.projects (id, name) values ('aaaaaaaa-0000-0000-0000-000000000001', 'Timecode board');
insert into public.project_members (project_id, user_id, role) values
  ('aaaaaaaa-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000c', 'engineer'),
  ('aaaaaaaa-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000d', 'reviewer');
insert into public.requirements (project_id, ref_code, kind, text, priority, block_id) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'REQ-PWR-001', 'power', '5 V input', 'must', 'S2.p1'),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'REQ-IFC-001', 'interface', 'LTC output', 'must', 'S2.1.p1');

-- 1. Carol (engineer) stores a generated plan atomically.
select pg_temp.act_as('00000000-0000-0000-0000-00000000000c');
create temp table ids (name text primary key, id uuid);
grant all on ids to authenticated;
insert into ids select 'v1', public.create_plan_version('aaaaaaaa-0000-0000-0000-000000000001', $json${
  "summary": "First plan",
  "generator": {"model": "scripted", "prompt_version": "plan-v1"},
  "tasks": [
    {"key": "arch", "title": "Architecture", "discipline": "architecture", "requirement_refs": ["REQ-PWR-001"],
     "upstream_keys": [], "risk_level": "high", "approval_required": true, "approval_reason": "component choice",
     "acceptance_tests": [{"id": "AT1", "description": "reviewed", "method": "human_review"}], "estimated_hours": 6},
    {"key": "sch", "title": "Schematic", "discipline": "schematic", "requirement_refs": ["REQ-IFC-001"],
     "upstream_keys": ["arch"], "required_tools": ["kicad"]}
  ]}$json$::jsonb);
select pg_temp.check((select count(*) = 2 from public.tasks where plan_id = (select id from ids where name = 'v1')), 'two tasks');
select pg_temp.check((select count(*) = 2 from public.task_requirements tr join public.tasks t on t.id = tr.task_id
                      where t.plan_id = (select id from ids where name = 'v1')), 'requirement links');
select pg_temp.check((select (approval_policy ->> 'required')::boolean from public.tasks where key = 'arch'
                      and plan_id = (select id from ids where name = 'v1')), 'approval policy stored');

-- 2. Bad payloads leave nothing behind (atomic).
select pg_temp.expect_error($$select public.create_plan_version('aaaaaaaa-0000-0000-0000-000000000001',
  '{"tasks":[{"key":"x","title":"X","discipline":"power","requirement_refs":["REQ-NOPE-001"]}]}')$$, '%unknown requirement REQ-NOPE-001%');
select pg_temp.expect_error($$select public.create_plan_version('aaaaaaaa-0000-0000-0000-000000000001',
  '{"tasks":[{"key":"x","title":"X","discipline":"power","upstream_keys":["ghost"]}]}')$$, '%unknown task ghost%');
select pg_temp.expect_error($$select public.create_plan_version('aaaaaaaa-0000-0000-0000-000000000001',
  '{"tasks":[{"key":"a","title":"A","discipline":"power","upstream_keys":["b"]},{"key":"b","title":"B","discipline":"power","upstream_keys":["a"]}]}')$$, '%dependency order%');
select pg_temp.expect_error($$select public.create_plan_version('aaaaaaaa-0000-0000-0000-000000000001',
  '{"tasks":[{"key":"a","title":"A","discipline":"power"},{"key":"a","title":"A2","discipline":"power"}]}')$$, '%duplicate task key a%');
select pg_temp.check((select count(*) = 1 from public.plans where project_id = 'aaaaaaaa-0000-0000-0000-000000000001'), 'failed payloads rolled back');
select pg_temp.check((select array_agg(key order by position) = '{arch,sch}' from public.tasks
                      where plan_id = (select id from ids where name = 'v1')), 'positions follow payload order');

-- 3. Drafts are editable; approval cannot be faked.
update public.tasks set title = 'System architecture' where key = 'arch' and plan_id = (select id from ids where name = 'v1');
select pg_temp.expect_error($$update public.plans set status = 'approved' where id = (select id from ids where name = 'v1')$$,
  '%go through submit_plan%');
select pg_temp.expect_error($$insert into public.plans (project_id, version, status, approved_by, approved_at)
  values ('aaaaaaaa-0000-0000-0000-000000000001', 9, 'approved', auth.uid(), now())$$, '%new plans start as draft%');
select pg_temp.expect_error($$update public.tasks set status = 'ready' where plan_id = (select id from ids where name = 'v1')$$,
  '%leave draft only when their plan is approved%');
select pg_temp.expect_error($$select public.decide_plan((select id from ids where name = 'v1'), true)$$, '%not permitted%');

-- 4. Submit freezes the plan; the engineer cannot approve, the reviewer can.
select public.submit_plan((select id from ids where name = 'v1'));
select pg_temp.expect_error($$update public.tasks set title = 'x' where plan_id = (select id from ids where name = 'v1')$$,
  '%plan is awaiting_approval%');
select pg_temp.expect_error($$delete from public.task_dependencies where task_id in (select id from public.tasks where plan_id = (select id from ids where name = 'v1'))$$,
  '%plan is awaiting_approval%');

-- Reviewer returns it with a note -> back to draft, approval row rejected.
select pg_temp.act_as('00000000-0000-0000-0000-00000000000d');
select public.decide_plan((select id from ids where name = 'v1'), false, 'Split the schematic task');
select pg_temp.check((select status = 'draft' from public.plans where id = (select id from ids where name = 'v1')), 'returned to draft');
select pg_temp.check((select status = 'rejected' and response_note = 'Split the schematic task' from public.approvals
                      where plan_id = (select id from ids where name = 'v1')), 'rejection recorded');

-- Resubmit and approve.
select pg_temp.act_as('00000000-0000-0000-0000-00000000000c');
select public.submit_plan((select id from ids where name = 'v1'));
select pg_temp.act_as('00000000-0000-0000-0000-00000000000d');
select public.decide_plan((select id from ids where name = 'v1'), true, 'Looks right');
select pg_temp.check((select status = 'approved' and approved_by = '00000000-0000-0000-0000-00000000000d'
                      from public.plans where id = (select id from ids where name = 'v1')), 'approved by reviewer');
select pg_temp.check((select bool_and(status = 'ready') from public.tasks where plan_id = (select id from ids where name = 'v1')), 'tasks ready');

-- 5. The approved baseline is frozen, but execution fields still change.
select pg_temp.act_as('00000000-0000-0000-0000-00000000000c');
select pg_temp.expect_error($$update public.tasks set description = 'x' where plan_id = (select id from ids where name = 'v1')$$,
  '%plan is approved%');
select pg_temp.expect_error($$update public.plans set summary = 'x' where id = (select id from ids where name = 'v1')$$,
  '%revise it to make changes%');
update public.tasks set status = 'blocked', blocker_reason = 'waiting for parts'
 where key = 'sch' and plan_id = (select id from ids where name = 'v1');

-- 6. Revise -> new draft v2 with identical structure; approving v2 supersedes v1.
insert into ids select 'v2', public.revise_plan((select id from ids where name = 'v1'));
select pg_temp.check((select version = 2 and status = 'draft' and revised_from_id = (select id from ids where name = 'v1')
                      from public.plans where id = (select id from ids where name = 'v2')), 'v2 draft');
select pg_temp.check((select count(*) = 1 from public.task_dependencies d join public.tasks t on t.id = d.task_id
                      where t.plan_id = (select id from ids where name = 'v2')), 'dependencies copied');
select pg_temp.check((select array_agg(key order by position) = '{arch,sch}' from public.tasks
                      where plan_id = (select id from ids where name = 'v2')), 'revision keeps task order');
select pg_temp.check((select count(*) = 2 from public.task_requirements tr join public.tasks t on t.id = tr.task_id
                      where t.plan_id = (select id from ids where name = 'v2')), 'requirement links copied');
update public.tasks set title = 'Schematic capture' where key = 'sch' and plan_id = (select id from ids where name = 'v2');
select public.submit_plan((select id from ids where name = 'v2'));
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
select public.decide_plan((select id from ids where name = 'v2'), true);
select pg_temp.check((select status = 'superseded' from public.plans where id = (select id from ids where name = 'v1')), 'v1 superseded');
select pg_temp.check((select bool_and(status = 'superseded') from public.tasks where plan_id = (select id from ids where name = 'v1')), 'v1 tasks superseded');
select pg_temp.check((select count(*) = 1 from public.plans where project_id = 'aaaaaaaa-0000-0000-0000-000000000001' and status = 'approved'), 'one baseline');

-- 7. Supersede is refused while the baseline has running work.
select pg_temp.act_as(null);
set role service_role;
select public.claim_next_task('worker-1');
reset role;
select pg_temp.act_as('00000000-0000-0000-0000-00000000000c');
insert into ids select 'v3', public.revise_plan((select id from ids where name = 'v2'));
select public.submit_plan((select id from ids where name = 'v3'));
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
select pg_temp.expect_error($$select public.decide_plan((select id from ids where name = 'v3'), true)$$, '%running tasks%');

-- 8. Audit trail and project deletion still work with frozen plans.
select pg_temp.check((select count(*) >= 6 from public.audit_events where project_id = 'aaaaaaaa-0000-0000-0000-000000000001'
                      and event_type like 'plan.%'), 'plan events audited');
delete from public.projects where id = 'aaaaaaaa-0000-0000-0000-000000000001';
select pg_temp.check((select count(*) = 0 from public.tasks where project_id = 'aaaaaaaa-0000-0000-0000-000000000001'), 'project deleted');

\echo 'All planning tests passed.'
