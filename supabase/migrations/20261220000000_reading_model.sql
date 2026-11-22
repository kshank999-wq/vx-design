-- Which model reads a project's specifications and part datasheets, and side-by-side comparisons of models on one
-- specification (nothing is saved as requirements; the results are kept for the team to judge).
alter table public.projects
  add column reading_model text check (reading_model in ('claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'));

create table public.model_comparisons (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references public.projects (id) on delete cascade,
  document_id  uuid not null references public.documents (id) on delete cascade,
  created_by   uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  results      jsonb not null default '{}'::jsonb      -- { baseline: [...], models: { <model>: { requirements, cost_usd, duration_ms, error } } }
);
create index model_comparisons_project_idx on public.model_comparisons (project_id, created_at desc);
alter table public.model_comparisons enable row level security;
create policy "staff read model comparisons" on public.model_comparisons for select to authenticated using (public.is_project_staff(project_id));
create policy "engineers add model comparisons" on public.model_comparisons for insert to authenticated
  with check (created_by = auth.uid() and exists (select 1 from public.project_members m where m.project_id = model_comparisons.project_id
                                                   and m.user_id = auth.uid() and m.role in ('owner', 'engineer')));
grant select, insert on public.model_comparisons to authenticated;
grant all on public.model_comparisons to service_role;

-- Owners and engineers choose the reading model.
create function public.set_reading_model(p_project uuid, p_model text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.need_role(p_project, '{owner,engineer}', 'choose the reading model');
  update public.projects set reading_model = nullif(p_model, '') where id = p_project;
end;
$$;
revoke all on function public.set_reading_model(uuid, text) from public, anon;
grant execute on function public.set_reading_model(uuid, text) to authenticated;
