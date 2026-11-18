-- Stage gates and the risk register. Alice owns, Carol engineers, Dave reviews, Cleo is a client.
\set ON_ERROR_STOP on
\o /dev/null

insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000b1', 'cleo-client@stages.test');

create function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), false);
  if p_user is null then execute 'reset role'; else execute 'set role authenticated'; end if;
end;
$$;
create function pg_temp.as_worker() returns void language plpgsql as $$
begin perform set_config('request.jwt.claim.sub', '', false); execute 'set role service_role'; end;
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
create function pg_temp.task(p_key text) returns uuid language sql as
  $$ select id from public.tasks where plan_id = (select id from ids where name = 'plan') and key = p_key $$;
create function pg_temp.blockers(p_stage text) returns text language sql as $$
  select string_agg(b ->> 'text', ' | ') from jsonb_array_elements(
    (select s -> 'blockers' from jsonb_array_elements(public.stage_status('cccccccc-0000-0000-0000-000000000001')) s where s ->> 'stage' = p_stage)) b
$$;
create function pg_temp.claim() returns uuid language plpgsql as $$
declare e public.executions;
begin
  perform pg_temp.as_worker();
  e := public.claim_next_task('stage-worker', pg_temp.id('run'), 60, null);
  perform pg_temp.act_as(null);
  return e.task_id;
end;
$$;
create function pg_temp.finish(p_task uuid) returns void language plpgsql as $$
begin
  perform pg_temp.as_worker();
  update public.executions set status = 'succeeded', finished_at = now() where task_id = p_task and status = 'running';
  update public.tasks set status = 'validating' where id = p_task;
  update public.tasks set status = 'complete' where id = p_task;
  perform pg_temp.act_as(null);
end;
$$;

-- A project with three stages of work: arch (S2) -> sch (S3) -> src (S4).
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
insert into public.projects (id, name) values ('cccccccc-0000-0000-0000-000000000001', 'Stage test');
insert into public.project_members (project_id, user_id, role) values
  ('cccccccc-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000c', 'engineer'),
  ('cccccccc-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000d', 'reviewer'),
  ('cccccccc-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000b1', 'client');
insert into public.requirements (project_id, ref_code, kind, status, text) values
  ('cccccccc-0000-0000-0000-000000000001', 'REQ-PWR-001', 'power', 'extracted', 'Runs 10 hours on a Li-ion battery.'),
  ('cccccccc-0000-0000-0000-000000000001', 'REQ-IF-001', 'interface', 'ambiguous', 'Talks to phones.');
insert into ids select 'plan', public.create_plan_version('cccccccc-0000-0000-0000-000000000001', $json${
  "summary": "Stage test plan",
  "tasks": [
    {"key": "arch", "title": "Architecture", "discipline": "architecture"},
    {"key": "sch", "title": "Schematic", "discipline": "schematic", "upstream_keys": ["arch"]},
    {"key": "src", "title": "Sourcing", "discipline": "sourcing", "upstream_keys": ["sch"]}
  ]}$json$::jsonb);

-- 1. Stages from disciplines; editable only while the plan is a draft.
select pg_temp.check((select string_agg(key || '=' || stage, ',' order by position) from public.tasks where plan_id = pg_temp.id('plan'))
                     = 'arch=S2,sch=S3,src=S4', 'stages follow the discipline');
select public.set_task_stage(pg_temp.task('src'), 'S5');
select public.set_task_stage(pg_temp.task('src'), 'S4');
select public.submit_plan(pg_temp.id('plan'));
select public.decide_plan(pg_temp.id('plan'), true);
select pg_temp.expect_error(format($$select public.set_task_stage(%L, 'S5')$$, pg_temp.task('src')), 'the plan is approved; revise it%');

-- 2. Gates off (the default): the run works through the plan as before.
insert into ids select 'run', public.authorize_run(pg_temp.id('plan'), 'autonomous', 10, 10);
select pg_temp.check(pg_temp.claim() = pg_temp.task('arch'), 'without gates, S2 work starts at once');

-- 3. Gates on (owner only). The running task carries on; nothing new starts until S0 and S1 are signed off.
select pg_temp.act_as('00000000-0000-0000-0000-00000000000c');
select pg_temp.expect_error($$select public.set_stage_gates('cccccccc-0000-0000-0000-000000000001', true)$$, 'only the project owner%');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
select public.set_stage_gates('cccccccc-0000-0000-0000-000000000001', true);
select pg_temp.finish(pg_temp.task('arch'));
select pg_temp.check(pg_temp.claim() is null, 'S3 work waits for S0–S2 sign-off');
select pg_temp.check((select (s ->> 'current')::boolean from jsonb_array_elements(public.stage_status('cccccccc-0000-0000-0000-000000000001')) s
                       where s ->> 'stage' = 'S0'), 'S0 is the current stage');

-- 4. S0 blockers: no feasibility check, no intake, unreviewed requirements.
select pg_temp.check(pg_temp.blockers('S0') like 'run the feasibility check | intended use is not recorded%', 'S0 lists what is missing');
select pg_temp.check(pg_temp.blockers('S0') like '%REQ-IF-001 is ambiguous: confirm or reject it%no confirmed requirements yet%', 'requirements must be reviewed');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000d');
select pg_temp.expect_error($$select public.sign_off_stage('cccccccc-0000-0000-0000-000000000001', 'S2')$$, 'sign off the earlier stages first');
select pg_temp.expect_error($$select public.sign_off_stage('cccccccc-0000-0000-0000-000000000001', 'S0')$$, 'S0 cannot be signed off yet: run the feasibility check;%');
select pg_temp.expect_error($$select public.sign_off_stage('cccccccc-0000-0000-0000-000000000001', 'S0', 'close enough', true)$$, 'only the project owner can sign off past open items');

-- 5. Intake, feasibility findings and requirement review clear S0. A critical finding blocks until handled.
select pg_temp.act_as('00000000-0000-0000-0000-00000000000c');
select public.save_intake('cccccccc-0000-0000-0000-000000000001', '{"intended_use": "Film set timecode slate", "regions": ["US", "EU"],
  "quantity": "500", "target_unit_cost": "120", "power_source": "Li-ion 1S", "radios": ["Bluetooth LE"]}');
select public.record_feasibility('cccccccc-0000-0000-0000-000000000001', $j$[
  {"rule_key": "battery-lithium", "title": "Lithium battery", "description": "d", "category": "safety", "stage": "S2", "likelihood": 3, "impact": 4,
   "mitigation": "certified cells", "requirement_refs": ["REQ-PWR-001"], "evidence": [{"ref": "REQ-PWR-001", "excerpt": "Li-ion battery"}]},
  {"rule_key": "regulated-domain", "title": "Regulated domain", "description": "d", "category": "regulatory", "stage": "S0", "likelihood": 4, "impact": 5,
   "mitigation": "m", "requirement_refs": [], "evidence": []}]$j$, '["maximum dimensions"]');
select pg_temp.check((select count(*) from public.risks where project_id = 'cccccccc-0000-0000-0000-000000000001') = 2, 'findings filed as risks');
select pg_temp.check((select level from public.risks where rule_key = 'regulated-domain') = 'critical', '4 × 5 is critical');
update public.requirements set status = 'confirmed' where project_id = 'cccccccc-0000-0000-0000-000000000001';
select pg_temp.act_as(null);
select pg_temp.check(pg_temp.blockers('S0') = 'RISK-002 (critical) is unresolved: Regulated domain', 'only the critical risk is left');
-- Accepting a critical risk is the owner's call, with a reason.
select pg_temp.act_as('00000000-0000-0000-0000-00000000000c');
select pg_temp.expect_error(format($$select public.update_risk(%L, 'accepted', p_note => 'fine')$$,
  (select id from public.risks where rule_key = 'regulated-domain')), 'only the project owner can accept a critical risk');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
select pg_temp.expect_error(format($$select public.update_risk(%L, 'closed')$$, (select id from public.risks where rule_key = 'regulated-domain')), 'say why the risk is closed');
select public.update_risk((select id from public.risks where rule_key = 'regulated-domain'), 'closed', p_note => 'Not a medical device: the word was "patient" in a quote.');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000d');
select public.sign_off_stage('cccccccc-0000-0000-0000-000000000001', 'S0', 'Intake complete.');
select pg_temp.expect_error($$select public.sign_off_stage('cccccccc-0000-0000-0000-000000000001', 'S0')$$, 'S0 is already signed off');

-- 6. S1 without a design freeze: the owner signs off past it with a reason (recorded as a waiver).
select pg_temp.expect_error($$select public.sign_off_stage('cccccccc-0000-0000-0000-000000000001', 'S1')$$, 'S1 cannot be signed off yet: no design freeze recorded%');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
select pg_temp.expect_error($$select public.sign_off_stage('cccccccc-0000-0000-0000-000000000001', 'S1', '', true)$$, 'say why the stage is signed off with open items');
select public.sign_off_stage('cccccccc-0000-0000-0000-000000000001', 'S1', 'Internal tool: no industrial design.', true);
select pg_temp.check((select jsonb_array_length(waived) from public.stage_gates where stage = 'S1' and project_id = 'cccccccc-0000-0000-0000-000000000001') = 1, 'the waiver keeps what was waived');

-- 7. S2: its task is done, but the lithium risk is high (12): mitigate it, then sign off; S3 work starts.
select pg_temp.check(pg_temp.blockers('S2') = 'RISK-001 (high) is unresolved: Lithium battery', 'high risks block their stage');
select public.update_risk((select id from public.risks where rule_key = 'battery-lithium'), 'mitigating', p_likelihood => 2, p_mitigation => 'Pack with UN 38.3 report chosen.');
select pg_temp.check((select level from public.risks where rule_key = 'battery-lithium') = 'medium', 'rescoring changes the level');
select public.sign_off_stage('cccccccc-0000-0000-0000-000000000001', 'S2');
select pg_temp.check(pg_temp.claim() = pg_temp.task('sch'), 'after S2 sign-off, S3 work starts');
select pg_temp.finish(pg_temp.task('sch'));
select pg_temp.check(pg_temp.claim() is null, 'S4 waits for S3');

-- 8. Reopening S2 stops later work again until it is signed off again.
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
select public.sign_off_stage('cccccccc-0000-0000-0000-000000000001', 'S3');
select pg_temp.expect_error($$select public.reopen_stage('cccccccc-0000-0000-0000-000000000001', 'S2', ' ')$$, 'say why the stage is reopened');
select public.reopen_stage('cccccccc-0000-0000-0000-000000000001', 'S2', 'Battery supplier changed.');
select pg_temp.check(pg_temp.claim() is null, 'a reopened stage holds later work');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
select public.sign_off_stage('cccccccc-0000-0000-0000-000000000001', 'S2', 'New supplier checked.');
select pg_temp.check(pg_temp.claim() = pg_temp.task('src'), 'signed off again: S4 work starts');

-- 9. A second feasibility run: known findings keep people's decisions; vanished ones close; returning ones reopen.
select pg_temp.act_as('00000000-0000-0000-0000-00000000000c');
select public.record_feasibility('cccccccc-0000-0000-0000-000000000001', $j$[
  {"rule_key": "regulated-domain", "title": "Regulated domain", "description": "d", "category": "regulatory", "stage": "S0", "likelihood": 4, "impact": 5,
   "mitigation": "m", "requirement_refs": [], "evidence": []}]$j$, '[]');
select pg_temp.check((select status from public.risks where rule_key = 'regulated-domain') = 'closed', 'a person''s decision stands');
select pg_temp.check((select status || ':' || decision_note from public.risks where rule_key = 'battery-lithium')
                     = 'closed:no longer detected by the feasibility check', 'a finding no longer detected is closed');
select public.record_feasibility('cccccccc-0000-0000-0000-000000000001', $j$[
  {"rule_key": "battery-lithium", "title": "Lithium battery", "description": "d", "category": "safety", "stage": "S2", "likelihood": 3, "impact": 4,
   "mitigation": "m", "requirement_refs": ["REQ-PWR-001"], "evidence": []}]$j$, '[]');
select pg_temp.check((select status from public.risks where rule_key = 'battery-lithium') = 'open', 'it reopens when detected again');
select pg_temp.check((select count(*) from public.risks where project_id = 'cccccccc-0000-0000-0000-000000000001') = 2, 'no duplicates');

-- 10. Who may do what; everything is audited.
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select pg_temp.check((select count(*) from public.risks) = 2, 'clients can read the register');
select pg_temp.check(jsonb_array_length(public.stage_status('cccccccc-0000-0000-0000-000000000001')) = 9, 'clients can see the stages');
select pg_temp.expect_error($$select public.add_risk('cccccccc-0000-0000-0000-000000000001', 'x', 'technical', 'S3', 2, 2)$$, 'only owners, engineers and reviewers%');
select pg_temp.expect_error($$select public.sign_off_stage('cccccccc-0000-0000-0000-000000000001', 'S4')$$, 'only owners and reviewers%');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000ff');
select pg_temp.expect_error($$select public.stage_status('cccccccc-0000-0000-0000-000000000001')$$, 'project not found or not permitted');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000c');
select pg_temp.check(public.add_risk('cccccccc-0000-0000-0000-000000000001', 'Display lead time', 'supply', 'S4', 3, 3) is not null, 'engineers add risks');
select pg_temp.check((select risk_no from public.risks where title = 'Display lead time') = 3, 'numbered in order');
select pg_temp.act_as(null);
select pg_temp.check((select count(distinct event_type) from public.audit_events where project_id = 'cccccccc-0000-0000-0000-000000000001'
                      and event_type in ('stage.gates_on', 'stage.signed_off', 'stage.reopened', 'intake.saved', 'feasibility.checked',
                                         'risk.closed', 'risk.mitigating', 'risk.added')) = 8, 'every step is audited');

\o
select 'All stage gate and risk register tests passed.' as result;
