-- Manufacturing routes: for each physical part, how it is made now (prototype: printed, cast or machined) and later
-- (production: injection molded, machined, sheet metal, cast). The plan and the enclosure design read them, so a
-- printed prototype is designed for its production process from the start.

create table public.part_routes (
  id                  uuid primary key default gen_random_uuid(),
  project_id          uuid not null references public.projects (id) on delete cascade,
  name                text not null check (length(trim(name)) between 1 and 120),
  -- Where the part's model comes from: "artifact:<task key>/<part>" (a generated enclosure part),
  -- "ref:<project_references id>" (an uploaded model), or null (not modelled yet).
  source_key          text check (source_key is null or source_key ~ '^(artifact|ref):.{1,200}$'),
  needs               jsonb not null default '{}'::jsonb,
  prototype_option    text check (prototype_option is null or length(prototype_option) <= 60),
  prototype_qty       integer check (prototype_qty is null or prototype_qty between 1 and 100000),
  production_process  text check (production_process is null or production_process in
                        ('injection_molding', 'cnc', 'sheet_metal', 'die_casting', 'urethane_cast', 'same_as_prototype')),
  production_material text check (production_material is null or length(production_material) <= 60),
  production_volume   integer check (production_volume is null or production_volume between 1 and 100000000),
  finish              text check (finish is null or length(finish) <= 300),
  notes               text check (notes is null or length(notes) <= 4000),
  created_by          uuid references auth.users (id) on delete set null default auth.uid(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (project_id, name)
);
create unique index part_routes_source_idx on public.part_routes (project_id, source_key) where source_key is not null;
create trigger part_routes_updated_at before update on public.part_routes for each row execute function public.set_updated_at();
alter table public.part_routes enable row level security;
create policy "members read part routes" on public.part_routes for select to authenticated using (public.is_project_member(project_id));
grant select on public.part_routes to authenticated;
grant all on public.part_routes to service_role;

create function public.save_part_route(p_project uuid, p_id uuid, p_name text, p_source_key text, p_needs jsonb, p_prototype_option text,
                                       p_prototype_qty integer, p_production_process text, p_production_material text,
                                       p_production_volume integer, p_finish text, p_notes text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid := p_id;
begin
  perform public.need_role(p_project, '{owner,engineer}', 'set manufacturing routes');
  if jsonb_typeof(coalesce(p_needs, '{}'::jsonb)) <> 'object' then raise exception 'needs must be an object'; end if;
  if p_source_key like 'ref:%' and not exists (select 1 from public.project_references
       where project_id = p_project and id::text = substr(p_source_key, 5)) then
    raise exception 'the model file is not in this project';
  end if;
  if exists (select 1 from public.part_routes where project_id = p_project and lower(trim(name)) = lower(trim(p_name)) and id is distinct from p_id) then
    raise exception 'a part named % already has a route', trim(p_name);
  end if;
  if v_id is null then
    insert into public.part_routes (project_id, name, source_key, needs, prototype_option, prototype_qty, production_process, production_material,
                                    production_volume, finish, notes)
    values (p_project, trim(p_name), nullif(p_source_key, ''), coalesce(p_needs, '{}'::jsonb), nullif(p_prototype_option, ''), p_prototype_qty,
            nullif(p_production_process, ''), nullif(p_production_material, ''), p_production_volume, nullif(trim(coalesce(p_finish, '')), ''),
            nullif(trim(coalesce(p_notes, '')), ''))
    returning id into v_id;
  else
    update public.part_routes set name = trim(p_name), needs = coalesce(p_needs, '{}'::jsonb), prototype_option = nullif(p_prototype_option, ''),
           prototype_qty = p_prototype_qty, production_process = nullif(p_production_process, ''), production_material = nullif(p_production_material, ''),
           production_volume = p_production_volume, finish = nullif(trim(coalesce(p_finish, '')), ''), notes = nullif(trim(coalesce(p_notes, '')), '')
     where id = v_id and project_id = p_project;
    if not found then raise exception 'route not found'; end if;
  end if;
  perform public.worker_audit(p_project, 'part_route.saved', 'part_route', v_id,
    jsonb_build_object('name', p_name, 'prototype', p_prototype_option, 'production', p_production_process, 'material', p_production_material));
  return v_id;
end;
$$;

create function public.remove_part_route(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_project uuid;
begin
  select project_id into v_project from public.part_routes where id = p_id;
  if v_project is null then raise exception 'route not found'; end if;
  perform public.need_role(v_project, '{owner,engineer}', 'remove manufacturing routes');
  delete from public.part_routes where id = p_id;
end;
$$;

revoke all on function public.save_part_route(uuid, uuid, text, text, jsonb, text, integer, text, text, integer, text, text),
  public.remove_part_route(uuid) from public, anon;
grant execute on function public.save_part_route(uuid, uuid, text, text, jsonb, text, integer, text, text, integer, text, text),
  public.remove_part_route(uuid) to authenticated;
