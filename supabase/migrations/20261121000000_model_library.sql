-- Manufacturer 3D model library (owner decision 17 Nov 2026).
--
-- A model is registered for a part by a project (upload, URL, or a distributor CAD link found while
-- sourcing). A worker with the engineering image checks it against the KiCad footprint and writes an
-- aligned STEP plus an overlay drawing; a person then verifies or rejects it. Only verified models
-- replace KiCad's generic models in layouts.
--
-- Models stay private to the project that registered them unless marked shared (public manufacturer
-- CAD): an OEM's CAD under NDA must never reach another project.

drop table public.part_models;

create type public.model_status as enum ('pending', 'checking', 'checked', 'inconclusive', 'check_failed', 'verified', 'rejected');
create type public.model_source as enum ('upload', 'url', 'nexar');

create table public.part_models (
  id               uuid primary key default gen_random_uuid(),
  part_id          uuid not null references public.parts(id) on delete cascade,
  project_id       uuid not null references public.projects(id) on delete cascade,
  shared           boolean not null default false,       -- public manufacturer CAD usable by other projects
  footprint        text not null,                        -- KiCad footprint it is checked against, Library:Name
  status           public.model_status not null default 'pending',
  source_kind      public.model_source not null,
  source           text not null,                        -- who published it: manufacturer site, SnapEDA via Nexar, OEM drawing pack
  source_url       text,
  license          text,
  original_path    text,                                 -- the file as received (project-files bucket)
  original_sha256  text,
  storage_path     text,                                 -- aligned STEP: footprint origin, Y up, seating plane at Z = 0
  sha256           text,
  overlay_path     text,                                 -- top-view overlay SVG for the person verifying
  check_result     jsonb not null default '{}'::jsonb,
  mechanical       jsonb not null default '{}'::jsonb,   -- datasheet input (height_mm ...) and measured body size
  error            text,
  attempts         integer not null default 0,
  claimed_by       text,
  claimed_at       timestamptz,
  requested_by     uuid references auth.users(id) on delete set null,
  verified_by      uuid references auth.users(id) on delete set null,
  verified_at      timestamptz,
  decision_note    text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index part_models_part_idx on public.part_models (part_id, status);
create index part_models_queue_idx on public.part_models (status, created_at) where status in ('pending', 'checking');
create unique index part_models_unique_source on public.part_models (project_id, part_id, footprint, coalesce(original_sha256, source_url));

alter table public.part_models enable row level security;
create policy "read shared or own project models" on public.part_models for select to authenticated
  using (shared or public.is_project_member(project_id));
grant select on public.part_models to authenticated;
grant all on public.part_models to service_role;
create trigger part_models_updated_at before update on public.part_models
  for each row execute function public.set_updated_at();

-- Register a model for checking. Engineers and owners of the project, or a worker (service role).
create function public.register_part_model(
  p_project_id uuid, p_mpn text, p_manufacturer text, p_normalized_mpn text, p_normalized_mfr text, p_footprint text,
  p_source_kind public.model_source, p_source text, p_source_url text default null, p_license text default null,
  p_original_path text default null, p_shared boolean default false, p_mechanical jsonb default '{}'::jsonb
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_part uuid;
  v_id uuid;
begin
  if auth.uid() is not null and not public.has_project_role(p_project_id, '{owner,engineer}') then
    raise exception 'only owners and engineers of the project can add 3D models' using errcode = '42501';
  end if;
  if coalesce(trim(p_mpn), '') = '' or coalesce(trim(p_manufacturer), '') = '' then
    raise exception 'a 3D model needs the part number and manufacturer it belongs to';
  end if;
  if p_footprint !~ '^[^:]+:[^:]+$' then
    raise exception 'footprint must be a KiCad Library:Name, got %', p_footprint;
  end if;
  if p_source_kind = 'upload' and (p_original_path is null or split_part(p_original_path, '/', 1) <> p_project_id::text) then
    raise exception 'an uploaded model must be a file in this project''s storage';
  end if;
  if p_source_kind in ('url', 'nexar') and coalesce(p_source_url, '') !~ '^https://' then
    raise exception 'a model fetched from the web needs an https URL';
  end if;

  insert into public.parts (mpn, normalized_mpn, manufacturer, normalized_mfr, sources)
  values (p_mpn, p_normalized_mpn, p_manufacturer, p_normalized_mfr, array[p_source_kind::text])
  on conflict (normalized_mpn, normalized_mfr) do update set updated_at = now()
  returning id into v_part;

  insert into public.part_models (part_id, project_id, shared, footprint, source_kind, source, source_url, license,
                                  original_path, mechanical, requested_by)
  values (v_part, p_project_id, coalesce(p_shared, false), p_footprint, p_source_kind, p_source, p_source_url, p_license,
          p_original_path, coalesce(p_mechanical, '{}'::jsonb), auth.uid())
  on conflict (project_id, part_id, footprint, coalesce(original_sha256, source_url)) do nothing
  returning id into v_id;
  if v_id is null then   -- the same URL was already registered for this part and footprint
    select id into v_id from public.part_models
     where project_id = p_project_id and part_id = v_part and footprint = p_footprint and source_url = p_source_url;
    return v_id;
  end if;
  perform public.worker_audit(p_project_id, 'part_model.registered', 'part_model', v_id,
                              jsonb_build_object('mpn', p_mpn, 'footprint', p_footprint, 'source', p_source_kind));
  return v_id;
end;
$$;
revoke all on function public.register_part_model from public, anon;
grant execute on function public.register_part_model to authenticated, service_role;

-- Workers: claim the next model to check (stale claims are reclaimed; three failed tries give up).
create function public.claim_model_check(p_worker_id text, p_stale_seconds integer default 900) returns public.part_models
language plpgsql security definer set search_path = '' as $$
declare
  v public.part_models;
begin
  update public.part_models set status = 'check_failed', error = 'gave up after 3 attempts'
   where status = 'checking' and claimed_at < now() - make_interval(secs => p_stale_seconds) and attempts >= 3;
  select * into v from public.part_models
   where status = 'pending' or (status = 'checking' and claimed_at < now() - make_interval(secs => p_stale_seconds))
   order by created_at for update skip locked limit 1;
  if v.id is null then return null; end if;
  update public.part_models set status = 'checking', claimed_by = p_worker_id, claimed_at = now(), attempts = attempts + 1
   where id = v.id returning * into v;
  return v;
end;
$$;

create function public.complete_model_check(
  p_id uuid, p_worker_id text, p_status public.model_status, p_check jsonb, p_error text default null,
  p_original_path text default null, p_original_sha256 text default null, p_storage_path text default null,
  p_sha256 text default null, p_overlay_path text default null, p_mechanical jsonb default null
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v public.part_models;
begin
  if p_status not in ('checked', 'inconclusive', 'check_failed') then
    raise exception 'a check ends checked, inconclusive or check_failed';
  end if;
  select * into v from public.part_models where id = p_id for update;
  if v.status <> 'checking' or v.claimed_by is distinct from p_worker_id then
    raise exception 'model % is not being checked by %', p_id, p_worker_id using hint = 'lease_lost';
  end if;
  update public.part_models set
    status = p_status, check_result = coalesce(p_check, '{}'::jsonb), error = p_error,
    original_path = coalesce(p_original_path, original_path), original_sha256 = coalesce(p_original_sha256, original_sha256),
    storage_path = p_storage_path, sha256 = p_sha256, overlay_path = p_overlay_path,
    mechanical = mechanical || coalesce(p_mechanical, '{}'::jsonb), claimed_by = null
   where id = p_id;
  perform public.worker_audit(v.project_id, 'part_model.checked', 'part_model', p_id,
                              jsonb_build_object('status', p_status, 'error', p_error));
end;
$$;

revoke all on function public.claim_model_check(text, integer) from public, anon, authenticated;
revoke all on function public.complete_model_check(uuid, text, public.model_status, jsonb, text, text, text, text, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.claim_model_check(text, integer) to service_role;
grant execute on function public.complete_model_check(uuid, text, public.model_status, jsonb, text, text, text, text, text, text, jsonb)
  to service_role;

-- A person verifies (or rejects) a checked model after looking at the overlay.
create function public.decide_part_model(p_id uuid, p_approve boolean, p_note text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v public.part_models;
begin
  select * into v from public.part_models where id = p_id for update;
  if v.id is null or not public.has_project_role(v.project_id, '{owner,engineer,reviewer}') then
    raise exception 'only owners, engineers and reviewers of the project can verify its 3D models' using errcode = '42501';
  end if;
  if p_approve and v.status not in ('checked', 'inconclusive') then
    raise exception 'only a model that passed (or could not complete) the automatic check can be verified; this one is %', v.status;
  end if;
  if p_approve and v.status = 'inconclusive' and coalesce(trim(p_note), '') = '' then
    raise exception 'verifying an inconclusive check needs a note saying what was confirmed by eye';
  end if;
  if not p_approve and v.status not in ('checked', 'inconclusive', 'check_failed', 'verified') then
    raise exception 'a model that is % cannot be rejected', v.status;
  end if;
  update public.part_models set status = case when p_approve then 'verified' else 'rejected' end::public.model_status,
         verified_by = auth.uid(), verified_at = now(), decision_note = p_note
   where id = p_id;
  perform public.worker_audit(v.project_id, case when p_approve then 'part_model.verified' else 'part_model.rejected' end,
                              'part_model', p_id, jsonb_build_object('note', p_note));
end;
$$;
revoke all on function public.decide_part_model(uuid, boolean, text) from public, anon;
grant execute on function public.decide_part_model(uuid, boolean, text) to authenticated;
