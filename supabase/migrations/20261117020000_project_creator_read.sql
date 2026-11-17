-- INSERT ... RETURNING checks the new row against SELECT policies before the
-- after-insert trigger adds the creator's membership row, so creating a project
-- through the API failed. The creator can always read their own project.
drop policy "members read projects" on public.projects;
create policy "members read projects" on public.projects for select to authenticated
  using (created_by = auth.uid() or public.is_project_member(id));
