-- Adds "get the 3D model" to-dos for the boards' important parts (read by the web app from the circuit designs), skipping
-- parts whose 3D model the owner already uploaded. Items already on the list (or closed) are left as they are.
create or replace function public.add_owner_file_tasks(p_project uuid, p_items jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  if not public.has_project_role(p_project, '{owner,engineer}') then raise exception 'not permitted' using errcode = '42501'; end if;
  insert into public.owner_file_tasks (project_id, kind, mpn, manufacturer, title, why, where_to_look)
  select p_project, coalesce(i->>'kind', '3d_model'), nullif(i->>'mpn', ''), nullif(i->>'manufacturer', ''), left(i->>'title', 300), left(i->>'why', 600), left(i->>'where_to_look', 600)
    from jsonb_array_elements(p_items) i
   where length(coalesce(i->>'title', '')) >= 3
     and not exists (select 1 from public.project_references r join public.project_parts pp on pp.id = r.part_id
                      where r.project_id = p_project and lower(pp.mpn) = lower(i->>'mpn') and r.kind = 'model_3d')
  on conflict do nothing;
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke all on function public.add_owner_file_tasks(uuid, jsonb) from public, anon;
grant execute on function public.add_owner_file_tasks(uuid, jsonb) to authenticated;
