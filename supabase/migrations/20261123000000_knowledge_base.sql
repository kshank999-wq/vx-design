-- Knowledge base (M-KB, spec §8): source registry with licensing controls, cited excerpts, standards registry,
-- per-project standards applicability, and one search that returns official URLs, edition and licence flags,
-- and citations.
--
-- Licensing rules (spec §8), enforced here rather than in the app:
--   * A URL is not permission to download, republish or index a document.
--   * Excerpts are indexed only for public-domain, open-licence, vendor-terms (datasheets, app notes, quoted for
--     engineering use) and licensed copies. Everything else is metadata plus a pointer to the official copy.
--   * A file is kept only for public-domain and open-licence documents, or a licensed copy held privately by
--     one project. Vendor documents are read for excerpts, then the file stays at the vendor's URL.
--   * A licensed copy never enters the shared library: it belongs to one project and is searched only there.
--
-- Search is full-text (Postgres) plus standard-identifier matching. Vector search (pgvector) waits for an
-- embedding provider (owner decision; Anthropic has no embedding API).


create type public.source_kind as enum
  ('standard', 'regulation', 'datasheet', 'application_note', 'vendor_rule', 'tool_documentation', 'reference', 'other');
create type public.source_license as enum
  ('public_domain', 'open_license', 'vendor_terms', 'reference_only', 'licensed_copy', 'unknown');
create type public.source_status as enum ('draft', 'verified', 'superseded', 'withdrawn');
create type public.source_acquisition as enum ('official_url', 'upload', 'manual_entry', 'distributor_api');
create type public.standard_review as enum ('unreviewed', 'reviewed', 'superseded');
create type public.standard_applicability as enum ('applies', 'may_apply', 'does_not_apply');
create type public.applicability_status as enum ('proposed', 'confirmed');

create function public.kb_excerpts_allowed(p public.source_license) returns boolean
language sql immutable set search_path = '' as $$
  select p in ('public_domain', 'open_license', 'vendor_terms', 'licensed_copy');
$$;
create function public.kb_file_allowed(p public.source_license) returns boolean
language sql immutable set search_path = '' as $$
  select p in ('public_domain', 'open_license', 'licensed_copy');
$$;
-- "IPC-2152", "ipc 2152" and "IPC2152" all normalise to "ipc2152".
create function public.kb_norm(p text) returns text
language sql immutable set search_path = '' as $$
  select regexp_replace(lower(coalesce(p, '')), '[^a-z0-9]', '', 'g');
$$;

-- Who may curate the shared library (granted by the platform operator with the service role).
create table public.knowledge_editors (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  note       text,
  created_at timestamptz not null default now()
);
alter table public.knowledge_editors enable row level security;
create policy "editors see themselves" on public.knowledge_editors for select to authenticated using (user_id = auth.uid());
grant select on public.knowledge_editors to authenticated;
grant all on public.knowledge_editors to service_role;

create function public.is_knowledge_editor() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.knowledge_editors where user_id = auth.uid());
$$;

create table public.sources (
  id                 uuid primary key default gen_random_uuid(),
  project_id         uuid references public.projects(id) on delete cascade,   -- null: shared library
  kind               public.source_kind not null,
  title              text not null check (length(trim(title)) > 0),
  publisher          text not null check (length(trim(publisher)) > 0),
  identifier         text,                       -- e.g. "IPC-2221", "TPS63020 datasheet", "SLVA057"
  official_url       text check (official_url is null or official_url ~ '^https://'),
  edition            text,                       -- as printed by the publisher: "B", "Rev. F", "2021-03"
  edition_date       date,
  license            public.source_license not null default 'unknown',
  license_note       text,                       -- what the terms allow, in our words
  acquisition_method public.source_acquisition not null,
  summary            text,                       -- our own description, never copied text
  storage_path       text,
  sha256             text,
  mime_type          text,
  size_bytes         bigint,
  indexed_chunks     integer not null default 0,
  status             public.source_status not null default 'draft',
  last_verified_at   timestamptz,
  verified_by        uuid references auth.users(id) on delete set null,
  verification_note  text,
  superseded_by      uuid references public.sources(id) on delete set null,
  created_by         uuid references auth.users(id) on delete set null default auth.uid(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  check (license <> 'licensed_copy' or project_id is not null),
  check (storage_path is null or public.kb_file_allowed(license)),
  check (indexed_chunks = 0 or public.kb_excerpts_allowed(license)),
  check (status <> 'verified' or last_verified_at is not null)
);
create index sources_project_idx on public.sources (project_id);
create index sources_meta_idx on public.sources using gin (to_tsvector('english',
  coalesce(identifier, '') || ' ' || title || ' ' || publisher || ' ' || coalesce(summary, '')));
create trigger sources_updated_at before update on public.sources for each row execute function public.set_updated_at();
alter table public.sources enable row level security;
create policy "read shared or own project sources" on public.sources for select to authenticated
  using (project_id is null or public.is_project_member(project_id));
grant select on public.sources to authenticated;
grant all on public.sources to service_role;

create table public.source_chunks (
  id           bigint generated always as identity primary key,
  source_id    uuid not null references public.sources(id) on delete cascade,
  project_id   uuid references public.projects(id) on delete cascade,      -- copied from the source for RLS
  ordinal      integer not null,
  locator      text not null,                    -- citation: "§3.2 Conductor spacing, p. 12"
  section_path text,
  text         text not null check (length(text) between 1 and 4000),
  tsv          tsvector generated always as (to_tsvector('english', coalesce(section_path, '') || ' ' || text)) stored,
  unique (source_id, ordinal)
);
create index source_chunks_tsv_idx on public.source_chunks using gin (tsv);
alter table public.source_chunks enable row level security;
create policy "read shared or own project excerpts" on public.source_chunks for select to authenticated
  using (project_id is null or public.is_project_member(project_id));
grant select on public.source_chunks to authenticated;
grant all on public.source_chunks to service_role;

create table public.standards (
  id             uuid primary key default gen_random_uuid(),
  identifier     text not null unique,
  title          text not null,
  issuing_body   text not null,
  domain         text not null,
  region         text[] not null default '{}',
  edition        text,                           -- null until a reviewer confirms it with the issuing body
  edition_note   text,
  license        public.source_license not null default 'reference_only',
  publisher_url  text check (publisher_url is null or publisher_url ~ '^https://'),
  source_id      uuid references public.sources(id) on delete set null,   -- an indexed or licensed copy, if held
  review_status  public.standard_review not null default 'unreviewed',
  reviewed_by    uuid references auth.users(id) on delete set null,
  reviewed_at    timestamptz,
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  check (review_status = 'unreviewed' or reviewed_at is not null)
);
create index standards_text_idx on public.standards using gin (to_tsvector('english',
  identifier || ' ' || title || ' ' || domain || ' ' || issuing_body || ' ' || coalesce(notes, '')));
create trigger standards_updated_at before update on public.standards for each row execute function public.set_updated_at();
alter table public.standards enable row level security;
create policy "everyone reads standards" on public.standards for select to authenticated using (true);
grant select on public.standards to authenticated;
grant all on public.standards to service_role;

create table public.project_standards (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references public.projects(id) on delete cascade,
  standard_id   uuid not null references public.standards(id) on delete cascade,
  applicability public.standard_applicability not null,
  rationale     text not null check (length(trim(rationale)) > 0),
  status        public.applicability_status not null default 'proposed',
  proposed_by   uuid references auth.users(id) on delete set null,
  confirmed_by  uuid references auth.users(id) on delete set null,
  confirmed_at  timestamptz,
  confirm_note  text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (project_id, standard_id),
  check (status = 'proposed' or (confirmed_by is not null and confirmed_at is not null))
);
create trigger project_standards_updated_at before update on public.project_standards for each row execute function public.set_updated_at();
alter table public.project_standards enable row level security;
create policy "members read project standards" on public.project_standards for select to authenticated
  using (public.is_project_member(project_id));
grant select on public.project_standards to authenticated;
grant all on public.project_standards to service_role;

-- Shared library files (public-domain and open-licence documents only; enforced by sources.storage_path).
do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    insert into storage.buckets (id, name, public) values ('knowledge-files', 'knowledge-files', false)
    on conflict (id) do nothing;
    create policy "everyone reads knowledge files" on storage.objects for select to authenticated
      using (bucket_id = 'knowledge-files');
    create policy "editors upload knowledge files" on storage.objects for insert to authenticated
      with check (bucket_id = 'knowledge-files' and public.is_knowledge_editor());
    -- A licence downgrade removes the stored copy.
    create policy "editors delete knowledge files" on storage.objects for delete to authenticated
      using (bucket_id = 'knowledge-files' and public.is_knowledge_editor());
    create policy "engineers delete project source files" on storage.objects for delete to authenticated
      using (bucket_id = 'project-files' and split_part(name, '/', 2) = 'sources'
             and public.has_project_role(public.storage_path_project_id(name), '{owner,engineer}'));
  end if;
end;
$$;

-- Write access: shared library -> knowledge editors; project sources -> the project's owners and engineers.
create function public.kb_can_write(p_project uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select case when p_project is null then public.is_knowledge_editor()
              else public.has_project_role(p_project, '{owner,engineer}') end;
$$;

create function public.register_source(
  p_project_id uuid, p_kind public.source_kind, p_title text, p_publisher text, p_official_url text,
  p_identifier text default null, p_edition text default null, p_license public.source_license default 'unknown',
  p_license_note text default null, p_summary text default null, p_acquisition public.source_acquisition default 'manual_entry'
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  if not public.kb_can_write(p_project_id) then
    raise exception '%', case when p_project_id is null then 'only knowledge editors can add to the shared library'
                              else 'only owners and engineers of the project can add its sources' end
      using errcode = '42501';
  end if;
  if p_license = 'licensed_copy' and p_project_id is null then
    raise exception 'a licensed copy belongs to one project; it cannot go into the shared library';
  end if;
  if coalesce(p_official_url, '') = '' and p_acquisition <> 'upload' then
    raise exception 'a source needs its official https URL (or an uploaded copy)';
  end if;
  insert into public.sources (project_id, kind, title, publisher, identifier, official_url, edition, license, license_note,
                              summary, acquisition_method)
  values (p_project_id, p_kind, trim(p_title), trim(p_publisher), nullif(trim(coalesce(p_identifier, '')), ''),
          nullif(trim(coalesce(p_official_url, '')), ''), nullif(trim(coalesce(p_edition, '')), ''), p_license,
          p_license_note, p_summary, p_acquisition)
  returning id into v_id;
  perform public.worker_audit(p_project_id, 'source.registered', 'source', v_id,
                              jsonb_build_object('title', p_title, 'license', p_license));
  return v_id;
end;
$$;

-- Replace a source's excerpts (and optionally record its stored file). Refused when the licence does not allow it.
create function public.set_source_content(
  p_source_id uuid, p_chunks jsonb, p_storage_path text default null, p_sha256 text default null,
  p_mime_type text default null, p_size_bytes bigint default null
) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v public.sources;
  v_n integer;
begin
  select * into v from public.sources where id = p_source_id for update;
  if v.id is null or not public.kb_can_write(v.project_id) then
    raise exception 'source not found or not permitted' using errcode = '42501';
  end if;
  if jsonb_array_length(coalesce(p_chunks, '[]'::jsonb)) > 0 and not public.kb_excerpts_allowed(v.license) then
    raise exception 'the licence of this source (%) does not allow indexing excerpts; keep metadata and the official link', v.license;
  end if;
  if p_storage_path is not null and not public.kb_file_allowed(v.license) then
    raise exception 'the licence of this source (%) does not allow keeping a copy of the file', v.license;
  end if;
  if p_storage_path is not null and v.project_id is not null and split_part(p_storage_path, '/', 1) <> v.project_id::text then
    raise exception 'a project source''s file must be stored in that project''s folder';
  end if;
  if jsonb_array_length(coalesce(p_chunks, '[]'::jsonb)) > 5000 then
    raise exception 'too many excerpts (max 5000)';
  end if;
  delete from public.source_chunks where source_id = v.id;
  insert into public.source_chunks (source_id, project_id, ordinal, locator, section_path, text)
  select v.id, v.project_id, (c ->> 'ordinal')::integer, c ->> 'locator', c ->> 'section_path', c ->> 'text'
    from jsonb_array_elements(coalesce(p_chunks, '[]'::jsonb)) c;
  get diagnostics v_n = row_count;
  update public.sources set indexed_chunks = v_n,
         storage_path = coalesce(p_storage_path, storage_path), sha256 = coalesce(p_sha256, sha256),
         mime_type = coalesce(p_mime_type, mime_type), size_bytes = coalesce(p_size_bytes, size_bytes),
         acquisition_method = case when p_storage_path is not null or v_n > 0 then 'upload' else acquisition_method end
   where id = v.id;
  perform public.worker_audit(v.project_id, 'source.indexed', 'source', v.id, jsonb_build_object('excerpts', v_n));
  return v_n;
end;
$$;

-- Change a licence. Downgrading removes what the new licence does not allow; returns the stored file's path for the
-- caller to delete from storage (null when the file may stay or there was none).
create function public.set_source_license(p_source_id uuid, p_license public.source_license, p_note text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v public.sources;
  v_remove text;
begin
  select * into v from public.sources where id = p_source_id for update;
  if v.id is null or not public.kb_can_write(v.project_id) then
    raise exception 'source not found or not permitted' using errcode = '42501';
  end if;
  if coalesce(trim(p_note), '') = '' then
    raise exception 'say why the licence changed (what the terms say, or who confirmed it)';
  end if;
  if p_license = 'licensed_copy' and v.project_id is null then
    raise exception 'a licensed copy belongs to one project; it cannot go into the shared library';
  end if;
  if not public.kb_excerpts_allowed(p_license) then
    delete from public.source_chunks where source_id = v.id;
  end if;
  if v.storage_path is not null and not public.kb_file_allowed(p_license) then
    v_remove := v.storage_path;
  end if;
  update public.sources set license = p_license, license_note = p_note,
         indexed_chunks = case when public.kb_excerpts_allowed(p_license) then indexed_chunks else 0 end,
         storage_path = case when v_remove is null then storage_path end,
         sha256 = case when v_remove is null then sha256 end
   where id = v.id;
  perform public.worker_audit(v.project_id, 'source.license_changed', 'source', v.id,
                              jsonb_build_object('from', v.license, 'to', p_license, 'note', p_note));
  return v_remove;
end;
$$;

-- A person confirms the source is the official one, at the stated edition.
create function public.verify_source(p_source_id uuid, p_edition text, p_note text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v public.sources;
begin
  select * into v from public.sources where id = p_source_id for update;
  if v.id is null or not (case when v.project_id is null then public.is_knowledge_editor()
                               else public.has_project_role(v.project_id, '{owner,reviewer}') end) then
    raise exception '%', case when v.project_id is null then 'only knowledge editors can verify shared sources'
                              else 'only owners and reviewers of the project can verify its sources' end
      using errcode = '42501';
  end if;
  if coalesce(trim(p_note), '') = '' then
    raise exception 'say how it was verified (e.g. checked against the publisher''s page on a date)';
  end if;
  update public.sources set status = 'verified', last_verified_at = now(), verified_by = auth.uid(),
         verification_note = p_note, edition = coalesce(nullif(trim(coalesce(p_edition, '')), ''), edition)
   where id = v.id;
  perform public.worker_audit(v.project_id, 'source.verified', 'source', v.id, jsonb_build_object('note', p_note));
end;
$$;

create function public.withdraw_source(p_source_id uuid, p_superseded_by uuid, p_note text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v public.sources;
begin
  select * into v from public.sources where id = p_source_id for update;
  if v.id is null or not public.kb_can_write(v.project_id) then
    raise exception 'source not found or not permitted' using errcode = '42501';
  end if;
  update public.sources set status = case when p_superseded_by is null then 'withdrawn' else 'superseded' end::public.source_status,
         superseded_by = p_superseded_by, verification_note = p_note
   where id = v.id;
  perform public.worker_audit(v.project_id, 'source.withdrawn', 'source', v.id,
                              jsonb_build_object('superseded_by', p_superseded_by, 'note', p_note));
end;
$$;

-- Standards registry curation (knowledge editors).
create function public.review_standard(p_standard_id uuid, p_edition text, p_edition_note text,
                                       p_status public.standard_review, p_source_id uuid default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_knowledge_editor() then
    raise exception 'only knowledge editors can review the standards registry' using errcode = '42501';
  end if;
  if p_status = 'reviewed' and coalesce(trim(p_edition), '') = '' then
    raise exception 'a reviewed standard needs the edition confirmed with the issuing body';
  end if;
  if p_source_id is not null and exists (select 1 from public.sources where id = p_source_id and project_id is not null) then
    raise exception 'link a shared source; a project''s licensed copy stays with that project';
  end if;
  update public.standards set edition = nullif(trim(coalesce(p_edition, '')), ''), edition_note = p_edition_note,
         review_status = p_status, reviewed_by = auth.uid(), reviewed_at = now(),
         source_id = coalesce(p_source_id, source_id)
   where id = p_standard_id;
  if not found then raise exception 'standard not found'; end if;
  perform public.worker_audit(null, 'standard.reviewed', 'standard', p_standard_id,
                              jsonb_build_object('edition', p_edition, 'status', p_status));
end;
$$;

-- Which standards apply to a project: engineers propose with a rationale; owners or reviewers confirm.
create function public.set_project_standard(p_project_id uuid, p_standard_id uuid,
                                            p_applicability public.standard_applicability, p_rationale text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  if not public.has_project_role(p_project_id, '{owner,engineer}') then
    raise exception 'only owners and engineers can propose which standards apply' using errcode = '42501';
  end if;
  if coalesce(trim(p_rationale), '') = '' then
    raise exception 'give the reason (product scope, market, a requirement)';
  end if;
  insert into public.project_standards (project_id, standard_id, applicability, rationale, proposed_by)
  values (p_project_id, p_standard_id, p_applicability, trim(p_rationale), auth.uid())
  on conflict (project_id, standard_id) do update
     set applicability = excluded.applicability, rationale = excluded.rationale, proposed_by = auth.uid(),
         status = 'proposed', confirmed_by = null, confirmed_at = null, confirm_note = null
  returning id into v_id;
  perform public.worker_audit(p_project_id, 'standard.applicability_proposed', 'project_standard', v_id,
                              jsonb_build_object('standard', p_standard_id, 'applicability', p_applicability));
  return v_id;
end;
$$;

create function public.confirm_project_standard(p_id uuid, p_note text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v public.project_standards;
begin
  select * into v from public.project_standards where id = p_id for update;
  if v.id is null or not public.has_project_role(v.project_id, '{owner,reviewer}') then
    raise exception 'only owners and reviewers can confirm which standards apply' using errcode = '42501';
  end if;
  update public.project_standards set status = 'confirmed', confirmed_by = auth.uid(), confirmed_at = now(), confirm_note = p_note
   where id = p_id;
  perform public.worker_audit(v.project_id, 'standard.applicability_confirmed', 'project_standard', p_id,
                              jsonb_build_object('note', p_note));
end;
$$;

-- Search. Runs as the caller, so row level security decides what can be found. With a project, that project's
-- private sources are included alongside the shared library; another project's sources never are, even for a
-- member of both (an NDA document must not leak into a different client's answers).
create function public.search_knowledge(p_query text, p_project_id uuid default null, p_limit integer default 10)
returns table (
  result_kind text, source_id uuid, standard_id uuid, project_id uuid, kind text, title text, identifier text,
  publisher text, official_url text, edition text, license text, excerpt_allowed boolean, status text,
  last_verified_at timestamptz, locator text, snippet text, rank real
)
language plpgsql stable security invoker set search_path = '' as $$
declare
  -- Any word can match (questions are long and phrased loosely); passages matching every word rank higher.
  v_all tsquery;
  v_q tsquery;
  v_tokens text[];
  v_limit integer := least(greatest(coalesce(p_limit, 10), 1), 50);
begin
  if coalesce(trim(p_query), '') = '' then return; end if;
  v_all := websearch_to_tsquery('english', p_query);
  v_q := nullif(replace(plainto_tsquery('english', p_query)::text, ' & ', ' | '), '')::tsquery;   -- null: only stop words
  -- Tokens with digits ("2152", "62368-1") match standard and part identifiers however they are punctuated.
  v_tokens := array(select public.kb_norm(t) from regexp_split_to_table(p_query, '\s+') t
                    where public.kb_norm(t) ~ '[0-9]' and length(public.kb_norm(t)) >= 3);
  if v_q is null and cardinality(v_tokens) = 0 then return; end if;
  return query
  with excerpt_hits as (
    select c.source_id, c.locator,
           ts_headline('english', c.text, v_q, 'MaxWords=45, MinWords=20, StartSel=«, StopSel=», MaxFragments=2') as snippet,
           ts_rank_cd(c.tsv, v_q) + case when c.tsv @@ v_all then 1 else 0 end as r,
           row_number() over (partition by c.source_id order by ts_rank_cd(c.tsv, v_q) desc) as n
      from public.source_chunks c join public.sources s on s.id = c.source_id
     where c.tsv @@ v_q and s.status <> 'withdrawn'
       and (s.project_id is null or s.project_id = p_project_id)
  ), excerpts as (
    select 'excerpt'::text, s.id, null::uuid, s.project_id, s.kind::text, s.title, s.identifier, s.publisher, s.official_url,
           s.edition, s.license::text, true, s.status::text, s.last_verified_at, h.locator, h.snippet,
           (h.r * case when s.status = 'superseded' then 0.5 else 1 end)::real
      from excerpt_hits h join public.sources s on s.id = h.source_id
     where h.n <= 3
  ), meta as (
    select 'source'::text, s.id, null::uuid, s.project_id, s.kind::text, s.title, s.identifier, s.publisher, s.official_url,
           s.edition, s.license::text, public.kb_excerpts_allowed(s.license), s.status::text, s.last_verified_at,
           null::text, s.summary,
           (coalesce(ts_rank(to_tsvector('english', coalesce(s.identifier, '') || ' ' || s.title || ' ' || s.publisher || ' ' || coalesce(s.summary, '')), v_q), 0)
            + case when exists (select 1 from unnest(v_tokens) t where position(t in public.kb_norm(s.identifier)) > 0) then 1 else 0 end)::real
      from public.sources s
     where s.status <> 'withdrawn' and (s.project_id is null or s.project_id = p_project_id)
       and not exists (select 1 from excerpt_hits h where h.source_id = s.id)
       and (to_tsvector('english', coalesce(s.identifier, '') || ' ' || s.title || ' ' || s.publisher || ' ' || coalesce(s.summary, '')) @@ v_q
            or exists (select 1 from unnest(v_tokens) t where position(t in public.kb_norm(s.identifier)) > 0)) is true
  ), stds as (
    select 'standard'::text, st.source_id, st.id, null::uuid, st.domain, st.title, st.identifier, st.issuing_body, st.publisher_url,
           st.edition, st.license::text, public.kb_excerpts_allowed(st.license), st.review_status::text, st.reviewed_at,
           null::text, st.edition_note,
           (coalesce(ts_rank(to_tsvector('english', st.identifier || ' ' || st.title || ' ' || st.domain || ' ' || st.issuing_body || ' ' || coalesce(st.notes, '')), v_q), 0)
            + case when exists (select 1 from unnest(v_tokens) t where position(t in public.kb_norm(st.identifier)) > 0) then 2 else 0 end
            - case when st.review_status = 'superseded' then 1 else 0 end)::real
      from public.standards st
     where to_tsvector('english', st.identifier || ' ' || st.title || ' ' || st.domain || ' ' || st.issuing_body || ' ' || coalesce(st.notes, '')) @@ v_q
        or exists (select 1 from unnest(v_tokens) t where position(t in public.kb_norm(st.identifier)) > 0)
  )
  select * from (select * from stds union all select * from excerpts union all select * from meta) all_hits
   order by 17 desc limit v_limit;
end;
$$;

revoke all on function public.register_source, public.set_source_content, public.set_source_license, public.verify_source,
  public.withdraw_source, public.review_standard, public.set_project_standard, public.confirm_project_standard,
  public.search_knowledge, public.is_knowledge_editor, public.kb_can_write from public, anon;
grant execute on function public.register_source, public.set_source_content, public.set_source_license, public.verify_source,
  public.withdraw_source, public.review_standard, public.set_project_standard, public.confirm_project_standard,
  public.search_knowledge, public.is_knowledge_editor, public.kb_can_write to authenticated, service_role;
