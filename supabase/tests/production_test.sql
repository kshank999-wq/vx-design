-- S7 compliance and production tracking. Alice owns, Carol engineers, Dave reviews, Cleo is a client; Zoe is an outsider.
\set ON_ERROR_STOP on
\o /dev/null

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000d2', 'zoe@prod.test'),
  ('00000000-0000-0000-0000-0000000000d3', 'cleo@prod.test');

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

select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
insert into public.projects (id, name) values ('eeeeeeee-0000-0000-0000-000000000001', 'Production test');
insert into public.project_members (project_id, user_id, role) values
  ('eeeeeeee-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000c', 'engineer'),
  ('eeeeeeee-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000d', 'reviewer'),
  ('eeeeeeee-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000d3', 'client');

-- Committed files: a fab package (v1 and v2) and a BOM; one scratch file.
select pg_temp.act_as(null);
insert into public.artifacts (id, project_id, kind, name) values
  ('eeeeeeee-0000-0000-0000-0000000000a1', 'eeeeeeee-0000-0000-0000-000000000001', 'fab_package', 'board/fab'),
  ('eeeeeeee-0000-0000-0000-0000000000a2', 'eeeeeeee-0000-0000-0000-000000000001', 'bom', 'board/bom');
insert into public.artifact_versions (id, artifact_id, project_id, version, status, storage_path, sha256, size_bytes, committed_at) values
  ('eeeeeeee-0000-0000-0000-0000000000b1', 'eeeeeeee-0000-0000-0000-0000000000a1', 'eeeeeeee-0000-0000-0000-000000000001', 1, 'committed', 'x/fab1.zip', repeat('a', 64), 100, now()),
  ('eeeeeeee-0000-0000-0000-0000000000b2', 'eeeeeeee-0000-0000-0000-0000000000a2', 'eeeeeeee-0000-0000-0000-000000000001', 1, 'committed', 'x/bom1.csv', repeat('b', 64), 50, now()),
  ('eeeeeeee-0000-0000-0000-0000000000b3', 'eeeeeeee-0000-0000-0000-0000000000a1', 'eeeeeeee-0000-0000-0000-000000000001', 2, 'scratch', 'x/fab2.zip', repeat('c', 64), 100, null);

-- 1. Releases: drafts hold committed files only; readiness; owner issues; frozen afterwards.
select pg_temp.act_as('00000000-0000-0000-0000-00000000000c');
select pg_temp.expect_error($$select public.save_release('eeeeeeee-0000-0000-0000-000000000001', null, 'A', null, '{eeeeeeee-0000-0000-0000-0000000000b3}')$$,
  'a release can only hold committed%');
select pg_temp.expect_error($$select public.save_release('eeeeeeee-0000-0000-0000-000000000001', null, 'bad rev!', null, '{}')$$, '%releases_revision_check%');
insert into ids select 'relA', public.save_release('eeeeeeee-0000-0000-0000-000000000001', null, 'A', 'First pilot', '{eeeeeeee-0000-0000-0000-0000000000b2}');
select pg_temp.check((select jsonb_path_exists(public.check_release_readiness(pg_temp.id('relA')), '$[*] ? (@.text == "no fab package in the release")')), 'warns without a fab package');
select public.save_release('eeeeeeee-0000-0000-0000-000000000001', pg_temp.id('relA'), 'A', 'First pilot',
                           '{eeeeeeee-0000-0000-0000-0000000000b1,eeeeeeee-0000-0000-0000-0000000000b2}');
select pg_temp.expect_error(format($$select public.issue_release(%L)$$, pg_temp.id('relA')), 'only owner of the project can issue a release');

-- A failing compliance result blocks; an open major fault blocks.
select pg_temp.act_as(null);
insert into public.faults (project_id, fault_no, title, severity) values ('eeeeeeee-0000-0000-0000-000000000001', 1, 'Reset line floats', 'major');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
select pg_temp.check((select count(*) = 1 from jsonb_array_elements(public.check_release_readiness(pg_temp.id('relA'))) e where e ->> 'severity' = 'block'), 'one blocker');
select pg_temp.expect_error(format($$select public.issue_release(%L)$$, pg_temp.id('relA')), '1 blocker(s) stand in the way%');
insert into ids select 'decA', public.issue_release(pg_temp.id('relA'), 'Pilot boards only; F-001 is fixed by a pull-up on the rework list.');
select pg_temp.check((select status = 'released' and jsonb_array_length(manifest) = 2 and manifest_sha256 ~ '^[0-9a-f]{64}$' and waiver is not null
                        and manifest -> 0 ->> 'artifact' = 'board/bom' from public.releases where id = pg_temp.id('relA')), 'released with a frozen manifest');
select pg_temp.check((select title = 'Release A' and evidence_category = 'unverified_assumption' from public.decisions where id = pg_temp.id('decA')),
  'the release is a decision; waived blockers make it an assumption');
select pg_temp.expect_error(format($$select public.save_release('eeeeeeee-0000-0000-0000-000000000001', %L, 'A', 'x', '{}')$$, pg_temp.id('relA')), '%released and cannot be changed%');
select pg_temp.act_as(null);
select pg_temp.expect_error(format($$update public.releases set notes = 'x' where id = %L$$, pg_temp.id('relA')), '%cannot be changed%');
select pg_temp.expect_error(format($$delete from public.releases where id = %L$$, pg_temp.id('relA')), '%cannot be deleted%');

-- 2. Compliance: items, progress, results with a report and the tested release, not-applicable by owner/reviewer.
select pg_temp.act_as('00000000-0000-0000-0000-00000000000c');
insert into ids select 'c1', public.add_compliance_item('eeeeeeee-0000-0000-0000-000000000001', 'FCC Part 15 Subpart B', 'US', '{FCC 47 CFR 15.109}', 'digital device sold in the US', 'us_fcc_15b');
insert into ids select 'c2', public.add_compliance_item('eeeeeeee-0000-0000-0000-000000000001', 'UN 38.3 battery transport', 'global', '{UN 38.3}', 'Li-ion pack', 'un38_3');
select pg_temp.expect_error($$select public.add_compliance_item('eeeeeeee-0000-0000-0000-000000000001', 'again', 'US', '{}', null, 'us_fcc_15b')$$, 'this item is already on the list');
select public.set_compliance_status(pg_temp.id('c1'), 'at_lab', 'Example EMC Lab', 'booked for the 3 m chamber');
select pg_temp.expect_error(format($$select public.set_compliance_status(%L, 'passed')$$, pg_temp.id('c1')), 'record a lab result%');
select pg_temp.expect_error(format($$select public.record_compliance_result(%L, 'pass', 'Example EMC Lab', 'R-1', null, current_date, null, %L, 'r.pdf', 'elsewhere/r.pdf', %L, 10)$$,
  pg_temp.id('c1'), pg_temp.id('relA'), repeat('d', 64)), 'the lab report must be stored%');
select pg_temp.expect_error(format($$select public.record_compliance_result(%L, 'pass', 'Lab', 'R-1', null, current_date + 3, null, %L, 'r.pdf', %L, %L, 10)$$,
  pg_temp.id('c1'), pg_temp.id('relA'), 'eeeeeeee-0000-0000-0000-000000000001/compliance/' || pg_temp.id('c1') || '/r.pdf', repeat('d', 64)), '%in the future');
select public.record_compliance_result(pg_temp.id('c1'), 'fail', 'Example EMC Lab', 'R-1', null, current_date, null, pg_temp.id('relA'), 'r1.pdf',
  'eeeeeeee-0000-0000-0000-000000000001/compliance/' || pg_temp.id('c1') || '/r1.pdf', repeat('d', 64), 1000, 'radiated emissions 4 dB over at 120 MHz');
select pg_temp.check((select status = 'failed' from public.compliance_items where id = pg_temp.id('c1')), 'failed');
insert into ids select 'r2', public.record_compliance_result(pg_temp.id('c1'), 'pass', 'Example EMC Lab', 'R-2', 'SDoC-2026-01', current_date, null, pg_temp.id('relA'), 'r2.pdf',
  'eeeeeeee-0000-0000-0000-000000000001/compliance/' || pg_temp.id('c1') || '/r2.pdf', repeat('e', 64), 1200);
select pg_temp.check((select status = 'passed' and latest_result_id = pg_temp.id('r2') from public.compliance_items where id = pg_temp.id('c1')), 'passed on retest');
select pg_temp.check((select count(*) = 2 from public.compliance_results where item_id = pg_temp.id('c1')), 'history kept');
select pg_temp.expect_error(format($$select public.mark_compliance_not_applicable(%L, 'no cells shipped')$$, pg_temp.id('c2')), 'only owner, reviewer%');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000d');
select pg_temp.expect_error(format($$select public.mark_compliance_not_applicable(%L, ' ')$$, pg_temp.id('c2')), 'give the reason%');
select public.mark_compliance_not_applicable(pg_temp.id('c2'), 'The product ships without cells; the user fits AA batteries.');
select pg_temp.act_as(null);
select pg_temp.expect_error(format($$update public.compliance_results set outcome = 'pass' where id = %L$$, pg_temp.id('r2')), '%');

-- 3. Production lots: from the released revision only; units carry the revision; inspections; acceptance rules.
select pg_temp.act_as('00000000-0000-0000-0000-00000000000c');
insert into ids select 'relB', public.save_release('eeeeeeee-0000-0000-0000-000000000001', null, 'B', null, '{eeeeeeee-0000-0000-0000-0000000000b1}');
select pg_temp.expect_error(format($$select public.create_lot('eeeeeeee-0000-0000-0000-000000000001', 'pilot', %L, 10, 3, 0)$$, pg_temp.id('relB')), 'lots are built from the current released revision%');
select pg_temp.expect_error(format($$select public.create_lot('eeeeeeee-0000-0000-0000-000000000001', 'pilot', %L, 10, 12, 0)$$, pg_temp.id('relA')), '%production_lots_check%');
insert into ids select 'tp', public.save_procedure('eeeeeeee-0000-0000-0000-000000000001', null, 'Production jig test', 'functional', '{}', 'Jig rev 1', 'Clamp, power, run script',
  '[{"key": "v3v3", "label": "+3V3", "kind": "numeric", "unit": "V", "min": 3.2, "max": 3.4}]');
select pg_temp.expect_error(format($$select public.create_lot('eeeeeeee-0000-0000-0000-000000000001', 'pilot', %L, 10, 3, 0, %L)$$, pg_temp.id('relA'), pg_temp.id('tp')),
  'the production test must be an approved procedure%');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000d');
select public.approve_procedure(pg_temp.id('tp'));
select pg_temp.act_as('00000000-0000-0000-0000-00000000000c');
insert into ids select 'lot', public.create_lot('eeeeeeee-0000-0000-0000-000000000001', 'pilot', pg_temp.id('relA'), 4, 3, 0, pg_temp.id('tp'), null, 'Example Assembly Co');
select public.add_lot_units(pg_temp.id('lot'), 'VX-A-', 1, 3, 4);
select pg_temp.check((select count(*) = 3 and bool_and(revision = 'A' and lot = 'LOT-001' and built_from_version_id = 'eeeeeeee-0000-0000-0000-0000000000b1'
                                                       and assembled_by = 'Example Assembly Co')
                        from public.units where lot_id = pg_temp.id('lot')), 'units carry the revision, lot and fab package');
select pg_temp.check((select serial from public.units where lot_id = pg_temp.id('lot') order by serial limit 1) = 'VX-A-0001', 'serials padded');
select pg_temp.expect_error(format($$select public.add_lot_units(%L, 'VX-A-', 3, 1)$$, pg_temp.id('lot')), 'serial VX-A-0003 is already registered');
select pg_temp.expect_error(format($$select public.add_lot_units(%L, 'VX-A-', 10, 2)$$, pg_temp.id('lot')), 'the lot is for 4 unit(s) and 3 are registered');
select pg_temp.check((select status = 'in_build' from public.production_lots where id = pg_temp.id('lot')), 'in build once units exist');

-- Production tests: two pass first time, one fails then passes.
select public.record_test_run((select id from public.units where serial = 'VX-A-0001' and project_id = 'eeeeeeee-0000-0000-0000-000000000001'), pg_temp.id('tp'), now() - interval '3 hours', '{}', '{"v3v3": 3.3}');
select public.record_test_run((select id from public.units where serial = 'VX-A-0002' and project_id = 'eeeeeeee-0000-0000-0000-000000000001'), pg_temp.id('tp'), now() - interval '3 hours', '{}', '{"v3v3": 3.31}');
select public.record_test_run((select id from public.units where serial = 'VX-A-0003' and project_id = 'eeeeeeee-0000-0000-0000-000000000001'), pg_temp.id('tp'), now() - interval '3 hours', '{}', '{"v3v3": 3.6}');
select pg_temp.check((select public.lot_summary(pg_temp.id('lot')) = '{"units": 3, "scrapped": 0, "tested": 3, "first_pass": 2, "passing": 2, "failing": 1}'::jsonb), 'summary before retest');

-- Inspections: incomplete, reject, accept; acceptance needs a passing final inspection and every unit passing.
select pg_temp.expect_error(format($$select public.record_lot_inspection(%L, 'final', 3, 4)$$, pg_temp.id('lot')), 'the defect count must be%');
insert into ids select 'i1', public.record_lot_inspection(pg_temp.id('lot'), 'incoming', 2, 0);
select pg_temp.check((select verdict = 'incomplete' from public.lot_inspections where id = pg_temp.id('i1')), 'incomplete sample');
insert into ids select 'i2', public.record_lot_inspection(pg_temp.id('lot'), 'final', 3, 1, '[{"defect": "solder bridge U3", "count": 1}]');
select pg_temp.check((select verdict = 'reject' from public.lot_inspections where id = pg_temp.id('i2')), 'reject');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000d');
select pg_temp.expect_error(format($$select public.set_lot_status(%L, 'accepted')$$, pg_temp.id('lot')), 'the latest final inspection must pass%');
insert into ids select 'i3', public.record_lot_inspection(pg_temp.id('lot'), 'final', 3, 0, '[]', 'after rework');
select pg_temp.check((select verdict = 'accept' from public.lot_inspections where id = pg_temp.id('i3')), 'accept');
select pg_temp.expect_error(format($$select public.set_lot_status(%L, 'accepted')$$, pg_temp.id('lot')), '1 unit(s) have not passed the production test%');
select public.record_test_run((select id from public.units where serial = 'VX-A-0003' and project_id = 'eeeeeeee-0000-0000-0000-000000000001'), pg_temp.id('tp'), now() - interval '1 hour', '{}', '{"v3v3": 3.29}');
select pg_temp.check((select (public.lot_summary(pg_temp.id('lot')) ->> 'passing')::int = 3 and (public.lot_summary(pg_temp.id('lot')) ->> 'first_pass')::int = 2), 'retest passes; first-pass yield unchanged');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000c');
select pg_temp.expect_error(format($$select public.set_lot_status(%L, 'accepted')$$, pg_temp.id('lot')), 'only owner, reviewer%');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000d');
select public.set_lot_status(pg_temp.id('lot'), 'accepted');
select pg_temp.check((select bool_and(status = 'passed') from public.units where lot_id = pg_temp.id('lot')), 'accepted lot units are passed');
select pg_temp.expect_error(format($$select public.record_lot_inspection(%L, 'final', 3, 0)$$, pg_temp.id('lot')), 'the lot is accepted and closed');
select pg_temp.act_as(null);
select pg_temp.expect_error(format($$delete from public.lot_inspections where lot_id = %L$$, pg_temp.id('lot')), '%');

-- 4. Traceability: a serial back to lot, release, files and tests. Clients read; outsiders see nothing.
select pg_temp.act_as('00000000-0000-0000-0000-0000000000d3');
select pg_temp.check((select t -> 'release' ->> 'revision' = 'A' and t -> 'lot' ->> 'lot_no' = '1' and jsonb_array_length(t -> 'runs') = 2
                             and jsonb_array_length(t -> 'release' -> 'files') = 2 and t -> 'built_from' ->> 'artifact' = 'board/fab'
                        from public.trace_unit('eeeeeeee-0000-0000-0000-000000000001', 'VX-A-0003') t), 'trace');
select pg_temp.check((select count(*) = 2 from public.compliance_items), 'clients read compliance');
select pg_temp.expect_error($$select public.add_compliance_item('eeeeeeee-0000-0000-0000-000000000001', 'x', 'US')$$, 'only owner, engineer%');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000d2');
select pg_temp.check((select public.trace_unit('eeeeeeee-0000-0000-0000-000000000001', 'VX-A-0003') is null), 'outsiders trace nothing');
select pg_temp.check((select count(*) from public.releases) + (select count(*) from public.production_lots) + (select count(*) from public.compliance_items) = 0, 'outsiders see none');

-- 5. A new release supersedes the old; S7 blockers; withdrawing.
select pg_temp.act_as(null);
update public.faults set status = 'wont_fix' where project_id = 'eeeeeeee-0000-0000-0000-000000000001';
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
select public.issue_release(pg_temp.id('relB'));
select pg_temp.check((select status = 'superseded' from public.releases where id = pg_temp.id('relA')), 'A superseded by B');
select pg_temp.act_as(null);
select pg_temp.check((select not exists (select 1 from jsonb_array_elements(public.stage_blockers('eeeeeeee-0000-0000-0000-000000000001', 'S7')) e
                                         where e ->> 'kind' in ('release', 'compliance', 'lot'))), 'S7 blockers cleared');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
select pg_temp.expect_error(format($$select public.withdraw_release(%L, '')$$, pg_temp.id('relB')), 'say why%');
select public.withdraw_release(pg_temp.id('relB'), 'Wrong BOM revision.');
select pg_temp.act_as(null);
select pg_temp.check((select jsonb_path_exists(public.stage_blockers('eeeeeeee-0000-0000-0000-000000000001', 'S7'), '$[*] ? (@.text == "no released revision")')), 'withdrawn release counts as none');
select pg_temp.act_as(null);
select pg_temp.check((select count(*) from public.audit_events where project_id = 'eeeeeeee-0000-0000-0000-000000000001'
                       and event_type in ('release.issued', 'compliance.result', 'lot.inspected', 'lot.status', 'release.withdrawn')) = 9, 'audited');

\o
select 'All compliance and production tests passed.' as result;
