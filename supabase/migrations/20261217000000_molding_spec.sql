-- Injection molding spec per part route: pull direction, mold finish, cosmetic faces, tolerances, critical dimensions,
-- gate notes, inserts, material grade, flammability, cavities. Used for the design check and the mold maker's package.
alter table public.part_routes add column molding jsonb not null default '{}'::jsonb check (jsonb_typeof(molding) = 'object');

create function public.save_part_molding(p_id uuid, p_molding jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare v_project uuid;
begin
  select project_id into v_project from public.part_routes where id = p_id;
  if v_project is null then raise exception 'route not found'; end if;
  perform public.need_role(v_project, '{owner,engineer}', 'edit molding specs');
  if jsonb_typeof(coalesce(p_molding, '{}'::jsonb)) <> 'object' then raise exception 'the molding spec must be an object'; end if;
  if length(p_molding::text) > 20000 then raise exception 'the molding spec is too long'; end if;
  if (p_molding ->> 'pull') is not null and (p_molding ->> 'pull') not in ('+x', '-x', '+y', '-y', '+z', '-z') then
    raise exception 'unknown pull direction %', p_molding ->> 'pull';
  end if;
  update public.part_routes set molding = jsonb_strip_nulls(p_molding) where id = p_id;
  perform public.worker_audit(v_project, 'part_route.molding_saved', 'part_route', p_id, '{}'::jsonb);
end;
$$;
revoke all on function public.save_part_molding(uuid, jsonb) from public, anon;
grant execute on function public.save_part_molding(uuid, jsonb) to authenticated;
