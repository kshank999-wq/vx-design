-- Assembly instructions (work instructions for the final assembly). Each generation or revision is a numbered
-- version: a draft that engineers edit, then approved by the owner or a reviewer, which locks it and supersedes the
-- previously approved version. The content is the draft structure from @vx/planning assembly.ts.

create table public.assembly_instructions (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references public.projects (id) on delete cascade,
  version      integer not null check (version > 0),
  status       text not null default 'draft' check (status in ('draft', 'approved', 'superseded')),
  content      jsonb not null check (jsonb_typeof(content) = 'object' and jsonb_typeof(content -> 'steps') = 'array'),
  problems     jsonb not null default '[]'::jsonb,   -- checks still failing after generation, shown to the editor
  model        text,
  usage        jsonb not null default '[]'::jsonb,
  guidance     text check (guidance is null or length(guidance) <= 4000),
  based_on     uuid references public.assembly_instructions (id) on delete set null,
  created_by   uuid references auth.users (id) on delete set null default auth.uid(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  approved_by  uuid references auth.users (id) on delete set null,
  approved_at  timestamptz,
  unique (project_id, version)
);
create trigger assembly_instructions_updated_at before update on public.assembly_instructions for each row execute function public.set_updated_at();
alter table public.assembly_instructions enable row level security;
create policy "members read assembly instructions" on public.assembly_instructions for select to authenticated using (public.is_project_member(project_id));
grant select on public.assembly_instructions to authenticated;
grant all on public.assembly_instructions to service_role;

-- A new draft (generated, or a revision of an approved version). Earlier drafts are superseded: one draft at a time.
create function public.create_assembly_instructions(p_project uuid, p_content jsonb, p_problems jsonb, p_model text, p_usage jsonb,
                                                    p_guidance text, p_based_on uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_no integer;
begin
  perform public.need_role(p_project, '{owner,engineer}', 'write assembly instructions');
  if p_based_on is not null and not exists (select 1 from public.assembly_instructions where id = p_based_on and project_id = p_project) then
    raise exception 'the version to revise is not in this project';
  end if;
  perform pg_advisory_xact_lock(hashtext('assembly:' || p_project::text));
  update public.assembly_instructions set status = 'superseded' where project_id = p_project and status = 'draft';
  select coalesce(max(version), 0) + 1 into v_no from public.assembly_instructions where project_id = p_project;
  insert into public.assembly_instructions (project_id, version, content, problems, model, usage, guidance, based_on)
  values (p_project, v_no, p_content, coalesce(p_problems, '[]'::jsonb), p_model, coalesce(p_usage, '[]'::jsonb), nullif(trim(coalesce(p_guidance, '')), ''), p_based_on)
  returning id into v_id;
  perform public.worker_audit(p_project, 'assembly.drafted', 'assembly_instructions', v_id, jsonb_build_object('version', v_no, 'model', p_model));
  return v_id;
end;
$$;

-- Edits replace the draft's content; approved and superseded versions are locked.
create function public.update_assembly_instructions(p_id uuid, p_content jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.assembly_instructions;
begin
  select * into v from public.assembly_instructions where id = p_id for update;
  if v.id is null then raise exception 'assembly instructions not found'; end if;
  perform public.need_role(v.project_id, '{owner,engineer}', 'edit assembly instructions');
  if v.status <> 'draft' then raise exception 'version % is %: start a revision to change it', v.version, v.status; end if;
  update public.assembly_instructions set content = p_content where id = p_id;
end;
$$;

create function public.approve_assembly_instructions(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.assembly_instructions;
begin
  select * into v from public.assembly_instructions where id = p_id for update;
  if v.id is null then raise exception 'assembly instructions not found'; end if;
  perform public.need_role(v.project_id, '{owner,reviewer}', 'approve assembly instructions');
  if v.status <> 'draft' then raise exception 'only a draft can be approved'; end if;
  if jsonb_array_length(v.content -> 'steps') = 0 then raise exception 'there are no steps to approve'; end if;
  update public.assembly_instructions set status = 'superseded' where project_id = v.project_id and status = 'approved';
  update public.assembly_instructions set status = 'approved', approved_by = auth.uid(), approved_at = now() where id = p_id;
  perform public.worker_audit(v.project_id, 'assembly.approved', 'assembly_instructions', p_id, jsonb_build_object('version', v.version));
end;
$$;

revoke all on function public.create_assembly_instructions(uuid, jsonb, jsonb, text, jsonb, text, uuid), public.update_assembly_instructions(uuid, jsonb),
  public.approve_assembly_instructions(uuid) from public, anon;
grant execute on function public.create_assembly_instructions(uuid, jsonb, jsonb, text, jsonb, text, uuid), public.update_assembly_instructions(uuid, jsonb),
  public.approve_assembly_instructions(uuid) to authenticated;
