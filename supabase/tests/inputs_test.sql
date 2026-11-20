-- Project inputs: references, prior-work choice, plan inputs and task basis. Uses the lifecycle test project (Carol
-- engineers, Dave reviews, Cleo is a client; e2 is an outsider).
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

-- References: engineers add (only into the project's references folder), clients read but cannot add.
select pg_temp.act_as('00000000-0000-0000-0000-00000000000c');
select pg_temp.expect_error($$select public.add_project_reference('ffffffff-0000-0000-0000-000000000001', 'mockup', 'Front', null, 'a.png',
  'ffffffff-0000-0000-0000-000000000001/documents/a.png', repeat('a', 64), 10, 'image/png')$$, '%references folder%');
insert into ids select 'r1', public.add_project_reference('ffffffff-0000-0000-0000-000000000001', 'mockup', 'Front view', 'Screen 7 in, 3 buttons on the right',
  'front.png', 'ffffffff-0000-0000-0000-000000000001/references/aaaa-front.png', repeat('a', 64), 1000, 'image/png');
insert into ids select 'r2', public.add_project_reference('ffffffff-0000-0000-0000-000000000001', 'prior_design', 'Old slate board', null,
  'old.pdf', 'ffffffff-0000-0000-0000-000000000001/references/bbbb-old.pdf', repeat('b', 64), 1000, 'application/pdf');
select pg_temp.expect_error($$select public.add_project_reference('ffffffff-0000-0000-0000-000000000001', 'mockup', 'Again', null, 'x.png',
  'ffffffff-0000-0000-0000-000000000001/references/cccc-x.png', repeat('a', 64), 10, 'image/png')$$, '%already a reference%');
select pg_temp.check((select array_agg(ref_no order by ref_no) = '{1,2}' from public.project_references where project_id = 'ffffffff-0000-0000-0000-000000000001'), 'numbered');
select public.update_project_reference(pg_temp.id('r2'), 'prior_design', 'Old slate main board', 'Keep the clapper switch', false);
select pg_temp.check((select not use_in_plan and note = 'Keep the clapper switch' from public.project_references where id = pg_temp.id('r2')), 'edited');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000e3');
select pg_temp.check((select count(*) = 2 from public.project_references), 'clients read references');
select pg_temp.expect_error($$select public.add_project_reference('ffffffff-0000-0000-0000-000000000001', 'mockup', 'Mine', null, 'm.png',
  'ffffffff-0000-0000-0000-000000000001/references/dddd-m.png', repeat('d', 64), 10, 'image/png')$$, 'only owner, engineer%');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000e2');
select pg_temp.check((select count(*) = 0 from public.project_references), 'outsiders see none');

-- Concept rounds take image references only.
select pg_temp.act_as('00000000-0000-0000-0000-00000000000c');
select pg_temp.expect_error(format($$select public.request_concepts_with_references('ffffffff-0000-0000-0000-000000000001', 'clean', 1, null, array[%L]::uuid[])$$, pg_temp.id('r2')), '%PNG, JPEG or WebP%');
insert into ids select 'round', public.request_concepts_with_references('ffffffff-0000-0000-0000-000000000001', 'Brushed aluminium, rubber grip', 1, null, array[pg_temp.id('r1')]);
select pg_temp.check((select reference_ids = array[pg_temp.id('r1')] from public.concept_rounds where id = pg_temp.id('round')), 'round keeps references');
select pg_temp.expect_error(format($$select public.remove_project_reference(%L)$$, pg_temp.id('r1')), '%concept round in progress%');
select pg_temp.check((select public.remove_project_reference(pg_temp.id('r2')) like '%/references/bbbb-old.pdf'), 'removed, path returned');

-- Plans keep their inputs and each task's basis, through revision.
select pg_temp.act_as(null);
insert into public.requirements (id, project_id, ref_code, kind, status, priority, text, origin)
values ('ffffffff-0000-0000-0000-0000000000f1', 'ffffffff-0000-0000-0000-000000000001', 'REQ-901', 'functional', 'confirmed', 'must', 'Show timecode', 'manual');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000c');
insert into ids select 'plan', public.create_plan_version('ffffffff-0000-0000-0000-000000000001', jsonb_build_object(
  'summary', 'From all inputs', 'inputs', '[{"id": "PW-1", "kind": "flux_audit", "label": "Flux audit #1"}]'::jsonb,
  'tasks', jsonb_build_array(
    jsonb_build_object('key', 'tc-reuse', 'title', 'Bring the timecode board over', 'discipline', 'schematic', 'requirement_refs', '["REQ-901"]'::jsonb,
                       'basis', '{"mode": "adapt", "sources": ["PW-1"], "reason": "Placed in Flux, not routed"}'::jsonb),
    jsonb_build_object('key', 'tc-route', 'title', 'Route', 'discipline', 'pcb_layout', 'upstream_keys', '["tc-reuse"]'::jsonb))));
select pg_temp.check((select inputs -> 0 ->> 'id' = 'PW-1' from public.plans where id = pg_temp.id('plan')), 'plan inputs');
select pg_temp.check((select basis ->> 'mode' = 'adapt' and basis -> 'sources' ->> 0 = 'PW-1' from public.tasks where plan_id = pg_temp.id('plan') and key = 'tc-reuse'), 'task basis');
select pg_temp.check((select basis is null from public.tasks where plan_id = pg_temp.id('plan') and key = 'tc-route'), 'no basis given');
select pg_temp.expect_error($$select public.create_plan_version('ffffffff-0000-0000-0000-000000000001', '{"tasks": [{"key": "x", "title": "x", "discipline": "schematic", "basis": {"mode": "maybe"}}]}')$$, '%tasks_basis_check%');
insert into ids select 'plan2', public.revise_plan(pg_temp.id('plan'));
select pg_temp.check((select p.inputs -> 0 ->> 'id' = 'PW-1' and t.basis ->> 'reason' = 'Placed in Flux, not routed'
                        from public.plans p join public.tasks t on t.plan_id = p.id where p.id = pg_temp.id('plan2') and t.key = 'tc-reuse'), 'revision keeps inputs and basis');

-- Prior work: engineers choose which Flux audits a plan uses.
select pg_temp.act_as(null);
insert into public.flux_audits (id, project_id, audit_no, title) values ('ffffffff-0000-0000-0000-0000000000f2', 'ffffffff-0000-0000-0000-000000000001', 90, 'Old Flux');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000c');
select public.set_flux_audit_in_plan('ffffffff-0000-0000-0000-0000000000f2', false);
select pg_temp.check((select not use_in_plan from public.flux_audits where id = 'ffffffff-0000-0000-0000-0000000000f2'), 'audit excluded');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000d');
select pg_temp.expect_error($$select public.set_flux_audit_in_plan('ffffffff-0000-0000-0000-0000000000f2', true)$$, 'only owner, engineer%');

\o
select 'All project inputs tests passed.' as result;
