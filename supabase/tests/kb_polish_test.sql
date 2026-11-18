-- Knowledge base polish: fetch records and change detection, OCR jobs, modules catalog.
-- Uses the lifecycle test project (Alice owns, Carol engineers, Cleo is a client; Zoe has no projects).
\set ON_ERROR_STOP on
\o /dev/null

insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000f1', 'editor@kbp.test');
insert into public.knowledge_editors (user_id, note) values ('00000000-0000-0000-0000-0000000000f1', 'kb polish test');

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

-- 1. Fetching: licence gate, first fetch indexes, same content only records the check, changed content re-indexes
--    and returns a verified source to draft.
select pg_temp.act_as('00000000-0000-0000-0000-0000000000f1');
insert into ids select 'ds', public.register_source(null, 'datasheet', 'Example LDO datasheet', 'Example Semi', 'https://example.test/ldo.pdf',
  'LDO-1', 'Rev. A', 'vendor_terms', null, null, 'official_url');
insert into ids select 'std', public.register_source(null, 'standard', 'Example standard', 'Example Body', 'https://example.test/std', 'EX-1', null,
  'reference_only', null, null, 'official_url');
select pg_temp.expect_error(format($$select public.apply_source_fetch(%L, 'https://example.test/std', %L, 'text/html', 10, '[]')$$, pg_temp.id('std'), repeat('a', 64)),
  'the licence of this source (reference_only) does not allow reading%');
select pg_temp.expect_error(format($$select public.apply_source_fetch(%L, 'https://example.test/ldo.pdf', %L, 'application/pdf', 10, '[]', 'x/y.pdf')$$, pg_temp.id('ds'), repeat('a', 64)),
  'the licence of this source (vendor_terms) does not allow keeping a copy%');
select pg_temp.check((public.apply_source_fetch(pg_temp.id('ds'), 'https://example.test/ldo.pdf', repeat('a', 64), 'application/pdf', 1000,
  '[{"ordinal": 1, "locator": "p. 1", "section_path": "Features", "text": "Dropout 250 mV at 300 mA."}]') ->> 'first')::boolean, 'first fetch');
select pg_temp.check((select acquisition_method = 'official_url' and indexed_chunks = 1 and fetched_at is not null and changed_at is null
                        from public.sources where id = pg_temp.id('ds')), 'indexed from the link');
select public.verify_source(pg_temp.id('ds'), 'Rev. A', 'checked against the PDF');
select pg_temp.check(not (public.apply_source_fetch(pg_temp.id('ds'), 'https://example.test/ldo.pdf', repeat('a', 64), 'application/pdf', 1000, '[]') ->> 'changed')::boolean, 'unchanged');
select pg_temp.check((select status = 'verified' and indexed_chunks = 1 from public.sources where id = pg_temp.id('ds')), 'an unchanged check keeps excerpts and verification');
select pg_temp.check((public.apply_source_fetch(pg_temp.id('ds'), 'https://example.test/ldo.pdf', repeat('b', 64), 'application/pdf', 1100,
  '[{"ordinal": 1, "locator": "p. 1", "section_path": "Features", "text": "Dropout 230 mV at 300 mA."}, {"ordinal": 2, "locator": "p. 2", "section_path": "Ratings", "text": "Vin max 6 V."}]') ->> 'changed')::boolean, 'changed');
select pg_temp.check((select status = 'draft' and indexed_chunks = 2 and changed_at is not null and verification_note like 'The document at the official link changed%'
                        from public.sources where id = pg_temp.id('ds')), 'a changed document is re-indexed and needs verifying again');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000c');   -- engineer: not a library editor
select pg_temp.expect_error(format($$select public.apply_source_fetch(%L, 'https://example.test/ldo.pdf', %L, 'application/pdf', 1, '[]')$$, pg_temp.id('ds'), repeat('c', 64)),
  'source not found or not permitted');

-- 2. OCR: requests by writers into the source's folder; the worker completes; vendor-terms files are not kept.
insert into ids select 'scan', public.register_source('ffffffff-0000-0000-0000-000000000001', 'datasheet', 'Scanned drawing', 'Example Co', null,
  'DRW-7', null, 'licensed_copy', 'bought copy', null, 'upload');
select pg_temp.expect_error(format($$select public.request_ocr(%L, 'elsewhere/x.pdf', %L, 100)$$, pg_temp.id('scan'), repeat('d', 64)), 'the scanned file must be stored%');
insert into ids select 'job', public.request_ocr(pg_temp.id('scan'), 'ffffffff-0000-0000-0000-000000000001/sources/ocr-x.pdf', repeat('d', 64), 100);
select pg_temp.expect_error(format($$select public.request_ocr(%L, 'ffffffff-0000-0000-0000-000000000001/sources/ocr-y.pdf', %L, 100)$$, pg_temp.id('scan'), repeat('d', 64)),
  'OCR is already queued%');
select pg_temp.expect_error($$select public.claim_ocr_job('w1')$$, '%permission denied%');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000e3');   -- client sees the job state
select pg_temp.check((select count(*) = 1 from public.ocr_jobs where id = pg_temp.id('job')), 'members read OCR jobs');
select pg_temp.act_as(null);
select pg_temp.check((select (public.claim_ocr_job('w1')).id = pg_temp.id('job')), 'claimed');
select pg_temp.expect_error(format($$select public.complete_ocr_job(%L, 'w2', '[]', 1, 90)$$, pg_temp.id('job')), 'OCR job % is not being run by w2');
select public.complete_ocr_job(pg_temp.id('job'), 'w1', '[{"ordinal": 1, "locator": "p. 1 (OCR)", "section_path": null, "text": "TOLERANCES ±0.1"}]', 1, 88.5);
select pg_temp.check((select text_origin = 'ocr' and indexed_chunks = 1 and storage_path = 'ffffffff-0000-0000-0000-000000000001/sources/ocr-x.pdf'
                        from public.sources where id = pg_temp.id('scan')), 'OCR text indexed; licensed copy kept');
select pg_temp.check((select status = 'done' and pages = 1 and mean_confidence = 88.5 from public.ocr_jobs where id = pg_temp.id('job')), 'job done');

-- 3. Modules: sourced certifications; directory users save; editors verify; edits clear verification.
select pg_temp.act_as('00000000-0000-0000-0000-00000000000c');
select pg_temp.expect_error($$select public.save_module(null, '{"kind": "radio_module", "name": "M", "manufacturer": "X", "mpn": "M-1", "normalized_mpn": "M-1",
  "source_note": "datasheet", "certifications": [{"regime": "FCC", "id": "2ABC-M1"}]}')$$, 'certification FCC 2ABC-M1: say where it was read%');
select pg_temp.expect_error($$select public.save_module(null, '{"kind": "radio_module", "name": "M", "manufacturer": "X", "mpn": "M-1", "normalized_mpn": "M-1"}')$$,
  '%modules_check%');
insert into ids select 'mod', public.save_module(null, '{"kind": "radio_module", "name": "Example BLE module", "manufacturer": "Example Radio", "mpn": "EXR-BLE-1",
  "normalized_mpn": "EXR-BLE-1", "radios": ["Bluetooth LE"], "interfaces": ["UART", "SPI"], "supply": {"v_min": 1.8, "v_max": 3.6},
  "dimensions_mm": {"x": 10, "y": 15, "z": 2}, "source_url": "https://example.test/exr", "lifecycle": "active",
  "certifications": [{"regime": "FCC", "id": "2EXR-BLE1", "source_url": "https://example.test/grant"}, {"regime": "CE RED", "id": "DoC 2026-01", "note": "manufacturer DoC PDF"}]}');
select pg_temp.expect_error(format($$select public.verify_module(%L)$$, pg_temp.id('mod')), 'only library editors verify modules');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000f1');
select public.verify_module(pg_temp.id('mod'));
select pg_temp.act_as('00000000-0000-0000-0000-00000000000c');
select public.save_module(pg_temp.id('mod'), '{"kind": "radio_module", "name": "Example BLE module", "manufacturer": "Example Radio", "mpn": "EXR-BLE-1",
  "normalized_mpn": "EXR-BLE-1", "source_url": "https://example.test/exr", "lifecycle": "nrnd", "certifications": []}');
select pg_temp.check((select status = 'draft' and lifecycle = 'nrnd' from public.modules where id = pg_temp.id('mod')), 'an edit clears verification');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000e2');
select pg_temp.check((select count(*) >= 1 from public.modules), 'anyone signed in reads the catalog');
select pg_temp.expect_error($$select public.save_module(null, '{}')$$, 'only project owners, engineers and library editors%');
select pg_temp.act_as(null);
select pg_temp.check((select count(*) = 3 from public.audit_events where event_type like 'module.%' and entity_id = pg_temp.id('mod')), 'modules audited (saved, verified, saved)');

\o
select 'All knowledge base polish tests passed.' as result;
