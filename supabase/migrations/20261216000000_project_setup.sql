-- Guided project setup: a short project code and a product class, and one RPC to edit the project's identity.
alter table public.projects add column code text check (code is null or code ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,23}$');
alter table public.projects add column product_class text check (product_class is null or product_class in
  ('handheld', 'wearable', 'iot_sensor', 'desktop_av', 'industrial', 'automotive', 'medical', 'other'));

create function public.update_project_identity(p_project uuid, p_name text, p_description text, p_code text, p_product_class text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.need_role(p_project, '{owner,engineer}', 'edit the project');
  if length(trim(coalesce(p_name, ''))) = 0 then raise exception 'the project needs a name'; end if;
  update public.projects set name = trim(p_name), description = nullif(trim(coalesce(p_description, '')), ''),
         code = nullif(trim(coalesce(p_code, '')), ''), product_class = nullif(p_product_class, '')
   where id = p_project;
  perform public.worker_audit(p_project, 'project.identity_saved', 'project', p_project, jsonb_build_object('name', trim(p_name), 'class', p_product_class));
end;
$$;
revoke all on function public.update_project_identity(uuid, text, text, text, text) from public, anon;
grant execute on function public.update_project_identity(uuid, text, text, text, text) to authenticated;
