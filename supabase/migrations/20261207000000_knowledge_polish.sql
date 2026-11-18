-- Knowledge base polish (M-KB): fetching a source from its official link with change detection, OCR of scanned
-- PDFs by the worker, and a modules catalog (radio modules, SoMs, dev boards) with sourced certifications.
--
-- Fetching follows the licence rules already in place: only sources whose licence allows excerpts are read, and a
-- copy is kept only when the licence allows that too. Re-checking compares the content's sha256: a changed document
-- is re-indexed and loses its verification, so nobody relies on an excerpt from a revision that no longer exists.
-- OCR text is marked as such on the source and in every excerpt's locator.

alter table public.sources
  add column fetched_url      text check (fetched_url is null or fetched_url ~ '^https://'),
  add column fetched_at       timestamptz,
  add column fetch_checked_at timestamptz,
  add column changed_at       timestamptz,
  add column text_origin      text not null default 'text' check (text_origin in ('text', 'ocr'));

-- Records a fetch of the official link. Unchanged content (same sha256) only records the check; new or changed
-- content replaces the excerpts and, if the source had been verified, returns it to draft.
create function public.apply_source_fetch(p_source_id uuid, p_url text, p_sha256 text, p_mime_type text, p_size_bytes bigint,
                                          p_chunks jsonb, p_storage_path text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v public.sources;
  v_changed boolean;
  v_n integer;
begin
  select * into v from public.sources where id = p_source_id for update;
  if v.id is null or not public.kb_can_write(v.project_id) then
    raise exception 'source not found or not permitted' using errcode = '42501';
  end if;
  if not public.kb_excerpts_allowed(v.license) then
    raise exception 'the licence of this source (%) does not allow reading the document; keep metadata and the official link', v.license;
  end if;
  if p_url !~ '^https://' or p_sha256 !~ '^[0-9a-f]{64}$' then raise exception 'a fetch needs the https address and the content''s sha256'; end if;
  if p_storage_path is not null and not public.kb_file_allowed(v.license) then
    raise exception 'the licence of this source (%) does not allow keeping a copy of the file', v.license;
  end if;
  if p_storage_path is not null and v.project_id is not null and split_part(p_storage_path, '/', 1) <> v.project_id::text then
    raise exception 'a project source''s file must be stored in that project''s folder';
  end if;
  v_changed := v.sha256 is distinct from lower(p_sha256);
  if not v_changed then
    update public.sources set fetch_checked_at = now(), fetched_url = p_url where id = v.id;
    perform public.worker_audit(v.project_id, 'source.fetch_checked', 'source', v.id, jsonb_build_object('url', p_url, 'changed', false));
    return jsonb_build_object('changed', false, 'excerpts', v.indexed_chunks, 'first', false);
  end if;
  if jsonb_array_length(coalesce(p_chunks, '[]'::jsonb)) > 5000 then raise exception 'too many excerpts (max 5000)'; end if;
  delete from public.source_chunks where source_id = v.id;
  insert into public.source_chunks (source_id, project_id, ordinal, locator, section_path, text)
  select v.id, v.project_id, (c ->> 'ordinal')::integer, c ->> 'locator', c ->> 'section_path', c ->> 'text'
    from jsonb_array_elements(coalesce(p_chunks, '[]'::jsonb)) c;
  get diagnostics v_n = row_count;
  update public.sources set indexed_chunks = v_n, sha256 = lower(p_sha256), mime_type = p_mime_type, size_bytes = p_size_bytes,
         storage_path = coalesce(p_storage_path, storage_path), acquisition_method = 'official_url', text_origin = 'text',
         fetched_url = p_url, fetched_at = now(), fetch_checked_at = now(),
         changed_at = case when v.sha256 is not null then now() else changed_at end,
         status = case when v.sha256 is not null and v.status = 'verified' then 'draft'::public.source_status else status end,
         verification_note = case when v.sha256 is not null and v.status = 'verified'
                                   then format('The document at the official link changed on %s; check the edition and verify again.', current_date)
                                   else verification_note end
   where id = v.id;
  perform public.worker_audit(v.project_id, 'source.fetched', 'source', v.id,
                              jsonb_build_object('url', p_url, 'sha256', p_sha256, 'excerpts', v_n, 'changed', v.sha256 is not null));
  return jsonb_build_object('changed', v.sha256 is not null, 'excerpts', v_n, 'first', v.sha256 is null);
end;
$$;

-- ---------------------------------------------------------------------------
-- OCR jobs
-- ---------------------------------------------------------------------------
create type public.ocr_status as enum ('queued', 'running', 'done', 'failed');
create table public.ocr_jobs (
  id            uuid primary key default gen_random_uuid(),
  source_id     uuid not null references public.sources (id) on delete cascade,
  project_id    uuid references public.projects (id) on delete cascade,
  bucket        text not null check (bucket in ('project-files', 'knowledge-files')),
  storage_path  text not null,
  sha256        text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes    bigint not null,
  keep_file     boolean not null,
  status        public.ocr_status not null default 'queued',
  pages         integer,
  excerpts      integer,
  mean_confidence numeric,
  error         text,
  attempts      integer not null default 0,
  claimed_by    text,
  claimed_at    timestamptz,
  requested_by  uuid references auth.users (id) on delete set null default auth.uid(),
  requested_at  timestamptz not null default now(),
  completed_at  timestamptz
);
create index ocr_jobs_queue_idx on public.ocr_jobs (status, requested_at);
alter table public.ocr_jobs enable row level security;
create policy "read ocr jobs of readable sources" on public.ocr_jobs for select to authenticated
  using (project_id is null or public.is_project_member(project_id));
grant select on public.ocr_jobs to authenticated;
grant all on public.ocr_jobs to service_role;

create function public.request_ocr(p_source_id uuid, p_storage_path text, p_sha256 text, p_size_bytes bigint) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v public.sources; v_id uuid; v_bucket text;
begin
  select * into v from public.sources where id = p_source_id;
  if v.id is null or not public.kb_can_write(v.project_id) then
    raise exception 'source not found or not permitted' using errcode = '42501';
  end if;
  if not public.kb_excerpts_allowed(v.license) then raise exception 'the licence of this source (%) does not allow reading the document', v.license; end if;
  v_bucket := case when v.project_id is null then 'knowledge-files' else 'project-files' end;
  if (v.project_id is not null and p_storage_path not like v.project_id::text || '/sources/%')
     or (v.project_id is null and p_storage_path not like v.id::text || '/%') then
    raise exception 'the scanned file must be stored in the source''s folder';
  end if;
  if exists (select 1 from public.ocr_jobs where source_id = v.id and status in ('queued', 'running')) then raise exception 'OCR is already queued for this source'; end if;
  insert into public.ocr_jobs (source_id, project_id, bucket, storage_path, sha256, size_bytes, keep_file)
  values (v.id, v.project_id, v_bucket, p_storage_path, lower(p_sha256), p_size_bytes, public.kb_file_allowed(v.license))
  returning id into v_id;
  perform public.worker_audit(v.project_id, 'source.ocr_requested', 'source', v.id, jsonb_build_object('job', v_id));
  return v_id;
end;
$$;

create function public.claim_ocr_job(p_worker_id text, p_stale_seconds integer default 1800) returns public.ocr_jobs
language plpgsql security definer set search_path = '' as $$
declare v public.ocr_jobs;
begin
  update public.ocr_jobs set status = 'failed', error = 'gave up after 3 attempts', claimed_by = null, completed_at = now()
   where status = 'running' and claimed_at < now() - make_interval(secs => p_stale_seconds) and attempts >= 3;
  select * into v from public.ocr_jobs
   where status = 'queued' or (status = 'running' and claimed_at < now() - make_interval(secs => p_stale_seconds))
   order by requested_at for update skip locked limit 1;
  if v.id is null then return null; end if;
  update public.ocr_jobs set status = 'running', claimed_by = p_worker_id, claimed_at = now(), attempts = attempts + 1
   where id = v.id returning * into v;
  return v;
end;
$$;

-- The worker's result: page excerpts (locators say they are OCR text), or an error. The source keeps the file only
-- if its licence allows; otherwise the worker deletes the stored copy and the source records no path.
create function public.complete_ocr_job(p_job_id uuid, p_worker_id text, p_chunks jsonb, p_pages integer, p_confidence numeric,
                                        p_error text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare j public.ocr_jobs; v public.sources; v_n integer;
begin
  select * into j from public.ocr_jobs where id = p_job_id for update;
  if j.status <> 'running' or j.claimed_by is distinct from p_worker_id then
    raise exception 'OCR job % is not being run by %', p_job_id, p_worker_id using hint = 'lease_lost';
  end if;
  if p_error is not null then
    update public.ocr_jobs set status = 'failed', error = p_error, claimed_by = null, completed_at = now() where id = j.id;
    perform public.worker_audit(j.project_id, 'source.ocr_failed', 'source', j.source_id, jsonb_build_object('error', p_error));
    return;
  end if;
  select * into v from public.sources where id = j.source_id for update;
  if not public.kb_excerpts_allowed(v.license) then raise exception 'the licence of this source changed and no longer allows excerpts'; end if;
  delete from public.source_chunks where source_id = v.id;
  insert into public.source_chunks (source_id, project_id, ordinal, locator, section_path, text)
  select v.id, v.project_id, (c ->> 'ordinal')::integer, c ->> 'locator', c ->> 'section_path', c ->> 'text'
    from jsonb_array_elements(coalesce(p_chunks, '[]'::jsonb)) c;
  get diagnostics v_n = row_count;
  update public.sources set indexed_chunks = v_n, text_origin = 'ocr', sha256 = j.sha256, mime_type = 'application/pdf', size_bytes = j.size_bytes,
         storage_path = case when j.keep_file and public.kb_file_allowed(v.license) then j.storage_path end
   where id = v.id;
  update public.ocr_jobs set status = 'done', pages = p_pages, excerpts = v_n, mean_confidence = p_confidence, claimed_by = null, completed_at = now()
   where id = j.id;
  perform public.worker_audit(j.project_id, 'source.ocr_done', 'source', v.id, jsonb_build_object('pages', p_pages, 'excerpts', v_n, 'confidence', p_confidence));
end;
$$;

-- ---------------------------------------------------------------------------
-- Modules catalog
-- ---------------------------------------------------------------------------
create table public.modules (
  id                 uuid primary key default gen_random_uuid(),
  kind               text not null check (kind in ('radio_module', 'som', 'dev_board', 'sensor_module', 'power_module', 'display', 'other')),
  name               text not null check (length(trim(name)) between 1 and 120),
  manufacturer       text not null check (length(trim(manufacturer)) between 1 and 120),
  mpn                text not null check (length(trim(mpn)) between 1 and 80),
  normalized_mpn     text not null,
  part_id            uuid references public.parts (id) on delete set null,
  description        text,
  interfaces         text[] not null default '{}',
  radios             text[] not null default '{}',
  supply             jsonb not null default '{}'::jsonb,       -- {v_min, v_max, i_typ_ma, i_max_ma, sleep_ua}
  dimensions_mm      jsonb not null default '{}'::jsonb,       -- {x, y, z}
  performance        jsonb not null default '{}'::jsonb,       -- {label: value} as the datasheet states it
  certifications     jsonb not null default '[]'::jsonb,       -- [{regime, id, holder, source_url, note}]
  cad                jsonb not null default '[]'::jsonb,       -- [{kind, url}]
  lifecycle          public.part_lifecycle not null default 'unknown',
  datasheet_source_id uuid references public.sources (id) on delete set null,
  source_url         text check (source_url is null or source_url ~ '^https://'),
  source_note        text,
  checked_on         date,
  status             text not null default 'draft' check (status in ('draft', 'verified')),
  verified_by        uuid references auth.users (id) on delete set null,
  verified_at        timestamptz,
  created_by         uuid references auth.users (id) on delete set null default auth.uid(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (normalized_mpn, manufacturer),
  check (source_url is not null or coalesce(trim(source_note), '') <> ''),
  check (status = 'draft' or verified_at is not null)
);
create trigger modules_updated_at before update on public.modules for each row execute function public.set_updated_at();
alter table public.modules enable row level security;
create policy "authenticated read modules" on public.modules for select to authenticated using (true);
grant select on public.modules to authenticated;
grant all on public.modules to service_role;

-- Certifications are claims about regulatory approvals: each needs a regime, an identifier and where it was read.
create function public.module_problem(p_certs jsonb, p_cad jsonb) returns text
language plpgsql immutable set search_path = '' as $$
declare c jsonb;
begin
  if jsonb_typeof(p_certs) <> 'array' or jsonb_typeof(p_cad) <> 'array' then return 'certifications and CAD must be lists'; end if;
  for c in select * from jsonb_array_elements(p_certs) loop
    if coalesce(trim(c ->> 'regime'), '') = '' or coalesce(trim(c ->> 'id'), '') = '' then return 'each certification needs a regime and an identifier'; end if;
    if coalesce(c ->> 'source_url', '') !~ '^https://' and coalesce(trim(c ->> 'note'), '') = '' then
      return format('certification %s %s: say where it was read (an https link to the grant or a note)', c ->> 'regime', c ->> 'id');
    end if;
  end loop;
  for c in select * from jsonb_array_elements(p_cad) loop
    if coalesce(c ->> 'url', '') !~ '^https://' then return 'CAD links must be https addresses'; end if;
  end loop;
  return null;
end;
$$;

create function public.save_module(p_id uuid, p_module jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid := p_id; v_problem text; m jsonb := p_module;
begin
  if not public.is_directory_user() then
    raise exception 'only project owners, engineers and library editors can edit the modules catalog' using errcode = '42501';
  end if;
  v_problem := public.module_problem(coalesce(m -> 'certifications', '[]'), coalesce(m -> 'cad', '[]'));
  if v_problem is not null then raise exception '%', v_problem; end if;
  if v_id is null then
    insert into public.modules (kind, name, manufacturer, mpn, normalized_mpn, part_id, description, interfaces, radios, supply, dimensions_mm,
                                performance, certifications, cad, lifecycle, datasheet_source_id, source_url, source_note, checked_on)
    values (m ->> 'kind', trim(m ->> 'name'), trim(m ->> 'manufacturer'), trim(m ->> 'mpn'), m ->> 'normalized_mpn',
            (select id from public.parts where normalized_mpn = m ->> 'normalized_mpn' order by updated_at desc limit 1),
            nullif(trim(coalesce(m ->> 'description', '')), ''),
            coalesce(array(select jsonb_array_elements_text(m -> 'interfaces')), '{}'), coalesce(array(select jsonb_array_elements_text(m -> 'radios')), '{}'),
            coalesce(m -> 'supply', '{}'), coalesce(m -> 'dimensions_mm', '{}'), coalesce(m -> 'performance', '{}'),
            coalesce(m -> 'certifications', '[]'), coalesce(m -> 'cad', '[]'), coalesce((m ->> 'lifecycle')::public.part_lifecycle, 'unknown'),
            nullif(m ->> 'datasheet_source_id', '')::uuid, nullif(trim(coalesce(m ->> 'source_url', '')), ''), nullif(trim(coalesce(m ->> 'source_note', '')), ''),
            nullif(m ->> 'checked_on', '')::date)
    returning id into v_id;
  else
    update public.modules set kind = m ->> 'kind', name = trim(m ->> 'name'), manufacturer = trim(m ->> 'manufacturer'), mpn = trim(m ->> 'mpn'),
           normalized_mpn = m ->> 'normalized_mpn',
           part_id = (select id from public.parts where normalized_mpn = m ->> 'normalized_mpn' order by updated_at desc limit 1),
           description = nullif(trim(coalesce(m ->> 'description', '')), ''),
           interfaces = coalesce(array(select jsonb_array_elements_text(m -> 'interfaces')), '{}'), radios = coalesce(array(select jsonb_array_elements_text(m -> 'radios')), '{}'),
           supply = coalesce(m -> 'supply', '{}'), dimensions_mm = coalesce(m -> 'dimensions_mm', '{}'), performance = coalesce(m -> 'performance', '{}'),
           certifications = coalesce(m -> 'certifications', '[]'), cad = coalesce(m -> 'cad', '[]'),
           lifecycle = coalesce((m ->> 'lifecycle')::public.part_lifecycle, 'unknown'), datasheet_source_id = nullif(m ->> 'datasheet_source_id', '')::uuid,
           source_url = nullif(trim(coalesce(m ->> 'source_url', '')), ''), source_note = nullif(trim(coalesce(m ->> 'source_note', '')), ''),
           checked_on = nullif(m ->> 'checked_on', '')::date,
           status = 'draft', verified_by = null, verified_at = null
     where id = v_id;
    if not found then raise exception 'module not found'; end if;
  end if;
  perform public.worker_audit(null, 'module.saved', 'module', v_id, jsonb_build_object('mpn', m ->> 'mpn', 'name', m ->> 'name'));
  return v_id;
end;
$$;

create function public.verify_module(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_knowledge_editor() then raise exception 'only library editors verify modules' using errcode = '42501'; end if;
  update public.modules set status = 'verified', verified_by = auth.uid(), verified_at = now() where id = p_id;
  if not found then raise exception 'module not found'; end if;
  perform public.worker_audit(null, 'module.verified', 'module', p_id, '{}'::jsonb);
end;
$$;

revoke all on function public.apply_source_fetch(uuid, text, text, text, bigint, jsonb, text), public.request_ocr(uuid, text, text, bigint),
  public.save_module(uuid, jsonb), public.verify_module(uuid), public.module_problem(jsonb, jsonb) from public, anon;
grant execute on function public.apply_source_fetch(uuid, text, text, text, bigint, jsonb, text), public.request_ocr(uuid, text, text, bigint),
  public.save_module(uuid, jsonb), public.verify_module(uuid), public.module_problem(jsonb, jsonb) to authenticated, service_role;
revoke all on function public.claim_ocr_job(text, integer), public.complete_ocr_job(uuid, text, jsonb, integer, numeric, text) from public, anon, authenticated;
grant execute on function public.claim_ocr_job(text, integer), public.complete_ocr_job(uuid, text, jsonb, integer, numeric, text) to service_role;
