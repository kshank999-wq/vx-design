-- Prior-work register: what earlier work already exists, item by item. A worker reads every prior-work document in
-- full (the design documents inside Flux imports used for the plan, and the project's prior-design files and
-- datasheets) and records parts selected, circuits designed, layout done, decisions and open issues, each with a
-- verbatim quote from its source. People correct it (status, exclude, note). The planner must then address every
-- item already selected, designed or laid out: keep it, revise it, or replace it with reasons and alternatives.

create table public.prior_work_registers (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references public.projects (id) on delete cascade,
  status        text not null default 'queued' check (status in ('queued', 'running', 'ready', 'failed')),
  items         jsonb not null default '[]'::jsonb,     -- [{id: "PR-1", subsystem, kind, title, detail, mpn, status, issues, sources: [{file, quote}]}]
  sources       jsonb not null default '[]'::jsonb,     -- documents read: [{file, origin, chars, items, error?}]
  edits         jsonb not null default '{}'::jsonb,     -- {"PR-1": {status?, note?, excluded?}} made by people
  model         text,
  usage         jsonb not null default '[]'::jsonb,
  error         text,
  progress      text,
  attempts      integer not null default 0,
  claimed_by    text,
  claimed_at    timestamptz,
  requested_by  uuid references auth.users (id) on delete set null default auth.uid(),
  created_at    timestamptz not null default now(),
  completed_at  timestamptz
);
create index prior_work_registers_queue_idx on public.prior_work_registers (status, created_at) where status in ('queued', 'running');
alter table public.prior_work_registers enable row level security;
create policy "members read prior work registers" on public.prior_work_registers for select to authenticated using (public.is_project_member(project_id));
grant select on public.prior_work_registers to authenticated;
grant all on public.prior_work_registers to service_role;

-- Parts already chosen, entered by people, with their files (datasheets, STEP models, drawings) attached as
-- references. They go into the register as stated by the owner: authoritative over anything read from documents.
create table public.project_parts (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references public.projects (id) on delete cascade,
  mpn           text not null check (length(trim(mpn)) between 1 and 120),
  manufacturer  text check (manufacturer is null or length(manufacturer) <= 120),
  role          text not null check (length(trim(role)) between 1 and 300),     -- what it is for
  subsystem     text not null default 'other',
  status        text not null default 'selected' check (status in ('candidate', 'selected', 'designed', 'laid_out', 'verified', 'rejected')),
  note          text check (note is null or length(note) <= 4000),
  created_by    uuid references auth.users (id) on delete set null default auth.uid(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create unique index project_parts_mpn_idx on public.project_parts (project_id, upper(regexp_replace(mpn, '[^A-Za-z0-9]', '', 'g')));
create trigger project_parts_updated_at before update on public.project_parts for each row execute function public.set_updated_at();
alter table public.project_parts enable row level security;
create policy "members read project parts" on public.project_parts for select to authenticated using (public.is_project_member(project_id));
grant select on public.project_parts to authenticated;
grant all on public.project_parts to service_role;
alter table public.project_references add column part_id uuid references public.project_parts (id) on delete set null;

create function public.save_project_part(p_project uuid, p_id uuid, p_mpn text, p_manufacturer text, p_role text, p_subsystem text,
                                         p_status text, p_note text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid := p_id;
begin
  perform public.need_role(p_project, '{owner,engineer}', 'record chosen parts');
  if v_id is null then
    if exists (select 1 from public.project_parts where project_id = p_project
                and upper(regexp_replace(mpn, '[^A-Za-z0-9]', '', 'g')) = upper(regexp_replace(p_mpn, '[^A-Za-z0-9]', '', 'g'))) then
      raise exception 'part % is already listed', p_mpn;
    end if;
    insert into public.project_parts (project_id, mpn, manufacturer, role, subsystem, status, note)
    values (p_project, trim(p_mpn), nullif(trim(coalesce(p_manufacturer, '')), ''), trim(p_role), coalesce(nullif(p_subsystem, ''), 'other'),
            coalesce(p_status, 'selected'), nullif(trim(coalesce(p_note, '')), ''))
    returning id into v_id;
    perform public.worker_audit(p_project, 'part.recorded', 'project_part', v_id, jsonb_build_object('mpn', p_mpn, 'status', p_status));
  else
    update public.project_parts set mpn = trim(p_mpn), manufacturer = nullif(trim(coalesce(p_manufacturer, '')), ''), role = trim(p_role),
           subsystem = coalesce(nullif(p_subsystem, ''), 'other'), status = coalesce(p_status, status), note = nullif(trim(coalesce(p_note, '')), '')
     where id = v_id and project_id = p_project;
    if not found then raise exception 'part not found'; end if;
  end if;
  return v_id;
end;
$$;

create function public.remove_project_part(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_project uuid;
begin
  select project_id into v_project from public.project_parts where id = p_id;
  if v_project is null then raise exception 'part not found'; end if;
  perform public.need_role(v_project, '{owner,engineer}', 'remove chosen parts');
  delete from public.project_parts where id = p_id;
end;
$$;

-- Attach an uploaded reference file to a part (the file stays a reference: REF-n).
create function public.attach_reference_to_part(p_reference uuid, p_part uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.project_references;
begin
  select * into r from public.project_references where id = p_reference;
  if r.id is null then raise exception 'reference not found'; end if;
  perform public.need_role(r.project_id, '{owner,engineer}', 'attach files to parts');
  if p_part is not null and not exists (select 1 from public.project_parts where id = p_part and project_id = r.project_id) then
    raise exception 'part not found in this project';
  end if;
  update public.project_references set part_id = p_part where id = p_reference;
end;
$$;

revoke all on function public.save_project_part(uuid, uuid, text, text, text, text, text, text), public.remove_project_part(uuid),
  public.attach_reference_to_part(uuid, uuid) from public, anon;
grant execute on function public.save_project_part(uuid, uuid, text, text, text, text, text, text), public.remove_project_part(uuid),
  public.attach_reference_to_part(uuid, uuid) to authenticated;

-- A task may replace earlier work (with concerns and alternatives).
alter table public.tasks drop constraint if exists tasks_basis_check;
alter table public.tasks add constraint tasks_basis_check check (basis is null or (basis ->> 'mode') in ('reuse', 'adapt', 'replace', 'new'));

create function public.request_prior_work_register(p_project uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform public.need_role(p_project, '{owner,engineer}', 'build the prior-work register');
  perform pg_advisory_xact_lock(hashtext('prior-work:' || p_project::text));
  if exists (select 1 from public.prior_work_registers where project_id = p_project and status in ('queued', 'running')) then
    raise exception 'the prior-work register is already being built; wait for it to finish';
  end if;
  insert into public.prior_work_registers (project_id) values (p_project) returning id into v_id;
  perform public.worker_audit(p_project, 'prior_work.requested', 'prior_work_register', v_id, '{}'::jsonb);
  return v_id;
end;
$$;

create function public.claim_prior_work_register(p_worker_id text, p_stale_seconds integer default 3600) returns public.prior_work_registers
language plpgsql security definer set search_path = '' as $$
declare v public.prior_work_registers;
begin
  update public.prior_work_registers set status = 'failed', error = 'gave up after 3 attempts', claimed_by = null, completed_at = now()
   where status = 'running' and claimed_at < now() - make_interval(secs => p_stale_seconds) and attempts >= 3;
  select * into v from public.prior_work_registers
   where status = 'queued' or (status = 'running' and claimed_at < now() - make_interval(secs => p_stale_seconds))
   order by created_at for update skip locked limit 1;
  if v.id is null then return null; end if;
  update public.prior_work_registers set status = 'running', claimed_by = p_worker_id, claimed_at = now(), attempts = attempts + 1, progress = null
   where id = v.id returning * into v;
  return v;
end;
$$;

create function public.progress_prior_work_register(p_id uuid, p_worker_id text, p_progress text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.prior_work_registers set progress = left(p_progress, 300), claimed_at = now()
   where id = p_id and status = 'running' and claimed_by = p_worker_id;
end;
$$;

-- Edits carry over from the previous register by item key (subsystem + part number or title), so a rebuild keeps
-- what people corrected.
create function public.complete_prior_work_register(p_id uuid, p_worker_id text, p_items jsonb, p_sources jsonb, p_model text, p_usage jsonb,
                                                    p_error text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.prior_work_registers; prev public.prior_work_registers; carried jsonb := '{}'::jsonb; it jsonb; pit jsonb;
begin
  select * into v from public.prior_work_registers where id = p_id for update;
  if v.status <> 'running' or v.claimed_by is distinct from p_worker_id then raise exception 'prior-work register % is not held by this worker', p_id; end if;
  if p_error is not null then
    update public.prior_work_registers set status = 'failed', error = left(p_error, 2000), model = p_model, usage = coalesce(p_usage, '[]'), completed_at = now(), claimed_by = null
     where id = p_id;
    return;
  end if;
  select * into prev from public.prior_work_registers where project_id = v.project_id and status = 'ready' and id <> p_id order by completed_at desc limit 1;
  if prev.id is not null and prev.edits <> '{}'::jsonb then
    for it in select * from jsonb_array_elements(p_items) loop
      for pit in select * from jsonb_array_elements(prev.items) loop
        if pit ->> 'key' = it ->> 'key' and prev.edits ? (pit ->> 'id') then
          carried := carried || jsonb_build_object(it ->> 'id', prev.edits -> (pit ->> 'id'));
        end if;
      end loop;
    end loop;
  end if;
  update public.prior_work_registers set status = 'ready', items = p_items, sources = p_sources, edits = carried, model = p_model, usage = coalesce(p_usage, '[]'),
         error = null, progress = null, completed_at = now(), claimed_by = null where id = p_id;
  perform public.worker_audit(v.project_id, 'prior_work.built', 'prior_work_register', p_id, jsonb_build_object('items', jsonb_array_length(p_items), 'documents', jsonb_array_length(p_sources)));
end;
$$;

create function public.edit_prior_work_item(p_register uuid, p_item text, p_status text, p_note text, p_excluded boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.prior_work_registers;
begin
  select * into v from public.prior_work_registers where id = p_register for update;
  if v.id is null then raise exception 'register not found'; end if;
  perform public.need_role(v.project_id, '{owner,engineer}', 'correct the prior-work register');
  if v.status <> 'ready' then raise exception 'the register is not ready'; end if;
  if not exists (select 1 from jsonb_array_elements(v.items) i where i ->> 'id' = p_item) then raise exception 'no item %', p_item; end if;
  if p_status is not null and p_status not in ('considered', 'selected', 'designed', 'laid_out', 'verified', 'rejected', 'open') then
    raise exception 'unknown status %', p_status;
  end if;
  update public.prior_work_registers set edits = edits || jsonb_build_object(p_item, jsonb_strip_nulls(jsonb_build_object(
           'status', p_status, 'note', nullif(trim(coalesce(p_note, '')), ''), 'excluded', case when p_excluded then true end)))
   where id = p_register;
end;
$$;

revoke all on function public.request_prior_work_register(uuid), public.edit_prior_work_item(uuid, text, text, text, boolean) from public, anon;
grant execute on function public.request_prior_work_register(uuid), public.edit_prior_work_item(uuid, text, text, text, boolean) to authenticated;
revoke all on function public.claim_prior_work_register(text, integer), public.progress_prior_work_register(uuid, text, text),
  public.complete_prior_work_register(uuid, text, jsonb, jsonb, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.claim_prior_work_register(text, integer), public.progress_prior_work_register(uuid, text, text),
  public.complete_prior_work_register(uuid, text, jsonb, jsonb, text, jsonb, text) to service_role;
