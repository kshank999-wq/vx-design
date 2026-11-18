-- Security lint and G6 checks. Runs last, over the whole schema, so a future migration that opens a gap fails here:
--   RLS on every table, nothing for anon, definer functions pinned and checking who calls them, worker-only functions
--   closed to users, staff-only storage folders, signed assistant answers (workspace_test), and the audit hash chain.
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
create function pg_temp.none(p_what text, p_sql text) returns void language plpgsql as $$
declare v text;
begin
  execute format('select string_agg(x::text, %L) from (%s) q(x)', ', ', p_sql) into v;
  if v is not null then raise exception 'security lint: %: %', p_what, v; end if;
end;
$$;

-- 1. Tables and views.
select pg_temp.none('tables without row level security',
  $$select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity$$);
select pg_temp.none('views that bypass row level security (need security_invoker)',
  $$select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'v'
     and not coalesce(c.reloptions::text like '%security_invoker=true%', false)$$);
select pg_temp.none('anon has table privileges',
  $$select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'v')
     and (has_table_privilege('anon', c.oid, 'select') or has_table_privilege('anon', c.oid, 'insert')
          or has_table_privilege('anon', c.oid, 'update') or has_table_privilege('anon', c.oid, 'delete'))$$);
select pg_temp.none('private schema reachable by users',
  $$select r from unnest(array['anon', 'authenticated']) r where has_schema_privilege(r, 'vx_private', 'usage')$$);

-- 2. Functions.
select pg_temp.none('functions anon can execute',
  $$select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prokind = 'f'
     and has_function_privilege('anon', p.oid, 'execute')$$);
select pg_temp.none('SECURITY DEFINER functions without a pinned search_path',
  $$select n.nspname || '.' || p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('public', 'vx_private') and p.prosecdef
       and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')$$);
select pg_temp.none('trigger functions users can call directly',
  $$select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'
     and p.prorettype = 'trigger'::regtype and has_function_privilege('authenticated', p.oid, 'execute')$$);
select pg_temp.none('worker-only functions users can call',
  $$select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'
     and (p.proname ~ '^(claim|complete|reap|heartbeat|yield|acquire|release|record|worker|set_assistant)_' or p.proname in ('add_scratch_version', 'begin_validation'))
     and has_function_privilege('authenticated', p.oid, 'execute')$$);
-- Every SECURITY DEFINER function a user can call must check who is calling (or be a pure check about the caller).
select pg_temp.none('SECURITY DEFINER functions callable by users with no authorization check',
  $$select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prosecdef
     and has_function_privilege('authenticated', p.oid, 'execute')
     and p.prosrc !~ '(has_project_role|is_project_member|is_project_staff|is_knowledge_editor|is_directory_user|kb_can_write|auth\.uid\(\)|confirmed_email|rfq_for_staff|flux_audit_for_staff|rfq_recipient_for_supplier)'$$);

-- 3. Fixed leaks (z: signed in, member of nothing).
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000ff', 'zed@outside.test');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000ff');
select pg_temp.expect_error($$select public.rfq_missing((select id from public.rfqs limit 1))$$, '%not permitted%');
select pg_temp.none('plan status visible to outsiders', $$select public.plan_status_of_task(id) from public.tasks where public.plan_status_of_task(id) is not null$$);
select pg_temp.act_as(null);
create temp table t_ids as select (select id from public.tasks limit 1) as task_id;
grant select on t_ids to authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000ff');
select pg_temp.none('plan status by task id for an outsider', $$select public.plan_status_of_task((select task_id from t_ids)) where public.plan_status_of_task((select task_id from t_ids)) is not null$$);

-- 4. Storage folders: clients read concepts and outputs, never RFQ packets or Flux uploads.
select pg_temp.act_as('00000000-0000-0000-0000-00000000000f');   -- client of bbbb...1
select pg_temp.none('client can read staff-only folders', $$select p from unnest(array[
  'bbbbbbbb-0000-0000-0000-000000000001/rfq/x/packet.zip', 'bbbbbbbb-0000-0000-0000-000000000001/flux/a/rev-a/x.zip']) p
  where public.project_file_readable(p)$$);
select pg_temp.none('client cannot read project outputs', $$select 1 where not public.project_file_readable('bbbbbbbb-0000-0000-0000-000000000001/concepts/r/1.png')$$);
select pg_temp.act_as('00000000-0000-0000-0000-00000000000c');   -- engineer
select pg_temp.none('staff cannot read staff folders', $$select 1 where not public.project_file_readable('bbbbbbbb-0000-0000-0000-000000000001/rfq/x/packet.zip')$$);
select pg_temp.act_as(null);

-- 5. Audit hash chain: intact, then detects an edit and a deletion made behind the application's back.
select pg_temp.none('audit chain broken before tampering',
  $$select coalesce(project_id::text, 'global') || ': ' || v.problem from (select distinct project_id from public.audit_events) p,
     lateral public.verify_audit_chain(p.project_id) v where not v.ok$$);
insert into public.audit_events (project_id, actor_type, event_type, payload) values ('bbbbbbbb-0000-0000-0000-000000000001', 'system', 'test.one', '{"n": 1}');
insert into public.audit_events (project_id, actor_type, event_type, payload) values ('bbbbbbbb-0000-0000-0000-000000000001', 'system', 'test.two', '{"n": 2}');
select pg_temp.none('new events not chained', $$select 1 from public.audit_events e where e.event_type = 'test.two'
  and e.prev_hash is distinct from (select hash from public.audit_events where event_type = 'test.one')$$);
select pg_temp.act_as('00000000-0000-0000-0000-00000000000f');
select pg_temp.expect_error($$select * from public.verify_audit_chain('bbbbbbbb-0000-0000-0000-000000000001')$$, '%not permitted%');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000d');   -- reviewer (staff)
select pg_temp.none('staff verification fails', $$select 1 from public.verify_audit_chain('bbbbbbbb-0000-0000-0000-000000000001') where not ok$$);
select pg_temp.act_as(null);
alter table public.audit_events disable trigger audit_events_no_update;
update public.audit_events set payload = '{"n": 99}' where event_type = 'test.one';
select pg_temp.none('edit not detected', $$select 1 from public.verify_audit_chain('bbbbbbbb-0000-0000-0000-000000000001')
  where ok or problem not like '%edited%'$$);
update public.audit_events set payload = '{"n": 1}' where event_type = 'test.one';
delete from public.audit_events where event_type = 'test.one';
select pg_temp.none('deletion not detected', $$select 1 from public.verify_audit_chain('bbbbbbbb-0000-0000-0000-000000000001')
  where ok or problem not like '%missing%'$$);
alter table public.audit_events enable trigger audit_events_no_update;

-- 6. New tables created later get nothing for anon by default.
create table public.zz_probe (id int);
select pg_temp.none('default privileges give anon a new table', $$select 1 where has_table_privilege('anon', 'public.zz_probe', 'select')$$);
drop table public.zz_probe;

-- 7. Virus scan results gate reading at the storage layer.
create function pg_temp.as_worker() returns void language plpgsql as $$
begin perform set_config('request.jwt.claim.sub', '', false); execute 'set role service_role'; end;
$$;
select pg_temp.act_as('00000000-0000-0000-0000-00000000000f');
select pg_temp.expect_error($$select public.record_file_scan('project-files', 'x', null, 1, 'clean', null, null, null)$$, '%permission denied%');
select pg_temp.as_worker();
select public.record_file_scan('project-files', 'bbbbbbbb-0000-0000-0000-000000000001/documents/bad.pdf', repeat('a', 64), 68, 'infected', 'ClamAV 1.4.6', 'Eicar-Test-Signature', null);
select public.record_file_scan('project-files', 'bbbbbbbb-0000-0000-0000-000000000001/documents/good.pdf', repeat('b', 64), 100, 'clean', 'ClamAV 1.4.6', null, null);
select pg_temp.act_as('00000000-0000-0000-0000-00000000000f');   -- client (member)
select pg_temp.none('infected upload readable', $$select 1 where public.project_file_readable('bbbbbbbb-0000-0000-0000-000000000001/documents/bad.pdf')$$);
select pg_temp.none('clean upload unreadable', $$select 1 where not public.project_file_readable('bbbbbbbb-0000-0000-0000-000000000001/documents/good.pdf')$$);
select pg_temp.none('unscanned upload unreadable while scans are optional', $$select 1 where not public.project_file_readable('bbbbbbbb-0000-0000-0000-000000000001/documents/new.pdf')$$);
select pg_temp.none('member cannot see the scan result', $$select 1 where not exists (select 1 from public.file_scans where signature = 'Eicar-Test-Signature')$$);
select pg_temp.act_as(null);
update public.platform_settings set value = 'true' where key = 'require_virus_scan';
select pg_temp.act_as('00000000-0000-0000-0000-00000000000f');
select pg_temp.none('unscanned upload readable while scans are required', $$select 1 where public.project_file_readable('bbbbbbbb-0000-0000-0000-000000000001/documents/new.pdf')$$);
select pg_temp.none('worker outputs blocked by the scan requirement', $$select 1 where not public.project_file_readable('bbbbbbbb-0000-0000-0000-000000000001/concepts/r/1.png')$$);
select pg_temp.act_as(null);
update public.platform_settings set value = 'false' where key = 'require_virus_scan';
select pg_temp.none('infection not audited', $$select 1 where not exists (select 1 from public.audit_events where event_type = 'file.infected'
  and payload ->> 'signature' = 'Eicar-Test-Signature' and project_id = 'bbbbbbbb-0000-0000-0000-000000000001')$$);

\echo 'All security tests passed.'
