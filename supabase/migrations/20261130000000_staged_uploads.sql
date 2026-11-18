-- Deployment: large uploads go from the browser straight to storage (hosted server functions cap request bodies at a
-- few MB). StagedFileInput puts the file in a staging folder; the server action reads it back as the user, checks and
-- stores it as before, then removes the staged copy. Staging folders: {project}/uploads/ in project-files (owners and
-- engineers may already write anywhere in their project's folder) and staging/ in knowledge-files (editors).

do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    -- People may remove their own staged files (and nothing else in the folder).
    create policy "uploaders remove their staged files" on storage.objects for delete to authenticated
      using (bucket_id = 'project-files' and split_part(name, '/', 2) = 'uploads'
             and owner_id = (select auth.uid())::text
             and public.has_project_role(public.storage_path_project_id(name), '{owner,engineer}'));
  end if;
end;
$$;

-- Staged files left behind (a closed tab, a refused upload's form never submitted) are swept by the worker.
create function public.worker_stale_staged_uploads(p_older_than interval default '1 hour', p_limit integer default 200)
returns table (bucket text, path text)
language plpgsql stable security definer set search_path = '' as $$
begin
  return query
    select o.bucket_id::text, o.name::text from storage.objects o
     where ((o.bucket_id = 'project-files' and split_part(o.name, '/', 2) = 'uploads')
         or (o.bucket_id = 'knowledge-files' and split_part(o.name, '/', 1) = 'staging'))
       and o.created_at < now() - p_older_than
     order by o.created_at
     limit p_limit;
end;
$$;
revoke all on function public.worker_stale_staged_uploads(interval, integer) from public, anon, authenticated;
grant execute on function public.worker_stale_staged_uploads(interval, integer) to service_role;
