-- G2 worker backbone tests: runs, claims, leases, checkpoints, locks, fenced commits, budgets.
-- Runs after schema_test.sql and planning_test.sql (reuses their users).
\set ON_ERROR_STOP on
\o /dev/null

grant all on public.execution_logs to authenticated, service_role;
grant select on public.workers to authenticated;

insert into auth.users (id, email) values ('00000000-0000-0000-0000-00000000000e', 'erin-viewer@test');

create function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), false);
  if p_user is null then execute 'reset role'; else execute 'set role authenticated'; end if;
end;
$$;
create function pg_temp.as_worker() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', '', false);
  execute 'set role service_role';
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
create function pg_temp.task(p_key text) returns uuid language sql as
  $$ select id from public.tasks where plan_id = (select id from ids where name = 'plan') and key = p_key $$;

-- Project: Alice owns, Carol engineers, Dave reviews, Erin views. Approved plan:
--   arch (approval required) -> pwr -> layout ; mech (independent, high risk)
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
insert into public.projects (id, name) values ('bbbbbbbb-0000-0000-0000-000000000001', 'Worker test');
insert into public.project_members (project_id, user_id, role) values
  ('bbbbbbbb-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000c', 'engineer'),
  ('bbbbbbbb-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000d', 'reviewer'),
  ('bbbbbbbb-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000e', 'viewer');
insert into ids select 'plan', public.create_plan_version('bbbbbbbb-0000-0000-0000-000000000001', $json${
  "summary": "Worker test plan",
  "tasks": [
    {"key": "arch", "title": "Architecture", "discipline": "architecture", "risk_level": "medium",
     "approval_required": true, "approval_reason": "processor family choice"},
    {"key": "pwr", "title": "Power budget", "discipline": "documentation", "upstream_keys": ["arch"]},
    {"key": "layout", "title": "Layout", "discipline": "documentation", "upstream_keys": ["pwr"]},
    {"key": "mech", "title": "Enclosure", "discipline": "documentation", "risk_level": "high"}
  ]}$json$::jsonb);
select public.submit_plan(pg_temp.id('plan'));
select public.decide_plan(pg_temp.id('plan'), true);

-- 1. Authorizing a run.
select pg_temp.act_as('00000000-0000-0000-0000-00000000000e');
select pg_temp.expect_error($$select public.authorize_run(pg_temp.id('plan'), 'professional', 1, 1)$$, '%not permitted%');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000c');
select pg_temp.expect_error($$select public.authorize_run(pg_temp.id('plan'), 'professional', 1, 1, '{low,critical}')$$,
  '%only the project owner can authorize critical%');
select pg_temp.expect_error($$insert into public.runs (project_id, plan_id, mode, status, max_ai_spend_usd, max_compute_spend_usd)
  values ('bbbbbbbb-0000-0000-0000-000000000001', pg_temp.id('plan'), 'autonomous', 'running', 1, 1)$$, '%row-level security%');
insert into ids select 'run1', public.authorize_run(pg_temp.id('plan'), 'professional', 0.50, 0.20, '{low,medium}', 1);
select pg_temp.expect_error($$select public.authorize_run(pg_temp.id('plan'), 'professional', 1, 1)$$, '%already has an active run%');
-- Clients cannot change run budgets or status directly (no policy; the update matches no rows).
update public.runs set max_ai_spend_usd = 1000, status = 'completed' where id = pg_temp.id('run1');
select pg_temp.check((select max_ai_spend_usd = 0.50 and status = 'running' from public.runs where id = pg_temp.id('run1')),
  'direct run update ignored');
-- Clients cannot fake execution state or commit artifacts.
select pg_temp.expect_error($$update public.tasks set status = 'running' where id = pg_temp.task('arch')$$,
  '%set by the worker or the approval workflow%');
select pg_temp.expect_error($$insert into public.artifacts (project_id, kind, name)
  values ('bbbbbbbb-0000-0000-0000-000000000001', 'report', 'fake')$$, '%row-level security%');

-- 2. Pause stops claims; resume allows them; claims follow plan order and run scope.
select public.control_run(pg_temp.id('run1'), 'pause');
select pg_temp.as_worker();
select pg_temp.check((select (public.claim_next_task('w1', pg_temp.id('run1'))).id is null), 'paused run claims nothing');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000c');
select pg_temp.expect_error($$select public.control_run(pg_temp.id('run1'), 'pause')$$, '%cannot pause a run that is paused%');
select public.control_run(pg_temp.id('run1'), 'resume');
select pg_temp.as_worker();
insert into ids select 'e1', (public.claim_next_task('w1', pg_temp.id('run1'), 30)).id;
select pg_temp.check((select task_id = pg_temp.task('arch') and attempt = 1 and worker_id = 'w1'
                      from public.executions where id = pg_temp.id('e1')), 'arch claimed first');
-- mech is high risk (outside the run's scope); pwr waits for arch: nothing else to claim.
select pg_temp.check((select (public.claim_next_task('w2', pg_temp.id('run1'))).id is null), 'nothing else claimable');
select pg_temp.check((select (public.run_progress(pg_temp.id('run1')) ->> 'in_flight')::int = 1
                         and (public.run_progress(pg_temp.id('run1')) ->> 'total')::int = 3), 'progress counts scope');

-- 3. Heartbeats, checkpoints, locks and scratch outputs.
select pg_temp.check(public.heartbeat_execution(pg_temp.id('e1'), 'w1', '{"step": "context"}') = 'continue', 'heartbeat ok');
select pg_temp.check(public.heartbeat_execution(pg_temp.id('e1'), 'w1', '{"step": "drafted", "draft": "v1"}') = 'continue', 'checkpoint 2');
select pg_temp.check(public.heartbeat_execution(pg_temp.id('e1'), 'w-other') = 'lost', 'other worker cannot heartbeat');
insert into ids select 'art', public.acquire_artifact_lock(pg_temp.id('e1'), 'w1', 'arch/brief', 'report');
insert into ids select 'v1', public.add_scratch_version(pg_temp.id('e1'), 'w1', pg_temp.id('art'),
  'bbbbbbbb-0000-0000-0000-000000000001/artifacts/arch/aaa', repeat('a', 64), 10, 'text/markdown', 'vx-brief', '0.1');
select pg_temp.check(public.add_scratch_version(pg_temp.id('e1'), 'w1', pg_temp.id('art'),
  'bbbbbbbb-0000-0000-0000-000000000001/artifacts/arch/aaa', repeat('a', 64), 10, 'text/markdown', 'vx-brief', '0.1')
  = pg_temp.id('v1'), 'scratch registration is idempotent');

-- 4. The worker dies. Its lease expires, the reaper reclaims the task, the zombie is fenced off.
update public.executions set heartbeat_at = now() - interval '5 minutes' where id = pg_temp.id('e1');
select pg_temp.check(public.reap_stale_executions() = 1, 'one execution reaped');
select pg_temp.check((select status = 'ready' and interruptions = 1 from public.tasks where id = pg_temp.task('arch')), 'task back to ready');
select pg_temp.check((select locked_by_execution_id is null from public.artifacts where id = pg_temp.id('art')), 'lock released');
select pg_temp.check(public.heartbeat_execution(pg_temp.id('e1'), 'w1') = 'lost', 'zombie heartbeat is told it lost the lease');
select pg_temp.expect_error($$select public.begin_validation(pg_temp.id('e1'), 'w1')$$, '%no longer held by worker w1%');

-- A new worker resumes the same attempt from the checkpoint.
insert into ids select 'e2', (public.claim_next_task('w2', pg_temp.id('run1'))).id;
select pg_temp.check((select task_id = pg_temp.task('arch') and attempt = 1 and resumed_from_id = pg_temp.id('e1')
                         and checkpoint ->> 'draft' = 'v1' and checkpoint_seq = 2
                      from public.executions where id = pg_temp.id('e2')), 'resumed with checkpoint, same attempt');
select pg_temp.check((select attempts = 1 from public.tasks where id = pg_temp.task('arch')), 'resume does not use an attempt');
select pg_temp.check(public.acquire_artifact_lock(pg_temp.id('e2'), 'w2', 'arch/brief', 'report') = pg_temp.id('art'), 'lock re-acquired');
select pg_temp.check(public.add_scratch_version(pg_temp.id('e2'), 'w2', pg_temp.id('art'),
  'bbbbbbbb-0000-0000-0000-000000000001/artifacts/arch/aaa', repeat('a', 64), 10, 'text/markdown', 'vx-brief', '0.1')
  = pg_temp.id('v1'), 're-uploading after resume reuses the scratch version');
select pg_temp.expect_error($$select public.add_scratch_version(pg_temp.id('e1'), 'w1', pg_temp.id('art'), 'x', repeat('b', 64),
  1, 'text/plain', 't', '1')$$, '%no longer held%');

-- 5. Validation passes; arch needs sign-off, so outputs are validated but not committed.
select public.begin_validation(pg_temp.id('e2'), 'w2');
select pg_temp.expect_error($$select public.complete_execution(pg_temp.id('e2'), 'w2',
  '[{"kind":"acceptance_test","result":"fail","evidence_category":"unverified_assumption","summary":"x"}]')$$, '%use fail_execution%');
select pg_temp.check(public.complete_execution(pg_temp.id('e2'), 'w2',
  '[{"kind":"acceptance_test","result":"pass","evidence_category":"unverified_assumption","summary":"all sections present"}]',
  'Drafted brief') = 'awaiting_approval', 'arch awaits approval');
select pg_temp.check((select status = 'scratch' and validated_at is not null from public.artifact_versions where id = pg_temp.id('v1')),
  'validated, not yet committed');
select pg_temp.check((select count(*) = 1 from public.approvals where task_id = pg_temp.task('arch') and status = 'pending'), 'approval requested');
select pg_temp.check((select locked_by_execution_id is null from public.artifacts where id = pg_temp.id('art')), 'lock released on success');
select pg_temp.check((select (public.claim_next_task('w2', pg_temp.id('run1'))).id is null), 'pwr waits for arch approval');
-- Fenced: the finished execution cannot complete again.
select pg_temp.expect_error($$select public.complete_execution(pg_temp.id('e2'), 'w2', '[]')$$, '%no longer held%');

select pg_temp.act_as('00000000-0000-0000-0000-00000000000c');
select pg_temp.expect_error($$select public.decide_task(pg_temp.task('arch'), true)$$, '%not permitted%');
select pg_temp.expect_error($$update public.tasks set status = 'complete' where id = pg_temp.task('arch')$$, '%set by the worker%');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000d');
select pg_temp.expect_error($$select public.decide_task(pg_temp.task('arch'), false)$$, '%say what needs to change%');
select public.decide_task(pg_temp.task('arch'), true, 'Approved');
select pg_temp.check((select status = 'committed' from public.artifact_versions where id = pg_temp.id('v1')), 'committed on approval');
select pg_temp.check((select count(*) = 1 from public.task_artifacts where task_id = pg_temp.task('arch') and role = 'output'), 'output linked');
select pg_temp.act_as(null);
select pg_temp.expect_error($$insert into public.artifact_versions (artifact_id, project_id, version, status, storage_path, sha256, produced_by_task_id)
  values (pg_temp.id('art'), 'bbbbbbbb-0000-0000-0000-000000000001', 99, 'committed', 'x', repeat('c', 64), pg_temp.task('arch'))$$,
  '%artifact_versions_one_commit_per_task%');

-- 6. Lock contention: a live holder blocks other executions.
select pg_temp.as_worker();
insert into ids select 'e3', (public.claim_next_task('w1', pg_temp.id('run1'))).id;
select pg_temp.check((select task_id = pg_temp.task('pwr') from public.executions where id = pg_temp.id('e3')), 'pwr claimed');
select pg_temp.check(public.acquire_artifact_lock(pg_temp.id('e3'), 'w1', 'shared/bom', 'bom') is not null, 'pwr locks bom');

-- 7. Retries: max_retries_per_task = 1 allows two attempts in this run.
select pg_temp.check(public.fail_execution(pg_temp.id('e3'), 'w1', 'tool crashed', 'retry') = 'ready', 'first failure retries');
select pg_temp.check((select locked_by_execution_id is null from public.artifacts where name = 'shared/bom'), 'lock released on failure');
insert into ids select 'e4', (public.claim_next_task('w1', pg_temp.id('run1'))).id;
select pg_temp.check((select attempt = 2 and resumed_from_id is null from public.executions where id = pg_temp.id('e4')), 'fresh second attempt');
select pg_temp.check(public.fail_execution(pg_temp.id('e4'), 'w1', 'tool crashed again', 'retry') = 'failed', 'retries exhausted');
select pg_temp.check((select blocker_reason = 'tool crashed again' from public.tasks where id = pg_temp.task('pwr')), 'reason kept');
select pg_temp.check((select (public.claim_next_task('w1', pg_temp.id('run1'))).id is null), 'failed task not claimable');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000c');
update public.tasks set status = 'ready' where id = pg_temp.task('pwr');   -- manual retry
select pg_temp.check((select retry_base = 2 and blocker_reason is null from public.tasks where id = pg_temp.task('pwr')), 'manual retry resets allowance');

-- 8. Budgets: spend past the AI budget stops the run; in-flight work yields at its next heartbeat.
select pg_temp.as_worker();
insert into ids select 'e5', (public.claim_next_task('w1', pg_temp.id('run1'))).id;
select pg_temp.check((select attempt = 3 from public.executions where id = pg_temp.id('e5')), 'third attempt after manual retry');
select pg_temp.check(public.record_cost(pg_temp.id('e5'), 'ai_tokens', 'anthropic', 'claude-opus-5-5', 1000, 'output_tokens', 0.30) = 'ok', 'under budget');
select pg_temp.check(public.record_cost(pg_temp.id('e5'), 'ai_tokens', 'anthropic', 'claude-opus-5-5', 1000, 'output_tokens', 0.30) = 'over_budget', 'over budget');
select pg_temp.check((select status = 'stopped' and stop_reason like 'AI budget reached%' from public.runs where id = pg_temp.id('run1')), 'run stopped');
select pg_temp.check(public.heartbeat_execution(pg_temp.id('e5'), 'w1', '{"step": "half"}') = 'yield', 'worker told to yield');
select public.yield_execution(pg_temp.id('e5'), 'w1', 'run stopped: budget');
select pg_temp.check((select status = 'interrupted' from public.executions where id = pg_temp.id('e5')), 'execution interrupted');
select pg_temp.check((select status = 'ready' from public.tasks where id = pg_temp.task('pwr')), 'task ready for a later run');

-- 9. Completion report; finishing twice is a no-op.
select public.finish_run(pg_temp.id('run1'), 'completed', '{"summary": "stopped on budget"}', 'budget');
select public.finish_run(pg_temp.id('run1'), 'completed', '{"summary": "second writer"}');
select pg_temp.check((select status = 'stopped' and report ->> 'summary' = 'stopped on budget' and finished_at is not null
                      from public.runs where id = pg_temp.id('run1')), 'report stored once, stopped status kept');

-- 10. A new run resumes the interrupted attempt; Guided mode gates design disciplines.
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
select pg_temp.expect_error($$select public.control_run(pg_temp.id('run1'), 'resume')$$, '%cannot resume a run that is stopped%');
insert into ids select 'run2', public.authorize_run(pg_temp.id('plan'), 'guided', 5, 5, '{low,medium,high}', 2);
select pg_temp.as_worker();
insert into ids select 'e6', (public.claim_next_task('w3', pg_temp.id('run2'))).id;
select pg_temp.check((select task_id = pg_temp.task('pwr') and attempt = 3 and resumed_from_id = pg_temp.id('e5')
                         and checkpoint ->> 'step' = 'half' from public.executions where id = pg_temp.id('e6')),
  'next run resumes the budget-interrupted attempt');
select public.begin_validation(pg_temp.id('e6'), 'w3');
select pg_temp.check(public.complete_execution(pg_temp.id('e6'), 'w3', '[]') = 'complete', 'documentation task completes without sign-off');
insert into ids select 'e7', (public.claim_next_task('w3', pg_temp.id('run2'))).id;
select pg_temp.check((select task_id = pg_temp.task('layout') from public.executions where id = pg_temp.id('e7')), 'layout next in plan order');
insert into ids select 'e8', (public.claim_next_task('w4', pg_temp.id('run2'))).id;
select pg_temp.check((select task_id = pg_temp.task('mech') from public.executions where id = pg_temp.id('e8')), 'high-risk task allowed in run 2');

-- 11. A task that keeps killing its worker is blocked after three interruptions.
update public.executions set heartbeat_at = now() - interval '1 hour' where id = pg_temp.id('e8');
select public.reap_stale_executions();
insert into ids select 'e9', (public.claim_next_task('w4', pg_temp.id('run2'))).id;
select pg_temp.check((select task_id = pg_temp.task('mech') from public.executions where id = pg_temp.id('e9')), 'mech resumed after crash 1');
update public.executions set heartbeat_at = now() - interval '1 hour' where id = pg_temp.id('e9');
select public.reap_stale_executions();
insert into ids select 'e10', (public.claim_next_task('w4', pg_temp.id('run2'))).id;
update public.executions set heartbeat_at = now() - interval '1 hour' where id = pg_temp.id('e10');
select public.reap_stale_executions();
select pg_temp.check((select status = 'blocked' and blocker_reason like 'interrupted 3 times%' from public.tasks where id = pg_temp.task('mech')),
  'blocked after repeated crashes');

-- 12. Cancel: the run ends; the in-flight execution yields at its next heartbeat.
select pg_temp.act_as('00000000-0000-0000-0000-00000000000c');
select public.control_run(pg_temp.id('run2'), 'cancel');
select pg_temp.as_worker();
select pg_temp.check(public.heartbeat_execution(pg_temp.id('e7'), 'w3') = 'yield', 'cancel tells worker to yield');
select public.yield_execution(pg_temp.id('e7'), 'w3', 'run canceled');
select pg_temp.check((select (public.run_progress(pg_temp.id('run2')) ->> 'live_executions')::int = 0), 'nothing live after cancel');
select pg_temp.check((select (public.run_progress(pg_temp.id('run2')) -> 'by_status' ->> 'complete')::int = 2), 'progress by status');

-- 13. Users only see runs and logs of their projects; workers' functions are not callable by users.
select pg_temp.act_as('00000000-0000-0000-0000-00000000000b');
select pg_temp.check((select count(*) = 0 from public.runs where project_id = 'bbbbbbbb-0000-0000-0000-000000000001'), 'outsider sees no runs');
select pg_temp.expect_error($$select public.claim_next_task('evil', pg_temp.id('run2'))$$, '%permission denied%');
select pg_temp.expect_error($$select public.reap_stale_executions()$$, '%permission denied%');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000e');
select pg_temp.check((select count(*) = 2 from public.runs where project_id = 'bbbbbbbb-0000-0000-0000-000000000001'), 'viewer sees runs');
select pg_temp.act_as(null);
select pg_temp.check((select count(*) >= 10 from public.audit_events where project_id = 'bbbbbbbb-0000-0000-0000-000000000001'
                      and event_type like 'execution.%'), 'executions audited');

-- 14. G3: workers claim only disciplines they advertise; the registry is readable, not writable.
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
insert into ids select 'run3', public.authorize_run(pg_temp.id('plan'), 'autonomous', 5, 5, '{low,medium,high}', 2);
update public.tasks set status = 'ready' where id = pg_temp.task('mech');            -- manual retry of the blocked task
select pg_temp.as_worker();
select pg_temp.check((select (public.claim_next_task('kicad-less', pg_temp.id('run3'), 30, '{schematic}')).id is null),
  'a worker without the discipline claims nothing');
insert into ids select 'e11', (public.claim_next_task('doc-worker', pg_temp.id('run3'), 30, '{documentation}')).id;
select pg_temp.check((select t.discipline = 'documentation' from public.executions e join public.tasks t on t.id = e.task_id
                      where e.id = pg_temp.id('e11')), 'claims a task of its discipline');
select public.worker_checkin('doc-worker', '{documentation}', '{"node": "22"}');
select public.worker_checkin('doc-worker', '{documentation,schematic}', '{"kicad": "10.0.8"}');
select pg_temp.check((select disciplines = '{documentation,schematic}' and tools ->> 'kicad' = '10.0.8' from public.workers
                      where id = 'doc-worker'), 'check-in upserts');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000e');
select pg_temp.check((select count(*) = 1 from public.workers), 'signed-in users see workers');
select pg_temp.expect_error($$select public.worker_checkin('fake', '{schematic}', '{}')$$, '%permission denied%');

-- 15. M-SRC: the parts catalog is readable by signed-in users and written only by workers.
select pg_temp.as_worker();
select public.record_part('{"mpn":"AP2112K-3.3TRG1","normalized_mpn":"AP2112K-3.3TRG1","manufacturer":"Diodes Incorporated",
  "normalized_mfr":"DIODES","lifecycle":"active","provider":"nexar"}'::jsonb,
  '[{"provider":"nexar","seller":"DigiKey","sku":"AP2112K-3.3TRG1DICT-ND","stock":100,"currency":"USD",
     "prices":[{"quantity":1,"unit_price":0.5}],"data_status":"live"}]'::jsonb);
select public.record_part('{"mpn":"ap2112k-3.3trg1","normalized_mpn":"AP2112K-3.3TRG1","manufacturer":"Diodes Inc.",
  "normalized_mfr":"DIODES","lifecycle":"unknown","provider":"mouser"}'::jsonb,
  '[{"provider":"mouser","seller":"Mouser","sku":"621-AP2112K-3.3TRG1","stock":50,"currency":"USD","prices":[],"data_status":"live"}]'::jsonb);
select pg_temp.check((select count(*) = 1 and bool_and(lifecycle = 'active') and bool_and(sources @> '{nexar,mouser}')
                      from public.parts where normalized_mpn = 'AP2112K-3.3TRG1'),
  'one part per normalized MPN + manufacturer; an unknown lifecycle does not overwrite a known one; sources merge');
select pg_temp.check((select count(*) = 2 from public.offers o join public.parts p on p.id = o.part_id
                      where p.normalized_mpn = 'AP2112K-3.3TRG1'), 'offers accumulate as observations');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000b');
select pg_temp.check((select count(*) = 1 from public.parts where normalized_mpn = 'AP2112K-3.3TRG1'), 'any signed-in user reads the catalog');
select pg_temp.expect_error($$select public.record_part('{}'::jsonb, '[]'::jsonb)$$, '%permission denied%');
select pg_temp.expect_error($$insert into public.parts (mpn, normalized_mpn, manufacturer, normalized_mfr) values ('x','X','y','Y')$$, '%row-level security%');
select pg_temp.act_as(null);

\echo 'All worker tests passed.'
