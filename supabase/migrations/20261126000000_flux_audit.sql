-- Flux import and engineering audit (G5, spec §16).
--
-- Owners and engineers upload what Flux exports (project data JSON, netlists, Gerbers, BOM and placement files, STEP,
-- chat and report exports, screenshots), each tagged with the revision it belongs to. A worker inventories the files,
-- checks the exports against each other, compares revisions, extracts prior decisions and claimed validations from
-- the text exports (each quote checked word for word), and writes a report with a migration plan. Nothing imported is
-- ever marked verified. Audits are engineering-internal: project staff only.

create type public.flux_audit_status as enum ('draft', 'queued', 'running', 'ready', 'failed');

create table public.flux_audits (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references public.projects(id) on delete cascade,
  audit_no        integer not null,
  title           text not null check (length(trim(title)) between 1 and 200),
  status          public.flux_audit_status not null default 'draft',
  summary         jsonb not null default '{}'::jsonb,     -- counts from the report, for lists
  report_path     text,                                   -- full report (JSON) in the project's folder
  report_md_path  text,                                   -- the same as Markdown
  report_sha256   text,
  history_model   text,
  error           text,
  attempts        integer not null default 0,
  claimed_by      text,
  claimed_at      timestamptz,
  requested_by    uuid references auth.users(id) on delete set null,
  requested_at    timestamptz,
  completed_at    timestamptz,
  created_by      uuid references auth.users(id) on delete set null default auth.uid(),
  created_at      timestamptz not null default now(),
  unique (project_id, audit_no),
  check (status <> 'ready' or (report_path is not null and report_md_path is not null))
);
create index flux_audits_queue_idx on public.flux_audits (status, requested_at) where status in ('queued', 'running');

create table public.flux_audit_files (
  id              uuid primary key default gen_random_uuid(),
  audit_id        uuid not null references public.flux_audits(id) on delete cascade,
  project_id      uuid not null references public.projects(id) on delete cascade,
  revision_label  text not null check (length(trim(revision_label)) between 1 and 80),
  revision_date   date,
  name            text not null,
  storage_path    text not null,
  sha256          text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes      bigint not null check (size_bytes >= 0),
  uploaded_by     uuid references auth.users(id) on delete set null default auth.uid(),
  created_at      timestamptz not null default now(),
  unique (audit_id, revision_label, sha256)
);
create index flux_audit_files_audit_idx on public.flux_audit_files (audit_id);

alter table public.flux_audits enable row level security;
alter table public.flux_audit_files enable row level security;
create policy "staff read flux audits" on public.flux_audits for select to authenticated using (public.is_project_staff(project_id));
create policy "staff read flux files" on public.flux_audit_files for select to authenticated using (public.is_project_staff(project_id));
grant select on public.flux_audits, public.flux_audit_files to authenticated;
grant all on public.flux_audits, public.flux_audit_files to service_role;

create function public.flux_audit_for_staff(p_audit_id uuid) returns public.flux_audits
language plpgsql security definer set search_path = '' as $$
declare v public.flux_audits;
begin
  select * into v from public.flux_audits where id = p_audit_id for update;
  if v.id is null or not public.has_project_role(v.project_id, '{owner,engineer}') then
    raise exception 'audit not found or not permitted' using errcode = '42501';
  end if;
  return v;
end;
$$;

create function public.create_flux_audit(p_project_id uuid, p_title text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_no integer;
begin
  if not public.has_project_role(p_project_id, '{owner,engineer}') then
    raise exception 'only owners and engineers of the project can import Flux work' using errcode = '42501';
  end if;
  if coalesce(trim(p_title), '') = '' then raise exception 'give the import a title'; end if;
  perform pg_advisory_xact_lock(hashtext('flux:' || p_project_id::text));
  select coalesce(max(audit_no), 0) + 1 into v_no from public.flux_audits where project_id = p_project_id;
  insert into public.flux_audits (project_id, audit_no, title) values (p_project_id, v_no, trim(p_title)) returning id into v_id;
  perform public.worker_audit(p_project_id, 'flux.created', 'flux_audit', v_id, jsonb_build_object('audit_no', v_no));
  return v_id;
end;
$$;

-- Registers a file the browser has uploaded to <project>/flux/<audit>/... (the storage policy limits uploads to the
-- project's owners and engineers).
create function public.add_flux_file(p_audit_id uuid, p_revision text, p_revision_date date, p_name text, p_path text,
                                     p_sha256 text, p_size bigint) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v public.flux_audits; v_id uuid;
begin
  v := public.flux_audit_for_staff(p_audit_id);
  if v.status in ('queued', 'running') then raise exception 'the audit is running; add files when it has finished'; end if;
  if p_path is null or p_path not like v.project_id::text || '/flux/' || v.id::text || '/%' then
    raise exception 'files must be stored in this audit''s folder';
  end if;
  insert into public.flux_audit_files (audit_id, project_id, revision_label, revision_date, name, storage_path, sha256, size_bytes)
  values (v.id, v.project_id, trim(p_revision), p_revision_date, p_name, p_path, lower(p_sha256), p_size)
  on conflict (audit_id, revision_label, sha256) do update set name = excluded.name
  returning id into v_id;
  return v_id;
end;
$$;

create function public.remove_flux_file(p_file_id uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare f public.flux_audit_files; v public.flux_audits;
begin
  select * into f from public.flux_audit_files where id = p_file_id;
  v := public.flux_audit_for_staff(f.audit_id);
  if v.status in ('queued', 'running') then raise exception 'the audit is running'; end if;
  delete from public.flux_audit_files where id = f.id;
  return f.storage_path;
end;
$$;

create function public.run_flux_audit(p_audit_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.flux_audits;
begin
  v := public.flux_audit_for_staff(p_audit_id);
  if v.status in ('queued', 'running') then raise exception 'the audit is already running'; end if;
  if not exists (select 1 from public.flux_audit_files where audit_id = v.id) then raise exception 'upload the Flux export first'; end if;
  update public.flux_audits set status = 'queued', error = null, attempts = 0, claimed_by = null, requested_by = auth.uid(), requested_at = now()
   where id = v.id;
  perform public.worker_audit(v.project_id, 'flux.audit_requested', 'flux_audit', v.id,
    jsonb_build_object('files', (select count(*) from public.flux_audit_files where audit_id = v.id)));
end;
$$;

create function public.claim_flux_audit(p_worker_id text, p_stale_seconds integer default 900) returns public.flux_audits
language plpgsql security definer set search_path = '' as $$
declare v public.flux_audits;
begin
  update public.flux_audits set status = 'failed', error = 'gave up after 3 attempts', claimed_by = null, completed_at = now()
   where status = 'running' and claimed_at < now() - make_interval(secs => p_stale_seconds) and attempts >= 3;
  select * into v from public.flux_audits
   where status = 'queued' or (status = 'running' and claimed_at < now() - make_interval(secs => p_stale_seconds))
   order by requested_at for update skip locked limit 1;
  if v.id is null then return null; end if;
  update public.flux_audits set status = 'running', claimed_by = p_worker_id, claimed_at = now(), attempts = attempts + 1
   where id = v.id returning * into v;
  return v;
end;
$$;

create function public.complete_flux_audit(p_audit_id uuid, p_worker_id text, p_report_path text, p_md_path text, p_sha256 text,
                                           p_summary jsonb, p_history_model text, p_error text default null) returns public.flux_audit_status
language plpgsql security definer set search_path = '' as $$
declare v public.flux_audits;
begin
  select * into v from public.flux_audits where id = p_audit_id for update;
  if v.status <> 'running' or v.claimed_by is distinct from p_worker_id then
    raise exception 'audit % is not being run by %', p_audit_id, p_worker_id using hint = 'lease_lost';
  end if;
  if p_error is not null then
    update public.flux_audits set status = 'failed', error = p_error, claimed_by = null, completed_at = now() where id = v.id;
    perform public.worker_audit(v.project_id, 'flux.audit_failed', 'flux_audit', v.id, jsonb_build_object('error', p_error));
    return 'failed';
  end if;
  if split_part(p_report_path, '/', 1) <> v.project_id::text or split_part(p_md_path, '/', 1) <> v.project_id::text then
    raise exception 'reports must be stored in the project''s folder';
  end if;
  update public.flux_audits set status = 'ready', report_path = p_report_path, report_md_path = p_md_path, report_sha256 = p_sha256,
         summary = coalesce(p_summary, '{}'::jsonb), history_model = p_history_model, error = null, claimed_by = null, completed_at = now()
   where id = v.id;
  perform public.worker_audit(v.project_id, 'flux.audit_completed', 'flux_audit', v.id,
                              jsonb_build_object('summary', p_summary, 'report_sha256', p_sha256));
  return 'ready';
end;
$$;

revoke all on function public.create_flux_audit, public.add_flux_file, public.remove_flux_file, public.run_flux_audit from public, anon;
grant execute on function public.create_flux_audit, public.add_flux_file, public.remove_flux_file, public.run_flux_audit to authenticated;
revoke all on function public.flux_audit_for_staff from public, anon, authenticated;
revoke all on function public.claim_flux_audit, public.complete_flux_audit from public, anon, authenticated;
grant execute on function public.claim_flux_audit, public.complete_flux_audit to service_role;

do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    create policy "engineers delete flux uploads" on storage.objects for delete to authenticated
      using (bucket_id = 'project-files' and split_part(name, '/', 2) = 'flux'
             and public.has_project_role(public.storage_path_project_id(name), '{owner,engineer}'));
  end if;
end;
$$;
