-- Parts already chosen and the prior-work register. Uses the lifecycle test project (Carol engineers, Dave reviews,
-- Cleo is a client).
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

-- Parts: engineers add and edit; the same part number (ignoring punctuation and case) is listed once.
select pg_temp.act_as('00000000-0000-0000-0000-00000000000c');
insert into ids select 'p1', public.save_project_part('ffffffff-0000-0000-0000-000000000001', null, 'RVT101HVHNWC00-B', 'Riverdi', 'Front touchscreen', 'display', 'selected', 'samples ordered');
select pg_temp.expect_error($$select public.save_project_part('ffffffff-0000-0000-0000-000000000001', null, 'rvt101hvhnwc00b', 'Riverdi', null, 'display', 'selected', null)$$, '%already listed%');
select public.save_project_part('ffffffff-0000-0000-0000-000000000001', pg_temp.id('p1'), 'RVT101HVHNWC00-B', 'Riverdi', 'Front touchscreen', 'display', 'designed', null);
select pg_temp.check((select status = 'designed' from public.project_parts where id = pg_temp.id('p1')), 'part edited');
insert into ids select 'ref', public.add_project_reference('ffffffff-0000-0000-0000-000000000001', 'datasheet', 'Riverdi datasheet', null,
  'rvt.pdf', 'ffffffff-0000-0000-0000-000000000001/references/pw-rvt.pdf', repeat('9', 64), 1000, 'application/pdf');
select public.attach_reference_to_part(pg_temp.id('ref'), pg_temp.id('p1'));
select pg_temp.check((select part_id = pg_temp.id('p1') from public.project_references where id = pg_temp.id('ref')), 'datasheet attached');

-- Reviewers and clients read but cannot change parts or build the register.
select pg_temp.act_as('00000000-0000-0000-0000-00000000000d');
select pg_temp.check((select count(*) = 1 from public.project_parts where project_id = 'ffffffff-0000-0000-0000-000000000001'), 'reviewer reads parts');
select pg_temp.expect_error($$select public.save_project_part('ffffffff-0000-0000-0000-000000000001', null, 'X1', null, null, 'other', 'candidate', null)$$, 'only owner, engineer%');
select pg_temp.expect_error($$select public.request_prior_work_register('ffffffff-0000-0000-0000-000000000001')$$, 'only owner, engineer%');

-- Building: one at a time; a worker claims, reports progress and completes.
select pg_temp.act_as('00000000-0000-0000-0000-00000000000c');
insert into ids select 'reg1', public.request_prior_work_register('ffffffff-0000-0000-0000-000000000001');
select pg_temp.expect_error($$select public.request_prior_work_register('ffffffff-0000-0000-0000-000000000001')$$, '%already being built%');
select pg_temp.expect_error($$select public.claim_prior_work_register('w1')$$, '%permission denied%');
select pg_temp.act_as(null);
select pg_temp.check((select (public.claim_prior_work_register('w1')).id = pg_temp.id('reg1')), 'claimed');
select public.progress_prior_work_register(pg_temp.id('reg1'), 'w1', 'read 2 of 5 documents');
select pg_temp.check((select progress = 'read 2 of 5 documents' from public.prior_work_registers where id = pg_temp.id('reg1')), 'progress');
select pg_temp.expect_error($$select public.complete_prior_work_register(pg_temp.id('reg1'), 'w2', '[]', '[]', 'm', '[]')$$, '%not held by this worker%');
select public.complete_prior_work_register(pg_temp.id('reg1'), 'w1',
  '[{"id": "PR-1", "key": "display|RVT101HVHNWC00B", "title": "Display"}, {"id": "PR-2", "key": "timecode|DS3231", "title": "RTC"}]', '[{"file": "a.md"}]', 'm', '[]');
select pg_temp.check((select status = 'ready' and jsonb_array_length(items) = 2 from public.prior_work_registers where id = pg_temp.id('reg1')), 'ready');

-- People correct items; a rebuild carries the corrections over by key even when the ids move.
select pg_temp.act_as('00000000-0000-0000-0000-00000000000c');
select public.edit_prior_work_item(pg_temp.id('reg1'), 'PR-2', null, 'replaced by the TCXO', true);
select public.edit_prior_work_item(pg_temp.id('reg1'), 'PR-1', 'verified', null, false);
select pg_temp.expect_error($$select public.edit_prior_work_item(pg_temp.id('reg1'), 'PR-9', null, null, false)$$, 'no item PR-9');
select pg_temp.expect_error($$select public.edit_prior_work_item(pg_temp.id('reg1'), 'PR-1', 'maybe', null, false)$$, 'unknown status maybe');
insert into ids select 'reg2', public.request_prior_work_register('ffffffff-0000-0000-0000-000000000001');
select pg_temp.act_as(null);
select public.claim_prior_work_register('w1');
select public.complete_prior_work_register(pg_temp.id('reg2'), 'w1',
  '[{"id": "PR-1", "key": "compute|CM5", "title": "CM5"}, {"id": "PR-2", "key": "display|RVT101HVHNWC00B", "title": "Display"}, {"id": "PR-3", "key": "timecode|DS3231", "title": "RTC"}]',
  '[]', 'm', '[]');
select pg_temp.check((select edits = '{"PR-2": {"status": "verified"}, "PR-3": {"note": "replaced by the TCXO", "excluded": true}}'::jsonb
                        from public.prior_work_registers where id = pg_temp.id('reg2')), 'corrections carried over by key');

-- A failed build records the reason.
select pg_temp.act_as('00000000-0000-0000-0000-00000000000c');
insert into ids select 'reg3', public.request_prior_work_register('ffffffff-0000-0000-0000-000000000001');
select pg_temp.act_as(null);
select public.claim_prior_work_register('w1');
select public.complete_prior_work_register(pg_temp.id('reg3'), 'w1', '[]', '[]', 'm', '[]', 'model unavailable');
select pg_temp.check((select status = 'failed' and error = 'model unavailable' from public.prior_work_registers where id = pg_temp.id('reg3')), 'failed');

-- Tasks may replace earlier work.
select pg_temp.act_as('00000000-0000-0000-0000-00000000000c');
insert into ids select 'plan', public.create_plan_version('ffffffff-0000-0000-0000-000000000001', jsonb_build_object('summary', 's',
  'tasks', jsonb_build_array(jsonb_build_object('key', 'rtc', 'title', 'Replace the RTC', 'discipline', 'components',
    'basis', '{"mode": "replace", "sources": ["PR-3"], "reason": "drifts", "concerns": ["2 ppm"], "alternatives": ["SiT5356 TCXO"]}'::jsonb))));
select pg_temp.check((select basis ->> 'mode' = 'replace' and basis -> 'alternatives' ->> 0 = 'SiT5356 TCXO' from public.tasks where plan_id = pg_temp.id('plan')), 'replace basis');

-- Removing a part detaches its files.
select public.remove_project_part(pg_temp.id('p1'));
select pg_temp.check((select part_id is null from public.project_references where id = pg_temp.id('ref')), 'files detached');

\o
select 'All prior-work tests passed.' as result;
