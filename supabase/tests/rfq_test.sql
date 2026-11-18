-- RFQ tests: directory rules (verify contact, verified suppliers), RFQ completeness, attachments, disclosure approval
-- bound to the packet, access windows, supplier isolation, quotes, award.
-- Runs after concept_test.sql (users: a owner, b outsider, c engineer, d reviewer + library editor, e viewer,
-- f client of project bbbb...1).
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
-- schema_test.sql grants every table to authenticated (as Supabase's defaults do); restore this migration's column grants.
revoke all on public.manufacturers, public.manufacturer_contacts from authenticated;
grant select on public.manufacturers, public.manufacturer_contacts to authenticated;
grant insert (display_name, legal_name, country, website, categories, processes, certifications, nda_method, file_formats,
              lead_time_note, notes),
      update (display_name, legal_name, country, website, categories, processes, certifications, nda_method, file_formats,
              lead_time_note, notes) on public.manufacturers to authenticated;
grant insert (manufacturer_id, name, role, email, phone), update (name, role, email, phone), delete
  on public.manufacturer_contacts to authenticated;
create temp table ids (name text primary key, id uuid);
grant all on ids to authenticated, service_role;
create function pg_temp.id(p_name text) returns uuid language sql as $$ select id from ids where name = p_name $$;

-- Suppliers: s1 confirmed the contact's address; s2 signed up with it but never confirmed; s3 another supplier.
insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-000000000051', 'quotes@fab.example', now()),
  ('00000000-0000-0000-0000-000000000052', 'QUOTES@fab.example', null),
  ('00000000-0000-0000-0000-000000000053', 'sales@other.example', now());
-- A committed design file and a scratch one.
insert into public.artifacts (id, project_id, kind, name) values
  ('cccccccc-0000-0000-0000-0000000000f1', 'bbbbbbbb-0000-0000-0000-000000000001', 'fab_package', 'timecode/fab-package');
insert into public.artifact_versions (id, artifact_id, project_id, version, status, storage_path, sha256) values
  ('cccccccc-0000-0000-0000-0000000000a1', 'cccccccc-0000-0000-0000-0000000000f1', 'bbbbbbbb-0000-0000-0000-000000000001', 1, 'committed',
   'bbbbbbbb-0000-0000-0000-000000000001/fab.zip', repeat('a', 64)),
  ('cccccccc-0000-0000-0000-0000000000a2', 'cccccccc-0000-0000-0000-0000000000f1', 'bbbbbbbb-0000-0000-0000-000000000001', 2, 'scratch',
   'bbbbbbbb-0000-0000-0000-000000000001/fab2.zip', repeat('b', 64));

-- 1. Directory: owners/engineers/editors use it; clients and suppliers do not see it.
select pg_temp.check((select count(*) = 6 from public.manufacturers where status = 'candidate'), 'discovery list seeded as candidates');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000f');   -- client
select pg_temp.check((select count(*) = 0 from public.manufacturers), 'clients do not see the directory');
select pg_temp.expect_error($$insert into public.manufacturers (display_name) values ('Sneaky')$$, '%row-level security%');
select pg_temp.act_as('00000000-0000-0000-0000-000000000051');   -- supplier
select pg_temp.check((select count(*) = 0 from public.manufacturers), 'suppliers do not see the directory');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000c');   -- engineer
insert into public.manufacturers (display_name, website, categories) values ('Fab Example', 'https://fab.example', '{bare_pcb,pcba}');
insert into ids select 'm1', id from public.manufacturers where display_name = 'Fab Example';
select pg_temp.expect_error($$update public.manufacturers set status = 'approved' where id = pg_temp.id('m1')$$, '%permission denied%');
insert into public.manufacturer_contacts (manufacturer_id, name, role, email) values (pg_temp.id('m1'), 'Quotes desk', 'sales', 'quotes@fab.example');
insert into ids select 'c1', id from public.manufacturer_contacts where manufacturer_id = pg_temp.id('m1');
select pg_temp.expect_error($$update public.manufacturer_contacts set email_status = 'verified' where id = pg_temp.id('c1')$$, '%permission denied%');
select pg_temp.expect_error($$select public.verify_manufacturer(pg_temp.id('m1'), 'checked')$$, '%legal name, country and at least one process%');
update public.manufacturers set legal_name = 'Fab Example Ltd', country = 'GB', processes = '{"2-6 layer FR-4", "SMT assembly"}' where id = pg_temp.id('m1');
select pg_temp.expect_error($$select public.verify_manufacturer(pg_temp.id('m1'), ' ')$$, '%how the identity%');
select public.verify_manufacturer(pg_temp.id('m1'), 'Company register entry and capability page, 18 Nov 2026');
select pg_temp.expect_error($$select public.set_manufacturer_status(pg_temp.id('m1'), 'approved')$$, '%only library editors%');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000d');   -- library editor
select public.set_manufacturer_status(pg_temp.id('m1'), 'approved', 'first PCB supplier');
select pg_temp.check((select status = 'approved' from public.manufacturers where id = pg_temp.id('m1')), 'approved vendor');
-- Changing the legal identity sends it back to candidate.
update public.manufacturers set legal_name = 'Fab Example Holdings' where id = pg_temp.id('m1');
select pg_temp.check((select status = 'candidate' and verified_at is null from public.manufacturers where id = pg_temp.id('m1')), 'identity change resets');
select public.verify_manufacturer(pg_temp.id('m1'), 'Re-checked the register');

-- 2. RFQ: who may prepare one; completeness.
select pg_temp.act_as('00000000-0000-0000-0000-00000000000f');   -- client
select pg_temp.expect_error($$select public.create_rfq('bbbbbbbb-0000-0000-0000-000000000001', 'Boards', 'pcba')$$, '%only owners and engineers%');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000c');   -- engineer
insert into ids select 'q1', public.create_rfq('bbbbbbbb-0000-0000-0000-000000000001', 'Timecode board, 5 assembled', 'pcba');
select pg_temp.check((select rfq_no = 1 and status = 'draft' from public.rfqs where id = pg_temp.id('q1')), 'RFQ-001 drafted');
select pg_temp.expect_error($$select public.request_rfq_packet(pg_temp.id('q1'))$$, '%incomplete: project code, buyer company, classification%');
select public.update_rfq(pg_temp.id('q1'), null, '{"project_code": "SLATE", "buyer": {"company": "VX Design"}, "classification": "prototype PCBA",
  "quantities": {"prototype": 5, "production": 500}, "tooling_ownership": "buyer", "shipping_terms": "DAP",
  "quote_breakdown": ["unit price", "NRE"], "requirement_refs": ["REQ-1"]}', 'drawings', current_date + 14);
select pg_temp.check((select public.rfq_missing(pg_temp.id('q1')) = array['at least one design file']), 'only the files are missing');
select pg_temp.expect_error($$select public.set_rfq_attachments(pg_temp.id('q1'), array['cccccccc-0000-0000-0000-0000000000a2'::uuid])$$, '%committed%');
select public.set_rfq_attachments(pg_temp.id('q1'), array['cccccccc-0000-0000-0000-0000000000a1'::uuid]);
select pg_temp.check((select public.rfq_missing(pg_temp.id('q1')) = array['drawing revision']), 'drawing revision needed with files');
select public.update_rfq(pg_temp.id('q1'), null, (select manifest || '{"drawing_revision": "A"}' from public.rfqs where id = pg_temp.id('q1')),
                         'drawings', current_date + 14);
select pg_temp.check((select cardinality(public.rfq_missing(pg_temp.id('q1'))) = 0), 'complete');

-- 3. Recipients: verified supplier and verified contact only ("verify contact").
insert into ids select 'jlc', id from public.manufacturers where display_name = 'JLCPCB';
insert into public.manufacturer_contacts (manufacturer_id, name, email) values (pg_temp.id('jlc'), 'Sales', 'sales@jlc.example');
select pg_temp.expect_error($$select public.add_rfq_recipient(pg_temp.id('q1'), (select id from public.manufacturer_contacts where email = 'sales@jlc.example'))$$,
                            '%candidate supplier%');
select pg_temp.expect_error($$select public.add_rfq_recipient(pg_temp.id('q1'), pg_temp.id('c1'))$$, '%verify contact%');
select pg_temp.expect_error($$select public.verify_contact(pg_temp.id('c1'), '')$$, '%never guessed%');
select public.verify_contact(pg_temp.id('c1'), 'Reply received from the address, 18 Nov 2026');
insert into ids select 'r1', public.add_rfq_recipient(pg_temp.id('q1'), pg_temp.id('c1'));
select pg_temp.check((select nda_status = 'pending' and status = 'pending' and email = 'quotes@fab.example'
                      from public.rfq_recipients where id = pg_temp.id('r1')), 'recipient added, NDA pending');

-- 4. Packet: built by a worker; approval is the owner's, bound to the packet.
select public.request_rfq_packet(pg_temp.id('q1'));
select pg_temp.expect_error($$select public.claim_rfq_packet('w1')$$, '%permission denied%');
select pg_temp.as_worker();
select pg_temp.check((select (public.claim_rfq_packet('w1')).id = pg_temp.id('q1')), 'worker claims the packet');
select pg_temp.expect_error($$select public.complete_rfq_packet(pg_temp.id('q1'), 'w2', 'x', repeat('c', 64), '[]')$$, '%not being packaged by w2%');
select pg_temp.expect_error($$select public.complete_rfq_packet(pg_temp.id('q1'), 'w1', 'elsewhere/rfq/p.zip', repeat('c', 64), '[]')$$, '%project''s folder%');
select public.complete_rfq_packet(pg_temp.id('q1'), 'w1', 'bbbbbbbb-0000-0000-0000-000000000001/rfq/q1/packet.zip', repeat('c', 64),
  '[{"name": "files/fab-package.zip", "sha256": "aaaa", "size": 10}]');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000c');   -- engineer
select pg_temp.expect_error($$select public.approve_rfq_disclosure(pg_temp.id('q1'))$$, '%not permitted%');
select pg_temp.expect_error($$select public.send_rfq(pg_temp.id('q1'))$$, '%not permitted%');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');   -- owner
select pg_temp.expect_error($$select public.send_rfq(pg_temp.id('q1'))$$, '%approve this exact packet%');
select public.approve_rfq_disclosure(pg_temp.id('q1'), 'OK to share drawings without NDA');
select pg_temp.check((select status = 'approved' and approved_packet_sha256 = repeat('c', 64) from public.rfqs where id = pg_temp.id('q1')), 'approved');
-- Any change to the disclosure drops the approval and the packet.
select public.update_rfq(pg_temp.id('q1'), null, (select manifest from public.rfqs where id = pg_temp.id('q1')), 'full_design', current_date + 14);
select pg_temp.check((select status = 'draft' and approved_packet_sha256 is null and packet_path is null from public.rfqs where id = pg_temp.id('q1')),
                     'change drops the approval');
select pg_temp.check((select count(*) = 1 from public.audit_events where event_type = 'rfq.approval_invalidated' and entity_id = pg_temp.id('q1')),
                     'invalidation audited');
select public.request_rfq_packet(pg_temp.id('q1'));
select pg_temp.as_worker();
select (public.claim_rfq_packet('w1')).id;
select public.complete_rfq_packet(pg_temp.id('q1'), 'w1', 'bbbbbbbb-0000-0000-0000-000000000001/rfq/q1/packet2.zip', repeat('d', 64), '[]');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
select pg_temp.expect_error($$select public.approve_rfq_disclosure(pg_temp.id('q1'))$$, '%NDA not signed%');
select pg_temp.expect_error($$select public.set_rfq_nda(pg_temp.id('r1'), 'signed')$$, '%which NDA%');
select public.set_rfq_nda(pg_temp.id('r1'), 'signed', 'Mutual NDA v2 signed 18 Nov 2026');
select public.approve_rfq_disclosure(pg_temp.id('q1'), 'Full design under NDA');
select pg_temp.check((select payload -> 'recipients' -> 0 ->> 'email' = 'quotes@fab.example' and payload ->> 'packet_sha256' = repeat('d', 64)
                      from public.audit_events where event_type = 'rfq.disclosure_approved' and entity_id = pg_temp.id('q1')
                      order by id desc limit 1), 'approval audited with packet hash and recipients');

-- 5. Before sending, the supplier sees nothing.
select pg_temp.act_as('00000000-0000-0000-0000-000000000051');
select pg_temp.check((select count(*) = 0 from public.supplier_rfqs()), 'nothing before release');
select pg_temp.check((select count(*) = 0 from public.rfqs), 'suppliers never read RFQs directly');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
select pg_temp.expect_error($$select public.send_rfq(pg_temp.id('q1'), 365)$$, '%1 to 90 days%');
select pg_temp.check((select public.send_rfq(pg_temp.id('q1'), 14) = 1), 'released to one supplier');
select pg_temp.expect_error($$select public.update_rfq(pg_temp.id('q1'), 'x', '{}', 'drawings', current_date + 3)$$, '%no longer be changed%');

-- 6. Supplier portal: only the confirmed owner of the address; isolation.
select pg_temp.act_as('00000000-0000-0000-0000-000000000052');   -- same address, unconfirmed
select pg_temp.check((select count(*) = 0 from public.supplier_rfqs()), 'unconfirmed address sees nothing');
select pg_temp.expect_error($$select public.supplier_open_rfq(pg_temp.id('r1'))$$, '%invitation not found%');
select pg_temp.act_as('00000000-0000-0000-0000-000000000053');   -- another supplier
select pg_temp.check((select count(*) = 0 from public.supplier_rfqs()), 'other suppliers see nothing');
select pg_temp.expect_error($$select public.submit_quote(pg_temp.id('r1'), '{"currency": "USD", "lines": [{"quantity": 5, "unit_price": 1}]}')$$, '%invitation not found%');
select pg_temp.act_as('00000000-0000-0000-0000-000000000051');
select pg_temp.check((select rfq_ref = 'SLATE-RFQ-001' and window_open and not (manifest ? 'requirement_refs') and manufacturer = 'Fab Example'
                      from public.supplier_rfqs()), 'supplier sees its invitation, with the project code only');
select pg_temp.check((select public.supplier_open_rfq(pg_temp.id('r1')) = 'bbbbbbbb-0000-0000-0000-000000000001/rfq/q1/packet2.zip'), 'packet path');
select pg_temp.check((select public.rfq_packet_readable('bbbbbbbb-0000-0000-0000-000000000001/rfq/q1/packet2.zip')), 'packet readable in window');
select pg_temp.check((select not public.rfq_packet_readable('bbbbbbbb-0000-0000-0000-000000000001/rfq/q1/packet.zip')), 'old packet not readable');
select pg_temp.check((select not public.rfq_packet_readable('bbbbbbbb-0000-0000-0000-000000000001/fab.zip')), 'project files not readable');
select pg_temp.expect_error($$select public.submit_quote(pg_temp.id('r1'), '{"currency": "USD", "lines": [{"quantity": 0, "unit_price": 1}]}')$$, '%quantity above zero%');
insert into ids select 'quote1', public.submit_quote(pg_temp.id('r1'), '{"currency": "usd", "lines": [{"quantity": 500, "unit_price": 9.5}, {"quantity": 5, "unit_price": 42}],
  "tooling_cost": 120, "lead_time_days": 12, "notes": "Stencil included"}');
insert into ids select 'quote2', public.submit_quote(pg_temp.id('r1'), '{"currency": "USD", "lines": [{"quantity": 5, "unit_price": 40}], "lead_time_days": 10}');
select pg_temp.check((select jsonb_array_length(my_quotes) = 2 and (my_quotes -> 0 ->> 'revision')::int = 2 and status = 'quoted' from public.supplier_rfqs()), 'two revisions');
select pg_temp.check((select (lines -> 0 ->> 'quantity')::int = 5 and currency = 'USD' from public.rfq_quotes where id = pg_temp.id('quote1')) is null,
                     'suppliers cannot read the quotes table');

-- 7. Owner reads quotes; revoking closes the window; award records a decision.
select pg_temp.act_as('00000000-0000-0000-0000-00000000000f');   -- client
select pg_temp.check((select count(*) = 0 from public.rfq_quotes), 'clients do not see quotes');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000d');   -- reviewer (staff)
select pg_temp.check((select count(*) = 2 from public.rfq_quotes where rfq_id = pg_temp.id('q1')), 'staff see quotes');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
select pg_temp.check((select (lines -> 0 ->> 'quantity')::int = 5 and currency = 'USD' from public.rfq_quotes where id = pg_temp.id('quote1')),
                     'lines sorted by quantity, currency upper-cased');
select public.revoke_rfq_access(pg_temp.id('r1'), 'test');
select pg_temp.act_as('00000000-0000-0000-0000-000000000051');
select pg_temp.check((select not window_open from public.supplier_rfqs()), 'window closed after revoke');
select pg_temp.expect_error($$select public.supplier_open_rfq(pg_temp.id('r1'))$$, '%window for this RFQ is closed%');
select pg_temp.check((select not public.rfq_packet_readable('bbbbbbbb-0000-0000-0000-000000000001/rfq/q1/packet2.zip')), 'packet unreadable after revoke');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
select public.close_rfq(pg_temp.id('q1'), pg_temp.id('quote2'), 'Faster lead time');
select pg_temp.check((select r.status = 'closed' and d.decision_class = 'manufacturing' and d.title like 'Supplier selected for RFQ-001: Fab Example'
                      from public.rfqs r join public.decisions d on d.id = r.award_decision_id where r.id = pg_temp.id('q1')), 'award recorded as a decision');
select pg_temp.act_as(null);
select pg_temp.expect_error($$update public.rfq_quotes set notes = 'x' where id = pg_temp.id('quote1')$$, '%immutable%');
select pg_temp.check((select array_agg(event_type order by id) @> array['rfq.created', 'rfq.packaged', 'rfq.disclosure_approved', 'rfq.sent',
                      'rfq.packet_opened', 'rfq.quote_received', 'rfq.access_revoked', 'rfq.awarded']
                      from public.audit_events where project_id = 'bbbbbbbb-0000-0000-0000-000000000001'), 'full audit trail');

\echo 'All RFQ tests passed.'
