-- Guidance for a step, written by the owner or team (for example from the run page's chat after a step failed).
-- The step's next attempt reads it alongside a reviewer's return notes; guidance is kept, never edited.
create table public.task_guidance (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.projects (id) on delete cascade,
  task_id     uuid not null references public.tasks (id) on delete cascade,
  note        text not null check (length(trim(note)) between 2 and 4000),
  created_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now()
);
create index task_guidance_task_idx on public.task_guidance (task_id, created_at);
alter table public.task_guidance enable row level security;
create policy "members read guidance" on public.task_guidance for select to authenticated using (public.is_project_member(project_id));
revoke all on public.task_guidance from anon, authenticated;
grant select on public.task_guidance to authenticated;
grant all on public.task_guidance to service_role;

create function public.add_task_guidance(p_task uuid, p_note text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare t public.tasks; v uuid;
begin
  select * into t from public.tasks where id = p_task;
  if t.id is null or not public.has_project_role(t.project_id, '{owner,engineer,reviewer,client}') then
    raise exception 'step not found or not permitted' using errcode = '42501';
  end if;
  if length(trim(coalesce(p_note, ''))) < 2 then raise exception 'write the guidance first'; end if;
  insert into public.task_guidance (project_id, task_id, note, created_by) values (t.project_id, t.id, trim(p_note), auth.uid()) returning id into v;
  insert into public.audit_events (project_id, actor_id, actor_type, event_type, entity_type, entity_id, payload)
  values (t.project_id, auth.uid(), 'user', 'task.guidance', 'task', t.id, jsonb_build_object('note', left(trim(p_note), 500)));
  return v;
end;
$$;
revoke all on function public.add_task_guidance(uuid, text) from public, anon;
grant execute on function public.add_task_guidance(uuid, text) to authenticated;
