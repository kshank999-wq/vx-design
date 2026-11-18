-- Manufacturer process rules and trade studies. Alice owns, Carol engineers, Dave reviews, Cleo is a client;
-- Lib is a library editor with no projects; Zoe has no projects at all.
\set ON_ERROR_STOP on
\o /dev/null

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000c1', 'lib@trade.test'),
  ('00000000-0000-0000-0000-0000000000c2', 'zoe@trade.test'),
  ('00000000-0000-0000-0000-0000000000c3', 'cleo@trade.test');
insert into public.knowledge_editors (user_id, note) values ('00000000-0000-0000-0000-0000000000c1', 'trade test');

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
insert into public.projects (id, name) values ('dddddddd-0000-0000-0000-000000000001', 'Trade test');
insert into public.project_members (project_id, user_id, role) values
  ('dddddddd-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000c', 'engineer'),
  ('dddddddd-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000d', 'reviewer'),
  ('dddddddd-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000c3', 'client');

-- 1. Process rules: directory users add them with a source; a change clears verification; editors verify.
select pg_temp.act_as(null);
insert into public.manufacturers (id, display_name) values ('dddddddd-0000-0000-0000-0000000000f1', 'Example PCB Works');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
insert into ids select 'rules', public.save_process_rules('dddddddd-0000-0000-0000-0000000000f1', 'pcb_fab',
  '{"layer_counts": [2, 4], "min_track_mm": 0.127, "min_drill_mm": 0.3}', 'https://example.test/capabilities');
select pg_temp.expect_error($$select public.save_process_rules('dddddddd-0000-0000-0000-0000000000f1', 'pcb_fab', '{}')$$, 'say where the rules come from%');
select pg_temp.expect_error($$select public.save_process_rules('dddddddd-0000-0000-0000-0000000000f1', 'laser', '{}', 'https://x.test')$$, '%process_rules_process_check%');
select pg_temp.expect_error($$select public.save_process_rules('dddddddd-0000-0000-0000-0000000000f1', 'pcb_fab', '{}', 'http://x.test')$$, '%process_rules_source_url_check%');
select pg_temp.expect_error(format($$select public.verify_process_rules(%L)$$, pg_temp.id('rules')), 'only library editors%');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000c1');
select public.verify_process_rules(pg_temp.id('rules'));
select pg_temp.check((select verified_at is not null from public.process_rules where id = pg_temp.id('rules')), 'verified');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000c');
select public.save_process_rules('dddddddd-0000-0000-0000-0000000000f1', 'pcb_fab', '{"layer_counts": [2], "min_track_mm": 0.1}',
                                 null, 'Quote email, 12 Nov', '2026-11-12');
select pg_temp.check((select verified_at is null and rules ->> 'min_track_mm' = '0.1' and checked_on = '2026-11-12'
                        from public.process_rules where id = pg_temp.id('rules')), 'an edit replaces the rules and clears verification');
select pg_temp.check((select count(*) from public.process_rules) >= 1, 'directory users read rules');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000c3');
select pg_temp.check((select count(*) from public.process_rules where id = pg_temp.id('rules')) = 0, 'clients do not see the directory');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000c2');
select pg_temp.expect_error($$select public.save_process_rules('dddddddd-0000-0000-0000-0000000000f1', 'cnc', '{}', 'https://x.test')$$, 'only project owners, engineers and library editors%');

-- 2. Trade studies: owners and engineers create and edit drafts; keys and scores are checked.
select pg_temp.act_as('00000000-0000-0000-0000-00000000000c');
insert into ids select 'ts', public.create_trade_study('dddddddd-0000-0000-0000-000000000001', 'Radio: module or chip-down?',
  '[{"key": "meets", "label": "Meets requirements", "kind": "must", "weight": 0},
    {"key": "unit_cost", "label": "Unit cost", "kind": "lower", "weight": 8, "unit": "USD"}]',
  '[{"key": "module", "name": "BLE module"}, {"key": "custom", "name": "Chip-down"}]');
select pg_temp.check((select study_no = 1 and stage = 'S2' and status = 'draft' from public.trade_studies where id = pg_temp.id('ts')), 'TS-001, S2, draft');
select pg_temp.expect_error(format($$select public.save_trade_study(%L, null, null, '{}', '[{"key": "Bad Key", "label": "x", "kind": "lower", "weight": 1}]', '[]', '{}', null)$$, pg_temp.id('ts')),
  'each criterion needs a key%');
select pg_temp.expect_error(format($$select public.save_trade_study(%L, null, null, '{}', '[{"key": "a", "label": "x", "kind": "lower", "weight": 1}, {"key": "a", "label": "y", "kind": "lower", "weight": 1}]', '[]', '{}', null)$$, pg_temp.id('ts')),
  'criterion keys must be unique');
select pg_temp.expect_error(format($$select public.save_trade_study(%L, null, null, '{}', '[{"key": "a", "label": "x", "kind": "lower", "weight": 1}]', '[{"key": "m", "name": "M"}]', '{"zz": {"a": {"value": 1}}}', null)$$, pg_temp.id('ts')),
  'scores for unknown option zz');
select pg_temp.expect_error(format($$select public.decide_trade_study(%L, 'module', 'cheaper')$$, pg_temp.id('ts')), 'only owners and reviewers%');
select public.save_trade_study(pg_temp.id('ts'), 'Radio: module or chip-down?', 'Bluetooth LE for timecode sync', '{REQ-IF-001}',
  '[{"key": "meets", "label": "Meets requirements", "kind": "must", "weight": 0},
    {"key": "unit_cost", "label": "Unit cost", "kind": "lower", "weight": 8, "unit": "USD"}]',
  '[{"key": "module", "name": "BLE module"}, {"key": "custom", "name": "Chip-down"}]',
  '{"module": {"meets": {"value": true, "basis": "datasheet"}, "unit_cost": {"value": 6.1, "source": "catalog", "basis": "DigiKey 500 pcs"}},
    "custom": {"meets": {"value": false, "basis": "needs FCC testing we cannot fund"}, "unit_cost": {"value": 2.4}}}',
  '{"winner": "module", "ranking": [{"key": "module", "name": "BLE module", "total": 0, "excluded": []},
                                    {"key": "custom", "name": "Chip-down", "total": null, "excluded": ["Meets requirements"]}]}');

-- 3. Deciding: reviewers, with a rationale; excluded options cannot be chosen; the decision carries the evidence.
select pg_temp.act_as('00000000-0000-0000-0000-00000000000d');
select pg_temp.expect_error(format($$select public.decide_trade_study(%L, 'module', ' ')$$, pg_temp.id('ts')), 'give the rationale%');
select pg_temp.expect_error(format($$select public.decide_trade_study(%L, 'custom', 'cheapest')$$, pg_temp.id('ts')), 'Chip-down fails a must-have criterion%');
select pg_temp.expect_error(format($$select public.decide_trade_study(%L, 'other', 'x')$$, pg_temp.id('ts')), 'choose one of the study''s options');
insert into ids select 'decision', public.decide_trade_study(pg_temp.id('ts'), 'module', 'Pre-certified; chip-down fails certification budget.');
select pg_temp.check((select title = 'TS-001: Radio: module or chip-down?' and statement = 'Chose BLE module.'
                        and evidence_category = 'unverified_assumption' and alternatives -> 0 ->> 'option' = 'Chip-down'
                        and evidence_refs -> 0 -> 'scores' -> 'module' -> 'unit_cost' ->> 'basis' = 'DigiKey 500 pcs'
                        from public.decisions where id = pg_temp.id('decision')), 'the decision holds the choice, alternatives and evidence (custom unit cost had no basis)');
select pg_temp.check((select status = 'decided' and chosen_option = 'module' from public.trade_studies where id = pg_temp.id('ts')), 'decided');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000c');
select pg_temp.expect_error(format($$select public.save_trade_study(%L, 'x', null, '{}', '[]', '[]', '{}', null)$$, pg_temp.id('ts')), 'the study is decided; start a new one%');

-- 4. Withdrawing needs a reason; clients read studies but cannot start them; outsiders see nothing.
insert into ids select 'ts2', public.create_trade_study('dddddddd-0000-0000-0000-000000000001', 'Battery: 1S or 2S?');
select pg_temp.expect_error(format($$select public.withdraw_trade_study(%L, '')$$, pg_temp.id('ts2')), 'say why the study is withdrawn');
select public.withdraw_trade_study(pg_temp.id('ts2'), 'Settled by the power budget.');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000c3');
select pg_temp.check((select count(*) from public.trade_studies) = 2, 'clients read the studies');
select pg_temp.expect_error($$select public.create_trade_study('dddddddd-0000-0000-0000-000000000001', 'x')$$, 'only owners and engineers%');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000c2');
select pg_temp.check((select count(*) from public.trade_studies) = 0, 'outsiders see none');
select pg_temp.act_as(null);
select pg_temp.check((select count(*) from public.audit_events where project_id = 'dddddddd-0000-0000-0000-000000000001'
                       and event_type in ('trade_study.created', 'trade_study.decided', 'trade_study.withdrawn')) = 4, 'audited');

\o
select 'All trade study and process rule tests passed.' as result;
