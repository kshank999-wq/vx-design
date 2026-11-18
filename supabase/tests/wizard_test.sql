-- Requirement wizard. Uses the lifecycle test project (Alice owns, Carol engineers, Dave reviews, Cleo is a client).
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
create temp table res (name text primary key, v jsonb);
grant all on res to authenticated;

-- Clients answer; reviewers cannot; only owners and engineers apply.
select pg_temp.act_as('00000000-0000-0000-0000-0000000000e3');
select public.save_wizard_answers('ffffffff-0000-0000-0000-000000000001', '{"power": {"source": "li_ion", "battery_hours": 12}}');
select pg_temp.check((select wizard -> 'power' ->> 'battery_hours' = '12' from public.project_intake where project_id = 'ffffffff-0000-0000-0000-000000000001'), 'saved');
select pg_temp.expect_error($$select public.apply_wizard('ffffffff-0000-0000-0000-000000000001', '{}', '[]')$$, 'only owner, engineer%');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000d');
select pg_temp.expect_error($$select public.save_wizard_answers('ffffffff-0000-0000-0000-000000000001', '{}')$$, 'only owner, engineer, client%');

-- Applying: numbering continues per code; the intake is saved; wizard keys make it repeatable.
select pg_temp.act_as('00000000-0000-0000-0000-00000000000c');
insert into public.requirements (project_id, ref_code, kind, text, status) values ('ffffffff-0000-0000-0000-000000000001', 'REQ-PWR-007', 'power', 'Existing.', 'confirmed');
insert into res select 'a1', public.apply_wizard('ffffffff-0000-0000-0000-000000000001', '{"intended_use": "Slate", "regions": ["US"], "power_source": "Li-ion"}',
  '[{"key": "battery_life", "code": "PWR", "kind": "power", "priority": "must", "text": "Run 12 h.", "acceptance_criteria": "Measured.", "basis": "Power"},
    {"key": "markets", "code": "REG", "kind": "regulatory", "priority": "must", "text": "Sell in US.", "acceptance_criteria": "Listed.", "basis": "Markets"}]');
select pg_temp.check((select v -> 'added' = '["REQ-PWR-008", "REQ-REG-001"]' from res where name = 'a1'), 'numbered after existing codes');
select pg_temp.check((select status = 'extracted' and origin = 'wizard' and source_section = 'Requirement wizard: Power' from public.requirements
                       where project_id = 'ffffffff-0000-0000-0000-000000000001' and ref_code = 'REQ-PWR-008'), 'draft wizard requirement with its basis');
select pg_temp.check((select intended_use = 'Slate' and regions = '{US}' from public.project_intake where project_id = 'ffffffff-0000-0000-0000-000000000001'), 'intake saved');
select pg_temp.check((select wizard -> 'power' ->> 'battery_hours' = '12' from public.project_intake where project_id = 'ffffffff-0000-0000-0000-000000000001'), 'answers kept');
-- Again with a changed battery requirement, the same markets one, and no longer the markets... (here: unchanged)
update public.requirements set status = 'confirmed' where project_id = 'ffffffff-0000-0000-0000-000000000001' and ref_code = 'REQ-PWR-008';
insert into res select 'a2', public.apply_wizard('ffffffff-0000-0000-0000-000000000001', '{"intended_use": "Slate", "regions": ["US"]}',
  '[{"key": "battery_life", "code": "PWR", "kind": "power", "priority": "must", "text": "Run 16 h.", "acceptance_criteria": "Measured.", "basis": "Power"},
    {"key": "markets", "code": "REG", "kind": "regulatory", "priority": "must", "text": "Sell in US.", "acceptance_criteria": "Listed.", "basis": "Markets"}]');
select pg_temp.check((select v -> 'updated' = '["REQ-PWR-008"]' and (v ->> 'unchanged')::int = 1 and v -> 'added' = '[]' from res where name = 'a2'), 'update, not duplicate');
select pg_temp.check((select text = 'Run 16 h.' and status = 'extracted' from public.requirements where project_id = 'ffffffff-0000-0000-0000-000000000001' and ref_code = 'REQ-PWR-008'),
  'a changed requirement goes back to draft for confirmation');
-- Once a plan task uses it, a changed answer leaves it and reports it; a dropped answer is listed.
select pg_temp.act_as(null);
insert into public.plans (id, project_id, version, status) values ('ffffffff-0000-0000-0000-0000000000c1', 'ffffffff-0000-0000-0000-000000000001', 90, 'draft');
insert into public.tasks (id, project_id, plan_id, key, title, discipline, status, position)
values ('ffffffff-0000-0000-0000-0000000000c2', 'ffffffff-0000-0000-0000-000000000001', 'ffffffff-0000-0000-0000-0000000000c1', 'pwr', 'Power', 'power', 'draft', 1);
insert into public.task_requirements (task_id, requirement_id)
select 'ffffffff-0000-0000-0000-0000000000c2', id from public.requirements where project_id = 'ffffffff-0000-0000-0000-000000000001' and ref_code = 'REQ-PWR-008';
select pg_temp.act_as('00000000-0000-0000-0000-00000000000c');
insert into res select 'a3', public.apply_wizard('ffffffff-0000-0000-0000-000000000001', '{}',
  '[{"key": "battery_life", "code": "PWR", "kind": "power", "priority": "must", "text": "Run 20 h.", "acceptance_criteria": "Measured.", "basis": "Power"}]');
select pg_temp.check((select v -> 'in_use' = '["REQ-PWR-008"]' and v -> 'no_longer_answered' = '["REQ-REG-001"]' from res where name = 'a3'), 'in use left alone; dropped listed');
select pg_temp.check((select text = 'Run 16 h.' from public.requirements where project_id = 'ffffffff-0000-0000-0000-000000000001' and ref_code = 'REQ-PWR-008'), 'unchanged while in use');
select pg_temp.expect_error($$select public.apply_wizard('ffffffff-0000-0000-0000-000000000001', '{}', '[{"key": "Bad Key", "code": "PWR"}]')$$, 'malformed wizard requirement');

\o
select 'All requirement wizard tests passed.' as result;
