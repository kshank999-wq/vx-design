-- S6 evidence: units, procedure versions, DB-computed verdicts, immutable runs, faults, verification matrix.
-- Runs after optimization_test.sql (users: a owner, c engineer, d reviewer, e viewer, f client of project bbbb...1).
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
insert into public.requirements (project_id, ref_code, kind, text, status) values
  ('bbbbbbbb-0000-0000-0000-000000000001', 'REQ-VAL-001', 'power', 'The 3.3 V rail shall stay between 3.2 V and 3.4 V.', 'confirmed'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'REQ-VAL-002', 'interface', 'The board shall decode LTC at 30 fps.', 'confirmed'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'REQ-VAL-003', 'mechanical', 'The board shall fit the enclosure.', 'confirmed');

-- 1. Units.
select pg_temp.act_as('00000000-0000-0000-0000-00000000000f');   -- client
select pg_temp.expect_error($$select public.create_unit('bbbbbbbb-0000-0000-0000-000000000001', 'SN-001', 'A')$$, '%only owner, engineer%');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000c');   -- engineer
insert into ids select 'u1', public.create_unit('bbbbbbbb-0000-0000-0000-000000000001', 'SN-001', 'A', null, 'LOT-1', 'Fab Example');
insert into ids select 'u2', public.create_unit('bbbbbbbb-0000-0000-0000-000000000001', 'SN-002', 'A');
select pg_temp.expect_error($$select public.create_unit('bbbbbbbb-0000-0000-0000-000000000001', 'SN-001', 'A')$$, '%duplicate key%');
select pg_temp.expect_error($$select public.create_unit('bbbbbbbb-0000-0000-0000-000000000001', 'bad serial!', 'A')$$, '%units_serial_check%');

-- 2. Procedures: drafts, validation, approval by owner/reviewer, frozen once approved, new versions.
insert into ids select 'tp1', public.save_procedure('bbbbbbbb-0000-0000-0000-000000000001', null, '3.3 V rail', 'bring_up', '{REQ-VAL-001}', 'Bench supply 5 V', 'Measure +3V3 at TP1',
  '[{"key": "v3v3", "label": "+3V3", "kind": "numeric", "unit": "V", "min": 3.2, "max": 3.4, "requirement_ref": "REQ-VAL-001"},
    {"key": "ltc_ok", "label": "LTC decodes", "kind": "boolean", "expected": "yes", "requirement_ref": "REQ-VAL-002"},
    {"key": "current_ma", "label": "Input current", "kind": "numeric", "unit": "mA"}]');
select pg_temp.check((select code = 'TP-001' and version = 1 and status = 'draft' from public.test_procedures where id = pg_temp.id('tp1')), 'TP-001 v1 draft');
select pg_temp.expect_error($$select public.save_procedure('bbbbbbbb-0000-0000-0000-000000000001', null, 'x', 'other', '{REQ-NOPE}', null, null, '[]')$$, '%unknown requirement%');
select pg_temp.expect_error($$select public.save_procedure('bbbbbbbb-0000-0000-0000-000000000001', null, 'x', 'other', '{}', null, null,
  '[{"key": "a", "kind": "numeric", "min": 5, "max": 1}]')$$, '%min is above max%');
select pg_temp.expect_error($$select public.save_procedure('bbbbbbbb-0000-0000-0000-000000000001', null, 'x', 'other', '{}', null, null,
  '[{"key": "a", "kind": "numeric"}, {"key": "a", "kind": "text"}]')$$, '%used twice%');
select pg_temp.expect_error($$select public.record_test_run(pg_temp.id('u1'), pg_temp.id('tp1'), now(), '{}', '{"v3v3": 3.3}')$$, '%approved version%');
select pg_temp.expect_error($$select public.approve_procedure(pg_temp.id('tp1'))$$, '%only owner, reviewer%');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000d');   -- reviewer
select public.approve_procedure(pg_temp.id('tp1'));
select pg_temp.act_as(null);
select pg_temp.expect_error($$update public.test_procedures set measurements = '[]' where id = pg_temp.id('tp1')$$, '%cannot be changed%');

-- 3. Runs: verdicts computed from the approved limits; immutable.
select pg_temp.act_as('00000000-0000-0000-0000-00000000000c');
select pg_temp.expect_error($$select public.record_test_run(pg_temp.id('u1'), pg_temp.id('tp1'), now(), '{}', '{"vbat": 1}')$$, '%unknown measurements: vbat%');
select pg_temp.expect_error($$select public.record_test_run(pg_temp.id('u1'), pg_temp.id('tp1'), now() + interval '1 day', '{}', '{}')$$, '%not in the future%');
insert into ids select 'run_pass', public.record_test_run(pg_temp.id('u1'), pg_temp.id('tp1'), now() - interval '2 hours',
  '{"temperature_c": 23, "supply_v": 5.0, "firmware": "0.3.1", "equipment": [{"name": "DMM", "id": "DMM-7", "calibrated_until": "2027-03-01"}]}',
  '{"v3v3": 3.31, "ltc_ok": "yes", "current_ma": 82}');
select pg_temp.check((select verdict = 'pass' from public.test_runs where id = pg_temp.id('run_pass')), 'pass');
select pg_temp.check((select array_agg(key || ':' || verdict order by key) = '{current_ma:info,ltc_ok:pass,v3v3:pass}'
                      from public.test_measurements where run_id = pg_temp.id('run_pass')), 'measurement verdicts');
insert into ids select 'run_fail', public.record_test_run(pg_temp.id('u2'), pg_temp.id('tp1'), now() - interval '90 minutes', '{}', '{"v3v3": 3.05, "ltc_ok": "no"}');
select pg_temp.check((select verdict = 'fail' from public.test_runs where id = pg_temp.id('run_fail')), 'fail');
select pg_temp.check((select status = 'failed' from public.units where id = pg_temp.id('u2')), 'unit marked failed');
insert into ids select 'f1', id from public.faults where run_id = pg_temp.id('run_fail');
select pg_temp.check((select title = 'TP-001 failed on SN-002: +3V3, LTC decodes' and status = 'open' from public.faults where id = pg_temp.id('f1')), 'fault opened');
insert into ids select 'run_inc', public.record_test_run(pg_temp.id('u1'), pg_temp.id('tp1'), now() - interval '1 hour', '{}', '{"v3v3": 3.3}');
select pg_temp.check((select verdict = 'incomplete' from public.test_runs where id = pg_temp.id('run_inc')), 'missing → incomplete');
select pg_temp.act_as(null);
select pg_temp.expect_error($$update public.test_runs set verdict = 'pass' where id = pg_temp.id('run_fail')$$, '%immutable%');
select pg_temp.expect_error($$update public.test_measurements set verdict = 'pass' where run_id = pg_temp.id('run_fail')$$, '%immutable%');

-- 4. Matrix: REQ-VAL-001 has a failing unit; REQ-VAL-003 has no procedure.
select pg_temp.act_as('00000000-0000-0000-0000-00000000000f');   -- clients read the evidence
select pg_temp.check((select array_agg(ref_code || ':' || status order by ref_code) = '{REQ-VAL-001:failing,REQ-VAL-002:failing,REQ-VAL-003:no_procedure}'
                      from public.requirement_verification('bbbbbbbb-0000-0000-0000-000000000001') where ref_code like 'REQ-VAL-%'), 'matrix while failing');

-- 5. Fault: corrected, then verified only by a later passing run of the same procedure on the same unit.
select pg_temp.act_as('00000000-0000-0000-0000-00000000000c');
select pg_temp.expect_error($$select public.update_fault(pg_temp.id('f1'), 'corrected')$$, '%faults_check1%');
select public.update_fault(pg_temp.id('f1'), 'corrected', 'R5 wrong value fitted (10k instead of 1k)', 'rework', 'Replaced R5 with 1k');
select pg_temp.expect_error($$select public.update_fault(pg_temp.id('f1'), 'verified', null, null, null, pg_temp.id('run_pass'))$$, '%later passing run of the same procedure on the same unit%');
insert into ids select 'run_fix', public.record_test_run(pg_temp.id('u2'), pg_temp.id('tp1'), now(), '{"note": "after rework"}',
  '{"v3v3": 3.29, "ltc_ok": "yes", "current_ma": 80}', 'Retest after replacing R5', pg_temp.id('run_fail'));
select public.update_fault(pg_temp.id('f1'), 'verified', null, null, null, pg_temp.id('run_fix'));
select pg_temp.check((select status = 'verified' from public.faults where id = pg_temp.id('f1')), 'fault verified');
select pg_temp.check((select status = 'reworked' from public.units where id = pg_temp.id('u2')), 'unit reworked');
select pg_temp.expect_error($$select public.update_fault(pg_temp.id('f1'), 'wont_fix', null, null, null, null, 'n/a')$$, '%only owner of the project%');
select pg_temp.check((select array_agg(ref_code || ':' || status || ':' || units_passed order by ref_code) = '{REQ-VAL-001:verified:1,REQ-VAL-002:verified:1,REQ-VAL-003:no_procedure:0}'
                      from public.requirement_verification('bbbbbbbb-0000-0000-0000-000000000001') where ref_code like 'REQ-VAL-%'), 'matrix verified: SN-002 passes; SN-001 latest run is incomplete, so it does not count');

-- 6. Versions: revising makes v2; approving it supersedes v1; v1 can no longer be used.
insert into ids select 'tp1v2', public.revise_procedure(pg_temp.id('tp1'));
select pg_temp.check((select version = 2 and status = 'draft' and code = 'TP-001' from public.test_procedures where id = pg_temp.id('tp1v2')), 'v2 draft');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
select public.approve_procedure(pg_temp.id('tp1v2'));
select pg_temp.check((select status = 'superseded' from public.test_procedures where id = pg_temp.id('tp1')), 'v1 superseded');
select pg_temp.expect_error($$select public.record_test_run(pg_temp.id('u1'), pg_temp.id('tp1'), now(), '{}', '{"v3v3": 3.3}')$$, '%superseded%');

-- 7. Evidence lives in the run's folder; members cannot write tables directly.
select pg_temp.expect_error($$select public.add_test_evidence(pg_temp.id('run_pass'), 'scope.png', 'scope', 'bbbbbbbb-0000-0000-0000-000000000001/documents/x.png', repeat('a', 64), 10)$$, '%run''s folder%');
select public.add_test_evidence(pg_temp.id('run_pass'), 'scope.png', 'scope', 'bbbbbbbb-0000-0000-0000-000000000001/evidence/' || pg_temp.id('run_pass') || '/scope.png', repeat('a', 64), 10);
select pg_temp.act_as('00000000-0000-0000-0000-00000000000f');
select pg_temp.expect_error($$insert into public.units (project_id, serial, revision) values ('bbbbbbbb-0000-0000-0000-000000000001', 'SN-X', 'A')$$, '%row-level security%');
select pg_temp.check((select public.is_upload_path('project-files', 'bbbbbbbb-0000-0000-0000-000000000001/evidence/x/y.png')), 'evidence is virus-scanned');
select pg_temp.act_as(null);
select pg_temp.check((select array_agg(distinct event_type) @> array['unit.registered', 'procedure.approved', 'test.recorded', 'fault.corrected', 'fault.verified', 'test.evidence_added']
                      from public.audit_events where project_id = 'bbbbbbbb-0000-0000-0000-000000000001'), 'audited');

\echo 'All validation tests passed.'
