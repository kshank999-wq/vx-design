-- Virus scanning of uploaded files (G6). A worker with a ClamAV scanner (CLAMD_HOST) scans every file people bring
-- in (project documents, 3D model uploads and downloads, knowledge-base files, Flux exports) and records the result.
-- An infected file becomes unreadable to everyone at the storage layer and is reported in the project's audit log.
-- With the platform setting require_virus_scan on, uploaded files stay unreadable until they have been scanned clean.

create type public.scan_status as enum ('clean', 'infected', 'error');

create table public.file_scans (
  bucket      text not null,
  path        text not null,
  sha256      text,
  size_bytes  bigint,
  status      public.scan_status not null,
  engine      text,
  signature   text,
  detail      text,
  scanned_at  timestamptz not null default now(),
  primary key (bucket, path)
);
alter table public.file_scans enable row level security;
create policy "members read scans of their project files" on public.file_scans for select to authenticated
  using ((bucket = 'project-files' and public.is_project_member(public.storage_path_project_id(path))) or bucket = 'knowledge-files');
grant select on public.file_scans to authenticated;
grant all on public.file_scans to service_role;

create table public.platform_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.platform_settings enable row level security;
create policy "signed-in users read settings" on public.platform_settings for select to authenticated using (true);
grant select on public.platform_settings to authenticated;
grant all on public.platform_settings to service_role;
insert into public.platform_settings (key, value) values ('require_virus_scan', 'false');

-- Folders that hold files people brought in (everything else is written by workers from those inputs).
create function public.is_upload_path(p_bucket text, p_name text) returns boolean
language sql immutable set search_path = '' as $$
  select p_bucket = 'knowledge-files' or (p_bucket = 'project-files' and split_part(p_name, '/', 2) in ('documents', 'models', 'sources', 'flux'));
$$;

-- Readable as far as scanning goes: never when infected; when scans are required, only uploads scanned clean.
-- Runs as the caller: scan rows are visible to members of the file's project (and knowledge files to everyone).
create function public.scan_allows(p_bucket text, p_name text) returns boolean
language plpgsql stable set search_path = '' as $$
declare s public.scan_status;
begin
  if not public.is_upload_path(p_bucket, p_name) then return true; end if;
  select status into s from public.file_scans where bucket = p_bucket and path = p_name;
  if s = 'infected' then return false; end if;
  if coalesce((select (value #>> '{}')::boolean from public.platform_settings where key = 'require_virus_scan'), false) then
    return s = 'clean';
  end if;
  return true;
end;
$$;

create or replace function public.project_file_readable(p_name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.scan_allows('project-files', p_name) and case
    when split_part(p_name, '/', 2) in ('rfq', 'flux') then public.is_project_staff(public.storage_path_project_id(p_name))
    else public.is_project_member(public.storage_path_project_id(p_name))
  end;
$$;

do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    drop policy if exists "everyone reads knowledge files" on storage.objects;
    create policy "everyone reads knowledge files" on storage.objects for select to authenticated
      using (bucket_id = 'knowledge-files' and public.scan_allows('knowledge-files', name));
  end if;
end;
$$;

-- Workers: the next uploaded files without a current scan (new, replaced since, or an error more than 10 minutes old).
create function public.next_files_to_scan(p_limit integer default 20)
returns table (bucket text, path text, size_bytes bigint, updated_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  return query execute $q$
    select o.bucket_id::text, o.name::text, nullif(o.metadata ->> 'size', '')::bigint, coalesce(o.updated_at, o.created_at)
      from storage.objects o
     where o.bucket_id in ('project-files', 'knowledge-files') and public.is_upload_path(o.bucket_id, o.name)
       and not exists (select 1 from public.file_scans s where s.bucket = o.bucket_id and s.path = o.name
                         and s.scanned_at >= coalesce(o.updated_at, o.created_at)
                         and (s.status <> 'error' or s.scanned_at > now() - interval '10 minutes'))
     order by coalesce(o.updated_at, o.created_at) limit $1 $q$ using p_limit;
end;
$$;

create function public.record_file_scan(p_bucket text, p_path text, p_sha256 text, p_size bigint, p_status public.scan_status,
                                        p_engine text, p_signature text, p_detail text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_project uuid := case when p_bucket = 'project-files' then public.storage_path_project_id(p_path) end;
begin
  insert into public.file_scans (bucket, path, sha256, size_bytes, status, engine, signature, detail, scanned_at)
  values (p_bucket, p_path, p_sha256, p_size, p_status, p_engine, p_signature, left(p_detail, 500), now())
  on conflict (bucket, path) do update set sha256 = excluded.sha256, size_bytes = excluded.size_bytes, status = excluded.status,
    engine = excluded.engine, signature = excluded.signature, detail = excluded.detail, scanned_at = excluded.scanned_at;
  if p_status = 'infected' then
    perform public.worker_audit(v_project, 'file.infected', 'storage_object', null,
                                jsonb_build_object('bucket', p_bucket, 'path', p_path, 'signature', p_signature, 'sha256', p_sha256, 'engine', p_engine));
  end if;
end;
$$;

revoke all on function public.is_upload_path(text, text) from public, anon;
grant execute on function public.is_upload_path(text, text) to authenticated, service_role;
revoke all on function public.scan_allows(text, text) from public, anon;
grant execute on function public.scan_allows(text, text) to authenticated, service_role;
revoke all on function public.next_files_to_scan(integer), public.record_file_scan(text, text, text, bigint, public.scan_status, text, text, text)
  from public, anon, authenticated;
grant execute on function public.next_files_to_scan(integer), public.record_file_scan(text, text, text, bigint, public.scan_status, text, text, text)
  to service_role;
