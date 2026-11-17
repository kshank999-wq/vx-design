-- Knowledge base tests: licensing controls, who may write, project scoping, search results and citations,
-- standards registry review and per-project applicability.
-- Runs after workspace_test.sql (reuses its users: a owner, b outsider, c engineer, d reviewer, e viewer, f client).
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

-- Project 1 (bbbb...1): a owner, c engineer, d reviewer, e viewer, f client. Project 2: b owner, c engineer.
insert into public.projects (id, name, created_by) values ('bbbbbbbb-0000-0000-0000-000000000002', 'Other client', '00000000-0000-0000-0000-00000000000b');
insert into public.project_members (project_id, user_id, role) values
  ('bbbbbbbb-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000b', 'owner'),
  ('bbbbbbbb-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000c', 'engineer')
on conflict do nothing;
insert into public.knowledge_editors (user_id, note) values ('00000000-0000-0000-0000-00000000000d', 'test curator');

-- 1. The seeded standards registry: reference-only, no editions until reviewed.
select pg_temp.act_as('00000000-0000-0000-0000-00000000000e');
select pg_temp.check((select count(*) >= 40 from public.standards), 'standards seeded from the spec');
select pg_temp.check((select bool_and(edition is null and review_status = 'unreviewed') from public.standards), 'no edition claimed before review');
select pg_temp.check((select license = 'reference_only' from public.standards where identifier = 'IPC-2221'), 'IPC is reference only');
select pg_temp.check((select license = 'public_domain' from public.standards where identifier = 'FCC 47 CFR Part 15'), 'US regulation is public domain');

-- 2. Who may write. Shared library: knowledge editors only. Project sources: owners and engineers.
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');   -- project owner, not an editor
select pg_temp.expect_error($$select public.register_source(null, 'datasheet', 'X', 'Y', 'https://example.test/x.pdf')$$,
  '%only knowledge editors%');
select pg_temp.expect_error($$insert into public.sources (kind, title, publisher, acquisition_method) values ('other', 'x', 'y', 'manual_entry')$$,
  '%row-level security%');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000d');   -- editor
insert into ids select 'open', public.register_source(null, 'application_note', 'Designing guard rings for timecode oscillators',
  'VX Design', 'https://example.test/notes/guard-rings', 'VXN-001', 'A', 'open_license', 'CC BY 4.0 (our own note)',
  'Layout guidance for crystal oscillators.', 'official_url');
insert into ids select 'ipc', public.register_source(null, 'standard', 'Generic Standard on Printed Board Design', 'IPC',
  'https://www.ipc.org', 'IPC-2221', null, 'reference_only', 'Copyrighted; buy from IPC.', null, 'official_url');
select pg_temp.expect_error($$select public.register_source(null, 'standard', 'IEC 62368-1 copy', 'IEC', 'https://webstore.iec.ch', 'IEC 62368-1', null, 'licensed_copy')$$,
  '%licensed copy belongs to one project%');
select pg_temp.expect_error($$select public.register_source(null, 'datasheet', 'No link', 'TI', null)$$, '%official https URL%');

-- 3. Licensing controls on content.
select public.set_source_content(pg_temp.id('open'), $j$[
  {"ordinal": 1, "locator": "§2 Guard rings, p. 3", "section_path": "Oscillator layout > Guard rings",
   "text": "Surround the crystal and its load capacitors with a grounded guard ring and keep switching traces at least 2 mm away."},
  {"ordinal": 2, "locator": "§3 Battery charging, p. 5", "section_path": "Power",
   "text": "Charge the lithium cell only between 0 and 45 degrees Celsius; stop charging when the thermistor reads outside that window."}
]$j$::jsonb, null);
select pg_temp.check((select indexed_chunks = 2 from public.sources where id = pg_temp.id('open')), 'excerpts indexed for an open licence');
select pg_temp.expect_error($$select public.set_source_content(pg_temp.id('ipc'),
  '[{"ordinal": 1, "locator": "§6", "text": "copied clause"}]'::jsonb, null)$$, '%does not allow indexing excerpts%');
select pg_temp.act_as(null);
select pg_temp.expect_error($$update public.sources set storage_path = 'x/y.pdf' where id = pg_temp.id('ipc')$$, '%check constraint%');
select pg_temp.expect_error($$insert into public.sources (kind, title, publisher, acquisition_method, license, storage_path)
                              values ('datasheet', 'TPS', 'TI', 'upload', 'vendor_terms', 'k/tps.pdf')$$, '%check constraint%');

-- 4. Search: citations with URL, edition, licence flag; reference-only sources are found by metadata only.
select pg_temp.act_as('00000000-0000-0000-0000-00000000000e');   -- any signed-in user can search the shared library
select pg_temp.check((select count(*) = 1 from public.search_knowledge('guard ring crystal') r
                      where r.result_kind = 'excerpt' and r.locator = '§2 Guard rings, p. 3' and r.official_url = 'https://example.test/notes/guard-rings'
                        and r.edition = 'A' and r.license = 'open_license' and r.excerpt_allowed and r.snippet like '%«guard»%'),
  'excerpt hit carries its citation, official URL, edition and licence');
select pg_temp.check((select r.result_kind = 'excerpt' from public.search_knowledge('what temperature can the lithium battery charge at') r limit 1),
  'loosely phrased question finds the passage');
select pg_temp.check((select bool_and(not r.excerpt_allowed and r.snippet is null) from public.search_knowledge('IPC-2221') r
                      where r.result_kind = 'source'), 'reference-only source returns metadata, no text');
select pg_temp.check((select r.result_kind = 'standard' and r.identifier = 'IPC-2152' and r.status = 'unreviewed' and r.edition is null
                      from public.search_knowledge('ipc 2152 trace width') r limit 1), 'identifier match ranks the standard first');
select pg_temp.check((select count(*) >= 1 from public.search_knowledge('IEC 62368-1') r where r.identifier = 'IEC 62368-1'), 'dashed part numbers match');
select pg_temp.check((select count(*) = 0 from public.search_knowledge('   ')), 'empty query returns nothing');

-- 5. Project sources: licensed copies stay in their project, and in that project's searches only.
select pg_temp.act_as('00000000-0000-0000-0000-00000000000b');   -- owner of project 2
insert into ids select 'nda', public.register_source('bbbbbbbb-0000-0000-0000-000000000002', 'datasheet', 'Customer sensor module, confidential',
  'OtherCo', null, 'OC-SENSE-7', 'Rev 2', 'licensed_copy', 'Under NDA with OtherCo', null, 'upload');
select public.set_source_content(pg_temp.id('nda'),
  '[{"ordinal": 1, "locator": "Table 4, p. 9", "text": "The guard ring must be tied to the sensor shield at a single point."}]'::jsonb,
  'bbbbbbbb-0000-0000-0000-000000000002/sources/oc-sense-7.pdf', 'abc123', 'application/pdf', 1000);
select pg_temp.expect_error($$select public.set_source_content(pg_temp.id('nda'), '[]'::jsonb, 'bbbbbbbb-0000-0000-0000-000000000001/sources/x.pdf')$$,
  '%that project''s folder%');
select pg_temp.check((select count(*) = 1 from public.search_knowledge('guard ring shield', 'bbbbbbbb-0000-0000-0000-000000000002') r
                      where r.source_id = pg_temp.id('nda') and r.locator = 'Table 4, p. 9'), 'project member finds the licensed copy in its project');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000c');   -- engineer on both projects
select pg_temp.check((select count(*) = 0 from public.search_knowledge('guard ring shield', 'bbbbbbbb-0000-0000-0000-000000000001') r
                      where r.source_id = pg_temp.id('nda')), 'another project''s licensed copy never appears, even for a member of both');
select pg_temp.check((select count(*) = 0 from public.search_knowledge('guard ring shield') r where r.project_id is not null),
  'without a project, only the shared library is searched');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');   -- not in project 2
select pg_temp.check((select count(*) = 0 from public.sources where id = pg_temp.id('nda')), 'outsiders cannot read the licensed copy');
select pg_temp.check((select count(*) = 0 from public.source_chunks where source_id = pg_temp.id('nda')), 'or its excerpts');
select pg_temp.check((select count(*) = 0 from public.search_knowledge('guard ring shield', 'bbbbbbbb-0000-0000-0000-000000000002') r
                      where r.source_id = pg_temp.id('nda')), 'naming a project you are not in finds nothing private');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000f');   -- client of project 1
select pg_temp.expect_error($$select public.register_source('bbbbbbbb-0000-0000-0000-000000000001', 'datasheet', 'X', 'Y', 'https://x.test/a')$$,
  '%only owners and engineers%');

-- 6. Downgrading a licence removes what it no longer allows, and hands back the file to delete.
select pg_temp.act_as('00000000-0000-0000-0000-00000000000b');
select pg_temp.expect_error($$select public.set_source_license(pg_temp.id('nda'), 'reference_only', '  ')$$, '%say why%');
select pg_temp.check((select public.set_source_license(pg_temp.id('nda'), 'reference_only', 'NDA ended; copy returned')
                      = 'bbbbbbbb-0000-0000-0000-000000000002/sources/oc-sense-7.pdf'), 'stored file returned for deletion');
select pg_temp.check((select indexed_chunks = 0 and storage_path is null from public.sources where id = pg_temp.id('nda')), 'excerpts and file dropped');
select pg_temp.check((select count(*) = 0 from public.source_chunks where source_id = pg_temp.id('nda')), 'no excerpts remain');

-- 7. Verification and withdrawal.
select pg_temp.act_as('00000000-0000-0000-0000-00000000000c');   -- engineer, not an editor
select pg_temp.expect_error($$select public.verify_source(pg_temp.id('open'), 'A', 'checked')$$, '%only knowledge editors%');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000d');
select pg_temp.expect_error($$select public.verify_source(pg_temp.id('open'), 'A', '')$$, '%how it was verified%');
select public.verify_source(pg_temp.id('open'), 'B', 'Checked against the publisher page, 17 Nov 2026');
select pg_temp.check((select status = 'verified' and edition = 'B' and last_verified_at is not null from public.sources where id = pg_temp.id('open')),
  'verified with the confirmed edition');
select public.withdraw_source(pg_temp.id('ipc'), null, 'duplicate of the standards registry entry');
select pg_temp.check((select count(*) = 0 from public.search_knowledge('Generic Standard on Printed Board Design') r where r.source_id = pg_temp.id('ipc')
                      and r.result_kind = 'source'), 'withdrawn sources are not returned');

-- 8. Standards review (editors) and per-project applicability (engineers propose, owners/reviewers confirm).
insert into ids select 'ipc2152', id from public.standards where identifier = 'IPC-2152';
select pg_temp.expect_error($$select public.review_standard(pg_temp.id('ipc2152'), '', null, 'reviewed')$$, '%edition confirmed%');
select public.review_standard(pg_temp.id('ipc2152'), 'Test edition', 'Confirmed on the publisher site (test)', 'reviewed');
select pg_temp.check((select review_status = 'reviewed' and edition = 'Test edition' from public.standards where id = pg_temp.id('ipc2152')), 'reviewed');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000c');
select pg_temp.expect_error($$select public.review_standard(pg_temp.id('ipc2152'), 'x', null, 'reviewed')$$, '%only knowledge editors%');
select pg_temp.expect_error($$select public.set_project_standard('bbbbbbbb-0000-0000-0000-000000000001', pg_temp.id('ipc2152'), 'applies', ' ')$$,
  '%give the reason%');
insert into ids select 'ps', public.set_project_standard('bbbbbbbb-0000-0000-0000-000000000001', pg_temp.id('ipc2152'), 'applies',
  'The board carries 2 A on the battery path.');
select pg_temp.expect_error($$select public.confirm_project_standard(pg_temp.id('ps'))$$, '%only owners and reviewers%');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000f');   -- client reads, cannot propose
select pg_temp.check((select count(*) = 1 from public.project_standards where id = pg_temp.id('ps')), 'client sees which standards apply');
select pg_temp.expect_error($$select public.set_project_standard('bbbbbbbb-0000-0000-0000-000000000001', pg_temp.id('ipc2152'), 'does_not_apply', 'no')$$,
  '%only owners and engineers%');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000d');   -- reviewer confirms
select public.confirm_project_standard(pg_temp.id('ps'), 'Agreed');
select pg_temp.check((select status = 'confirmed' from public.project_standards where id = pg_temp.id('ps')), 'confirmed');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000c');   -- changing it reopens the question
select public.set_project_standard('bbbbbbbb-0000-0000-0000-000000000001', pg_temp.id('ipc2152'), 'may_apply', 'Current may stay below 1 A.');
select pg_temp.check((select status = 'proposed' and confirmed_by is null from public.project_standards where id = pg_temp.id('ps')),
  'a changed applicability needs confirming again');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000b');
select pg_temp.check((select count(*) = 0 from public.project_standards where id = pg_temp.id('ps')), 'other projects do not see it');

-- 9. Audit trail.
select pg_temp.act_as(null);
select pg_temp.check((select count(*) = 1 from public.audit_events where event_type = 'source.license_changed'), 'licence change audited');
select pg_temp.check((select count(*) = 2 from public.audit_events where event_type like 'standard.applicability%'
                      and project_id = 'bbbbbbbb-0000-0000-0000-000000000001' and payload ? 'applicability'), 'applicability proposals audited');

\echo 'All knowledge base tests passed.'
