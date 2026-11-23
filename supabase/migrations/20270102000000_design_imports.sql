-- "Import existing designs": the Flux import, opened to work from any tool. Each import records where the work comes
-- from. Running it also queues, for every native board file (Eagle, Altium, EasyEDA, PADS, CADSTAR, Allegro, P-CAD,
-- Fabmaster, SolidWorks PCB, IPC-2581, ODB++, KiCad) and 3D model (STEP, IGES, STL), a conversion the KiCad
-- engineering worker does: the board converted to KiCad with its design-rule check and facts, the model measured.
alter table public.flux_audits add column source_tool text not null default 'flux'
  check (source_tool in ('flux', 'kicad', 'eagle', 'altium', 'easyeda', 'pads', 'cadstar', 'allegro', 'orcad', 'solidworks', 'fusion', 'mcad', 'other'));

create table public.import_conversions (
  id           uuid primary key default gen_random_uuid(),
  audit_id     uuid not null references public.flux_audits (id) on delete cascade,
  file_id      uuid not null references public.flux_audit_files (id) on delete cascade,
  project_id   uuid not null references public.projects (id) on delete cascade,
  kind         text not null check (kind in ('pcb', 'mcad')),
  status       text not null default 'queued' check (status in ('queued', 'running', 'ready', 'failed')),
  result       jsonb not null default '{}'::jsonb,
  output_path  text,
  error        text,
  attempts     integer not null default 0,
  claimed_by   text,
  claimed_at   timestamptz,
  created_at   timestamptz not null default now(),
  completed_at timestamptz,
  unique (file_id)
);
create index import_conversions_queue_idx on public.import_conversions (status, created_at) where status in ('queued', 'running');
alter table public.import_conversions enable row level security;
create policy "staff read conversions" on public.import_conversions for select to authenticated using (public.is_project_staff(project_id));
revoke all on public.import_conversions from anon, authenticated;
grant select on public.import_conversions to authenticated;
grant all on public.import_conversions to service_role;

-- What a file is, from its name (and the import's source tool for ambiguous extensions such as .brd and .pcb).
create function public.import_file_kind(p_name text, p_tool text) returns text
language sql immutable set search_path = '' as $$
  select case
    when lower(p_name) ~ '\.(kicad_pcb|pcbdoc|cpa|asc|alg|fab)$' then 'pcb'
    when lower(p_name) ~ '\.brd$' then 'pcb'                                         -- Eagle or Allegro board
    when lower(p_name) ~ '\.pcb$' and p_tool in ('other', 'orcad', 'kicad', 'eagle') then 'pcb'   -- P-CAD / gEDA
    when lower(p_name) ~ '\.json$' and p_tool = 'easyeda' then 'pcb'
    when lower(p_name) ~ '\.(step|stp|iges|igs|stl)$' then 'mcad'
    else null end
$$;

create function public.create_design_import(p_project_id uuid, p_title text, p_source_tool text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v uuid;
begin
  if not public.has_project_role(p_project_id, '{owner,engineer}') then
    raise exception 'only owners and engineers of the project can import earlier work' using errcode = '42501';
  end if;
  v := public.create_flux_audit(p_project_id, p_title);
  update public.flux_audits set source_tool = coalesce(nullif(p_source_tool, ''), 'other') where id = v;
  return v;
end;
$$;

-- Queues the conversions for an import's native files (owners and engineers); returns how many were queued.
create function public.queue_import_conversions(p_audit_id uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare a public.flux_audits; n integer;
begin
  a := public.flux_audit_for_staff(p_audit_id);
  if not public.has_project_role(a.project_id, '{owner,engineer}') then raise exception 'not permitted' using errcode = '42501'; end if;
  insert into public.import_conversions (audit_id, file_id, project_id, kind)
  select a.id, f.id, a.project_id, public.import_file_kind(f.name, a.source_tool)
    from public.flux_audit_files f where f.audit_id = a.id and public.import_file_kind(f.name, a.source_tool) is not null
  on conflict (file_id) do update set status = 'queued', error = null, attempts = 0, claimed_by = null
    where public.import_conversions.status = 'failed';
  get diagnostics n = row_count;
  return n;
end;
$$;

create function public.claim_import_conversion(p_worker_id text, p_stale_seconds integer default 1200)
returns table (id uuid, audit_id uuid, project_id uuid, kind text, file_name text, storage_path text, sha256 text, source_tool text)
language plpgsql security definer set search_path = '' as $$
declare v public.import_conversions;
begin
  update public.import_conversions c set status = 'failed', error = 'gave up after 3 attempts', claimed_by = null, completed_at = now()
   where c.status = 'running' and c.claimed_at < now() - make_interval(secs => p_stale_seconds) and c.attempts >= 3;
  select * into v from public.import_conversions c
   where c.status = 'queued' or (c.status = 'running' and c.claimed_at < now() - make_interval(secs => p_stale_seconds))
   order by c.created_at for update skip locked limit 1;
  if v.id is null then return; end if;
  update public.import_conversions c set status = 'running', claimed_by = p_worker_id, claimed_at = now(), attempts = c.attempts + 1 where c.id = v.id;
  return query select v.id, v.audit_id, v.project_id, v.kind, f.name, f.storage_path, f.sha256, a.source_tool
    from public.flux_audit_files f join public.flux_audits a on a.id = f.audit_id where f.id = v.file_id;
end;
$$;

create function public.complete_import_conversion(p_id uuid, p_worker_id text, p_result jsonb, p_output_path text, p_error text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare v public.import_conversions;
begin
  select * into v from public.import_conversions where id = p_id for update;
  if v.status <> 'running' or v.claimed_by is distinct from p_worker_id then
    raise exception 'conversion % is not being run by %', p_id, p_worker_id using hint = 'lease_lost';
  end if;
  update public.import_conversions set status = case when p_error is null then 'ready' else 'failed' end, result = coalesce(p_result, '{}'),
         output_path = p_output_path, error = p_error, claimed_by = null, completed_at = now() where id = p_id;
  perform public.worker_audit(v.project_id, case when p_error is null then 'import.converted' else 'import.conversion_failed' end,
                              'import_conversion', v.id, jsonb_build_object('error', p_error));
end;
$$;

revoke all on function public.create_design_import(uuid, text, text), public.queue_import_conversions(uuid),
  public.claim_import_conversion(text, integer), public.complete_import_conversion(uuid, text, jsonb, text, text),
  public.import_file_kind(text, text) from public, anon;
grant execute on function public.create_design_import(uuid, text, text), public.queue_import_conversions(uuid), public.import_file_kind(text, text) to authenticated;
grant execute on function public.claim_import_conversion(text, integer), public.complete_import_conversion(uuid, text, jsonb, text, text) to service_role;
