-- S8 lifecycle. Alice owns, Carol engineers, Dave reviews, Cleo is a client; Zoe is an outsider with no projects.
\set ON_ERROR_STOP on
\o /dev/null

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000e2', 'zoe@life.test'),
  ('00000000-0000-0000-0000-0000000000e3', 'cleo@life.test');

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
insert into public.projects (id, name) values ('ffffffff-0000-0000-0000-000000000001', 'Lifecycle test');
insert into public.project_members (project_id, user_id, role) values
  ('ffffffff-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000c', 'engineer'),
  ('ffffffff-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000d', 'reviewer'),
  ('ffffffff-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000e3', 'client');

select pg_temp.act_as(null);
insert into public.parts (id, mpn, normalized_mpn, manufacturer, normalized_mfr, lifecycle) values
  ('ffffffff-0000-0000-0000-0000000000a1', 'AP2112K-3.3TRG1', 'AP2112K-3.3TRG1', 'Diodes Inc', 'diodes', 'active'),
  ('ffffffff-0000-0000-0000-0000000000a2', 'NE555DR', 'NE555DR', 'Texas Instruments', 'ti', 'active'),
  ('ffffffff-0000-0000-0000-0000000000a3', 'TLV75533PDBVR', 'TLV75533PDBVR', 'Texas Instruments', 'ti', 'active');
insert into public.artifacts (id, project_id, kind, name) values ('ffffffff-0000-0000-0000-0000000000b0', 'ffffffff-0000-0000-0000-000000000001', 'bom', 's/sourced-bom');
insert into public.artifact_versions (id, artifact_id, project_id, version, status, storage_path, sha256, size_bytes, committed_at) values
  ('ffffffff-0000-0000-0000-0000000000b1', 'ffffffff-0000-0000-0000-0000000000b0', 'ffffffff-0000-0000-0000-000000000001', 1, 'committed', 'x/bom.json', repeat('a', 64), 10, now()),
  ('ffffffff-0000-0000-0000-0000000000b2', 'ffffffff-0000-0000-0000-0000000000b0', 'ffffffff-0000-0000-0000-000000000001', 2, 'scratch', 'x/bom2.json', repeat('b', 64), 10, null);

-- 1. Loading the BOM: committed BOMs only; lines matched to catalog parts by normalised keys.
select pg_temp.act_as('00000000-0000-0000-0000-00000000000c');
select pg_temp.expect_error($$select public.load_bom_parts('ffffffff-0000-0000-0000-000000000001', 'ffffffff-0000-0000-0000-0000000000b2', '[]')$$, 'that is not a committed BOM%');
select pg_temp.check(public.load_bom_parts('ffffffff-0000-0000-0000-000000000001', 'ffffffff-0000-0000-0000-0000000000b1',
  '[{"mpn": "AP2112K-3.3TRG1", "manufacturer": "Diodes Inc", "normalized_mpn": "AP2112K-3.3TRG1", "normalized_mfr": "diodes", "refs": ["U1"], "qty_per_board": 1},
    {"mpn": "NE555DR", "manufacturer": "TI", "normalized_mpn": "NE555DR", "normalized_mfr": "ti", "refs": ["U2", "U3"], "qty_per_board": 2},
    {"mpn": "", "refs": ["R9"]},
    {"mpn": "MYSTERY-1", "normalized_mpn": "MYSTERY-1", "refs": ["X1"]}]') = 3, 'three lines with part numbers');
select pg_temp.check((select count(*) filter (where part_id is not null) = 2 and count(*) = 3 from public.project_bom_parts
                       where project_id = 'ffffffff-0000-0000-0000-000000000001'), 'two matched to the catalog');

-- 2. Notices: sourced, immutable; an EOL notice moves the catalog lifecycle and records an automatic notice.
select pg_temp.expect_error($$select public.record_part_notice('ffffffff-0000-0000-0000-0000000000a1', 'eol', 'EOL', null, null, null, null, null, null, null, null)$$,
  'say where the notice comes from%');
select pg_temp.expect_error($$select public.record_part_notice('ffffffff-0000-0000-0000-0000000000a1', 'eol', 'EOL', null, null, null, null, null, null, 'http://x.test', null)$$,
  '%part_notices_source_url_check%');
insert into ids select 'eol', public.record_part_notice('ffffffff-0000-0000-0000-0000000000a1', 'eol', 'AP2112K end of life', 'PCN-2026-117',
  'Wafer fab closure', '2026-10-01', null, current_date + 120, current_date + 200, 'https://example.test/pcn-2026-117.pdf', null);
select pg_temp.check((select lifecycle = 'last_time_buy' from public.parts where id = 'ffffffff-0000-0000-0000-0000000000a1'), 'catalog lifecycle follows the notice');
select pg_temp.check((select count(*) = 1 from public.part_notices where part_id = 'ffffffff-0000-0000-0000-0000000000a1' and automatic and kind = 'lifecycle_change'
                        and details ->> 'to' = 'last_time_buy'), 'automatic lifecycle notice');
select pg_temp.act_as(null);
update public.parts set lifecycle = 'nrnd', lifecycle_raw = 'Not Recommended for New Designs' where id = 'ffffffff-0000-0000-0000-0000000000a2';
select pg_temp.check((select count(*) = 1 from public.part_notices where part_id = 'ffffffff-0000-0000-0000-0000000000a2' and automatic), 'distributor data change noted');
update public.parts set description = 'timer' where id = 'ffffffff-0000-0000-0000-0000000000a2';
select pg_temp.check((select count(*) = 1 from public.part_notices where part_id = 'ffffffff-0000-0000-0000-0000000000a2'), 'other edits are not notices');
select pg_temp.expect_error(format($$delete from public.part_notices where id = %L$$, pg_temp.id('eol')), '%');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000e2');
select pg_temp.expect_error($$select public.record_part_notice('ffffffff-0000-0000-0000-0000000000a2', 'pcn', 'x', null, null, null, null, null, null, 'https://x.test', null)$$,
  'only project owners, engineers and library editors%');
select pg_temp.check((select count(*) >= 3 from public.part_notices), 'anyone signed in reads notices');
select pg_temp.check((select count(*) = 0 from public.project_bom_parts), 'outsiders do not see BOMs');

-- 3. Cases: one open per part; assessed; resolution needs owner/reviewer and becomes a decision.
select pg_temp.act_as('00000000-0000-0000-0000-00000000000c');
insert into ids select 'case', public.open_lifecycle_case('ffffffff-0000-0000-0000-000000000001', 'ffffffff-0000-0000-0000-0000000000a1', 'AP2112K-3.3TRG1',
  'Diodes Inc', '{U1}', 'End of life: last order in 120 days', 'high', pg_temp.id('eol'));
select pg_temp.expect_error($$select public.open_lifecycle_case('ffffffff-0000-0000-0000-000000000001', 'ffffffff-0000-0000-0000-0000000000a1', 'AP2112K-3.3TRG1', null, '{U1}', 'again')$$,
  'a case for AP2112K-3.3TRG1 is already open');
select pg_temp.expect_error(format($$select public.open_lifecycle_case('ffffffff-0000-0000-0000-000000000001', 'ffffffff-0000-0000-0000-0000000000a2', 'NE555DR', null, '{}', 'x', 'low', %L)$$, pg_temp.id('eol')),
  'the notice is not about this part');
select pg_temp.expect_error(format($$select public.resolve_lifecycle_case(%L, 'not_affected', 'x')$$, pg_temp.id('case')), 'only owner, reviewer%');
select public.assess_lifecycle_case(pg_temp.id('case'), 'U1 on every board; 40 in stock; pin-compatible TLV755P is a candidate.');

-- 4. Substitutes: checks with a basis; a passing test check names a passing test run; qualification rules.
insert into ids select 'sub', public.propose_substitute('ffffffff-0000-0000-0000-000000000001', pg_temp.id('case'), null, 'TLV75533PDBVR', 'Texas Instruments', 'ffffffff-0000-0000-0000-0000000000a3');
select pg_temp.expect_error(format($$select public.propose_substitute('ffffffff-0000-0000-0000-000000000001', %L, null, 'ap2112k-3.3trg1', 'Diodes')$$, pg_temp.id('case')), 'a substitute must be a different part');
select pg_temp.expect_error(format($$select public.save_substitute_checks(%L, '{"pinout": {"result": "pass"}}')$$, pg_temp.id('sub')), 'pinout: give the basis%');
select pg_temp.expect_error(format($$select public.save_substitute_checks(%L, '{"looks": {"result": "pass", "basis": "x"}}')$$, pg_temp.id('sub')), 'unknown check looks');
select pg_temp.expect_error(format($$select public.save_substitute_checks(%L, '{"test": {"result": "pass", "basis": "bench"}}')$$, pg_temp.id('sub')), 'test: a passing result names a passing test run%');
select public.save_substitute_checks(pg_temp.id('sub'), '{"pinout": {"result": "pass", "basis": "SOT-23-5, same pin-out (datasheet table 5-1)"},
  "electrical": {"result": "pass", "basis": "500 mA vs 600 mA; dropout 238 mV vs 250 mV at 300 mA; stable with 1 uF"}}');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000d');
select pg_temp.expect_error(format($$select public.decide_substitute(%L, true, 'ok')$$, pg_temp.id('sub')), 'checks not done: environmental, supply, test');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000c');
-- A passing bench test on a unit fitted with the substitute.
insert into ids select 'unit', public.create_unit('ffffffff-0000-0000-0000-000000000001', 'SUB-01', 'A');
insert into ids select 'tp', public.save_procedure('ffffffff-0000-0000-0000-000000000001', null, 'LDO output', 'functional', '{}', null, null,
  '[{"key": "v", "label": "+3V3", "kind": "numeric", "unit": "V", "min": 3.2, "max": 3.4}]');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000d');
select public.approve_procedure(pg_temp.id('tp'));
select pg_temp.act_as('00000000-0000-0000-0000-00000000000c');
insert into ids select 'run', public.record_test_run(pg_temp.id('unit'), pg_temp.id('tp'), now(), '{}', '{"v": 3.31}');
select public.save_substitute_checks(pg_temp.id('sub'), jsonb_build_object(
  'pinout', '{"result": "pass", "basis": "SOT-23-5, same pin-out"}'::jsonb,
  'electrical', '{"result": "pass", "basis": "datasheet comparison"}'::jsonb,
  'environmental', '{"result": "pass", "basis": "-40 to 125 C"}'::jsonb,
  'supply', '{"result": "na", "basis": "single source accepted for now"}'::jsonb,
  'test', jsonb_build_object('result', 'pass', 'basis', 'bench test on SUB-01', 'test_run_id', pg_temp.id('run'))));
select pg_temp.act_as('00000000-0000-0000-0000-00000000000d');
select pg_temp.expect_error(format($$select public.resolve_lifecycle_case(%L, 'substitute', 'swap', %L)$$, pg_temp.id('case'), pg_temp.id('sub')), 'choose a qualified substitute');
select public.decide_substitute(pg_temp.id('sub'), true, 'Drop-in; bench test passed.');
select pg_temp.expect_error(format($$select public.resolve_lifecycle_case(%L, 'last_time_buy', 'buy')$$, pg_temp.id('case')), 'give the last-time-buy quantity');
insert into ids select 'dec', public.resolve_lifecycle_case(pg_temp.id('case'), 'substitute', 'Pin-compatible, qualified and tested.', pg_temp.id('sub'));
select pg_temp.check((select statement = 'Replace AP2112K-3.3TRG1 with Texas Instruments TLV75533PDBVR.' and evidence_category = 'hardware_test'
                        and title like 'LC-001: End of life%' from public.decisions where id = pg_temp.id('dec')), 'decision with tested evidence');
select pg_temp.check((select status = 'resolved' and resolution = 'substitute' and substitute_id = pg_temp.id('sub') from public.lifecycle_cases where id = pg_temp.id('case')), 'resolved');
select pg_temp.expect_error(format($$select public.assess_lifecycle_case(%L, 'x')$$, pg_temp.id('case')), '%');

-- A second case can be opened for the same part once the first is resolved; last-time buy; failed checks reject.
select pg_temp.act_as('00000000-0000-0000-0000-00000000000c');
insert into ids select 'case2', public.open_lifecycle_case('ffffffff-0000-0000-0000-000000000001', 'ffffffff-0000-0000-0000-0000000000a2', 'NE555DR', 'TI', '{U2,U3}', 'NRND', 'medium');
insert into ids select 'sub2', public.propose_substitute('ffffffff-0000-0000-0000-000000000001', pg_temp.id('case2'), null, 'LMC555', 'Texas Instruments');
select public.save_substitute_checks(pg_temp.id('sub2'), '{"pinout": {"result": "fail", "basis": "different package"}}');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000d');
select pg_temp.expect_error(format($$select public.decide_substitute(%L, true, 'x')$$, pg_temp.id('sub2')), 'the pinout check failed');
select public.decide_substitute(pg_temp.id('sub2'), false, 'Package does not fit.');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000c');
select public.assess_lifecycle_case(pg_temp.id('case2'), '2 per board; 300 boards planned; 600 + 10% spares.');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
select public.resolve_lifecycle_case(pg_temp.id('case2'), 'last_time_buy', 'Product end of life is within 3 years.', null, 660);
select pg_temp.check((select ltb_quantity = 660 from public.lifecycle_cases where id = pg_temp.id('case2')), 'LTB quantity');

-- 5. Clients read; outsiders do not; S8 blockers; audit.
select pg_temp.act_as('00000000-0000-0000-0000-0000000000e3');
select pg_temp.check((select count(*) = 2 from public.lifecycle_cases) and (select count(*) = 2 from public.substitutes), 'clients read cases and substitutes');
select pg_temp.expect_error($$select public.open_lifecycle_case('ffffffff-0000-0000-0000-000000000001', null, 'X', null, '{}', 'x')$$, 'only owner, engineer%');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000e2');
select pg_temp.check((select count(*) = 0 from public.lifecycle_cases), 'outsiders see none');
select pg_temp.act_as(null);
select pg_temp.check((select not exists (select 1 from jsonb_array_elements(public.stage_blockers('ffffffff-0000-0000-0000-000000000001', 'S8')) e
                                          where e ->> 'kind' = 'lifecycle')), 'no S8 lifecycle blockers once cases are resolved');
insert into public.lifecycle_cases (project_id, case_no, mpn, trigger_text) values ('ffffffff-0000-0000-0000-000000000001', 9, 'MYSTERY-1', 'no catalog data');
select pg_temp.check((select jsonb_path_exists(public.stage_blockers('ffffffff-0000-0000-0000-000000000001', 'S8'), '$[*] ? (@.text like_regex "LC-009")')), 'open case blocks S8');
select pg_temp.check((select count(*) from public.audit_events where project_id = 'ffffffff-0000-0000-0000-000000000001'
                       and event_type like any (array['lifecycle.%', 'substitute.%'])) = 11, 'audited');

\o
select 'All lifecycle tests passed.' as result;
