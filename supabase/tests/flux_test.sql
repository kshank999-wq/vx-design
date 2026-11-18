-- Flux audit tests: who may import, file registration rules, worker lease, staff-only visibility.
-- Runs after rfq_test.sql (users: a owner, b outsider, c engineer, d reviewer, e viewer, f client of project bbbb...1).
\set ON_ERROR_STOP on
\o /dev/null

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

-- 1. Who may import.
select pg_temp.act_as('00000000-0000-0000-0000-00000000000f');   -- client
select pg_temp.expect_error($$select public.create_flux_audit('bbbbbbbb-0000-0000-0000-000000000001', 'Smart Slate')$$, '%only owners and engineers%');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000d');   -- reviewer
select pg_temp.expect_error($$select public.create_flux_audit('bbbbbbbb-0000-0000-0000-000000000001', 'Smart Slate')$$, '%only owners and engineers%');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000c');   -- engineer
insert into ids select 'a1', public.create_flux_audit('bbbbbbbb-0000-0000-0000-000000000001', 'Smart Slate timecode board');
select pg_temp.expect_error($$select public.run_flux_audit(pg_temp.id('a1'))$$, '%upload the Flux export first%');

-- 2. Files: only in the audit's own folder.
select pg_temp.expect_error(format($$select public.add_flux_file(pg_temp.id('a1'), 'Rev A', null, 'x.zip', 'bbbbbbbb-0000-0000-0000-000000000001/other/x.zip', %L, 10)$$, repeat('a', 64)), '%this audit''s folder%');
insert into ids select 'f1', public.add_flux_file(pg_temp.id('a1'), 'Rev A', '2026-10-02', 'revA.zip',
  'bbbbbbbb-0000-0000-0000-000000000001/flux/' || pg_temp.id('a1') || '/rev-a/revA.zip', repeat('a', 64), 100);
insert into ids select 'f2', public.add_flux_file(pg_temp.id('a1'), 'Rev C', '2026-11-09', 'revC.zip',
  'bbbbbbbb-0000-0000-0000-000000000001/flux/' || pg_temp.id('a1') || '/rev-c/revC.zip', repeat('c', 64), 100);
select pg_temp.check((select pg_temp.id('f1') = public.add_flux_file(pg_temp.id('a1'), 'Rev A', '2026-10-02', 'revA-again.zip',
  'bbbbbbbb-0000-0000-0000-000000000001/flux/' || pg_temp.id('a1') || '/rev-a/revA.zip', repeat('a', 64), 100)), 'same file twice is one row');
select pg_temp.check((select public.remove_flux_file(pg_temp.id('f2')) like '%/rev-c/revC.zip'), 'remove returns the path to delete');

-- 3. Run: worker claims and completes; changes blocked while running.
select public.run_flux_audit(pg_temp.id('a1'));
select pg_temp.expect_error($$select public.run_flux_audit(pg_temp.id('a1'))$$, '%already running%');
select pg_temp.expect_error($$select public.claim_flux_audit('w1')$$, '%permission denied%');
select pg_temp.as_worker();
select pg_temp.check((select (public.claim_flux_audit('w1')).id = pg_temp.id('a1')), 'worker claims');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000c');
select pg_temp.expect_error(format($$select public.add_flux_file(pg_temp.id('a1'), 'Rev B', null, 'b.zip', 'bbbbbbbb-0000-0000-0000-000000000001/flux/%s/b.zip', %L, 1)$$, pg_temp.id('a1'), repeat('b', 64)), '%running%');
select pg_temp.as_worker();
select pg_temp.expect_error($$select public.complete_flux_audit(pg_temp.id('a1'), 'w2', 'p', 'p', 's', '{}', 'm')$$, '%not being run by w2%');
select pg_temp.expect_error($$select public.complete_flux_audit(pg_temp.id('a1'), 'w1', 'elsewhere/r.json', 'elsewhere/r.md', 's', '{}', 'm')$$, '%project''s folder%');
select public.complete_flux_audit(pg_temp.id('a1'), 'w1', 'bbbbbbbb-0000-0000-0000-000000000001/flux/r.json',
  'bbbbbbbb-0000-0000-0000-000000000001/flux/r.md', repeat('e', 64), '{"blockers": 1}', 'offline');
select pg_temp.check((select status = 'ready' and summary ->> 'blockers' = '1' from public.flux_audits where id = pg_temp.id('a1')), 'ready');

-- 4. Staff see it; clients do not.
select pg_temp.act_as('00000000-0000-0000-0000-00000000000e');   -- viewer (staff)
select pg_temp.check((select count(*) = 1 from public.flux_audits where id = pg_temp.id('a1')), 'staff read');
select pg_temp.check((select count(*) = 1 from public.flux_audit_files where audit_id = pg_temp.id('a1')), 'staff read files');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000f');   -- client
select pg_temp.check((select count(*) = 0 from public.flux_audits), 'clients do not see audits');
select pg_temp.act_as(null);
select pg_temp.check((select array_agg(event_type order by id) = array['flux.created', 'flux.audit_requested', 'flux.audit_completed']
                      from public.audit_events where entity_id = pg_temp.id('a1')), 'audited');

\echo 'All Flux audit tests passed.'
