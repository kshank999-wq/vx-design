-- "To do for you": files the owner can fetch from manufacturers' websites (datasheets, 3D STEP models, drawings) while
-- the parts-supplier connections are not available. Design steps ask for them (the digest's file requests) and the
-- important parts of the parts list without a 3D model or a datasheet are added automatically. An item is done when
-- the owner uploads a matching file, or marks it done or not needed.
create table if not exists public.owner_file_tasks (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references public.projects(id) on delete cascade,
  kind         text not null check (kind in ('datasheet', '3d_model', 'drawing', 'other')),
  mpn          text,
  manufacturer text,
  title        text not null check (length(title) between 3 and 300),
  why          text,
  where_to_look text,
  task_id      uuid references public.tasks(id) on delete set null,
  status       text not null default 'open' check (status in ('open', 'done', 'not_needed')),
  created_at   timestamptz not null default now(),
  closed_at    timestamptz
);
create unique index if not exists owner_file_tasks_one on public.owner_file_tasks (project_id, kind, lower(coalesce(mpn, title)));
alter table public.owner_file_tasks enable row level security;
revoke all on public.owner_file_tasks from anon;
grant select, update on public.owner_file_tasks to authenticated;
grant all on public.owner_file_tasks to service_role;
create policy owner_file_tasks_read on public.owner_file_tasks for select to authenticated using (public.is_project_member(project_id));
create policy owner_file_tasks_close on public.owner_file_tasks for update to authenticated
  using (public.has_project_role(project_id, '{owner,engineer}')) with check (public.has_project_role(project_id, '{owner,engineer}'));

-- The parts list's important parts (connectors, chips, modules, crystals, switches, displays, batteries) that have no
-- 3D model and no datasheet file yet; and closing items whose file has been uploaded since.
create or replace function public.refresh_owner_file_tasks(p_project uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer := 0; bom uuid;
begin
  if not public.has_project_role(p_project, '{owner,engineer}') then raise exception 'not permitted' using errcode = '42501'; end if;
  -- Close items whose file is here now (a file attached to a part with that part number, of the right kind).
  update public.owner_file_tasks f set status = 'done', closed_at = now()
   where f.project_id = p_project and f.status = 'open' and f.mpn is not null and exists (
     select 1 from public.project_references r join public.project_parts p on p.id = r.part_id
      where r.project_id = p_project and lower(p.mpn) = lower(f.mpn)
        and ((f.kind = '3d_model' and r.kind = 'model_3d') or (f.kind = 'datasheet' and r.kind = 'datasheet') or (f.kind not in ('3d_model', 'datasheet'))));
  select bom_version_id into bom from public.project_bom_parts where project_id = p_project order by loaded_at desc limit 1;
  if bom is null then return 0; end if;
  insert into public.owner_file_tasks (project_id, kind, mpn, manufacturer, title, why, where_to_look)
  select p_project, '3d_model', b.mpn, b.manufacturer,
         format('Get the 3D model (STEP file) for %s%s', b.mpn, coalesce(' by ' || b.manufacturer, '')),
         format('Used by %s on the board: with its real shape the casing and fit checks are exact.', array_to_string(b.refs[1:4], ', ')),
         'The manufacturer''s product page for this part number, usually under Downloads, CAD or 3D model (STEP).'
    from public.project_bom_parts b
   where b.project_id = p_project and b.bom_version_id = bom
     and exists (select 1 from unnest(b.refs) r where r ~ '^(J|U|Y|X|SW|DS|BT|M|LCD|MOD|P|CN)[0-9]')
     and not exists (select 1 from public.part_models m where m.part_id = b.part_id and m.status in ('verified', 'checked'))
     and not exists (select 1 from public.project_references r join public.project_parts p on p.id = r.part_id
                      where r.project_id = p_project and lower(p.mpn) = lower(b.mpn) and r.kind = 'model_3d')
  on conflict do nothing;
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke all on function public.refresh_owner_file_tasks(uuid) from public, anon;
grant execute on function public.refresh_owner_file_tasks(uuid) to authenticated;
