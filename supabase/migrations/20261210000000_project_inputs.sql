-- Project inputs: everything a plan is built from, in one place. Specifications (documents, as before), mock-ups and
-- references (sketches, renders, photos, drawings) and prior work (files from other tools; Flux audits). A plan records
-- which inputs it was built from, and each task records whether it reuses, adapts or starts fresh, citing the inputs.

create table public.project_references (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references public.projects (id) on delete cascade,
  ref_no       integer not null,
  kind         text not null check (kind in ('mockup', 'sketch', 'render', 'photo', 'drawing', 'prior_design', 'datasheet', 'other')),
  title        text not null check (length(trim(title)) between 1 and 200),
  note         text check (note is null or length(note) <= 4000),   -- what it shows: sizes, what to keep, what to change
  filename     text not null,
  storage_path text not null unique,
  sha256       text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes   bigint,
  mime_type    text,
  use_in_plan  boolean not null default true,
  created_by   uuid references auth.users (id) on delete set null default auth.uid(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (project_id, ref_no),
  unique (project_id, sha256)
);
create trigger project_references_updated_at before update on public.project_references for each row execute function public.set_updated_at();
alter table public.project_references enable row level security;
create policy "members read project references" on public.project_references for select to authenticated using (public.is_project_member(project_id));
grant select on public.project_references to authenticated;
grant all on public.project_references to service_role;

-- Prior work: which Flux audits a plan should build on.
alter table public.flux_audits add column use_in_plan boolean not null default true;

-- What a plan was built from, and each task's basis: {mode: reuse|adapt|new, sources: ["PW-1", "REF-2"], reason}.
alter table public.plans add column inputs jsonb not null default '[]'::jsonb;
alter table public.tasks add column basis jsonb check (basis is null or (basis ->> 'mode') in ('reuse', 'adapt', 'new'));

-- Concept rounds may take the project's mock-ups as reference images.
alter table public.concept_rounds add column reference_ids uuid[] not null default '{}';

create function public.add_project_reference(p_project uuid, p_kind text, p_title text, p_note text, p_filename text, p_path text,
                                             p_sha256 text, p_size bigint, p_mime text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_no integer;
begin
  perform public.need_role(p_project, '{owner,engineer}', 'add mock-ups and references');
  if public.storage_path_project_id(p_path) is distinct from p_project or split_part(p_path, '/', 2) <> 'references' then
    raise exception 'the file must be stored in the project''s references folder';
  end if;
  if exists (select 1 from public.project_references where project_id = p_project and sha256 = p_sha256) then
    raise exception 'this exact file is already a reference of the project';
  end if;
  perform pg_advisory_xact_lock(hashtext('references:' || p_project::text));
  select coalesce(max(ref_no), 0) + 1 into v_no from public.project_references where project_id = p_project;
  insert into public.project_references (project_id, ref_no, kind, title, note, filename, storage_path, sha256, size_bytes, mime_type)
  values (p_project, v_no, p_kind, trim(p_title), nullif(trim(coalesce(p_note, '')), ''), p_filename, p_path, p_sha256, p_size, p_mime)
  returning id into v_id;
  perform public.worker_audit(p_project, 'reference.added', 'project_reference', v_id, jsonb_build_object('ref_no', v_no, 'kind', p_kind, 'title', p_title));
  return v_id;
end;
$$;

create function public.update_project_reference(p_id uuid, p_kind text, p_title text, p_note text, p_use_in_plan boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.project_references;
begin
  select * into r from public.project_references where id = p_id;
  if r.id is null then raise exception 'reference not found'; end if;
  perform public.need_role(r.project_id, '{owner,engineer}', 'edit mock-ups and references');
  update public.project_references set kind = p_kind, title = trim(p_title), note = nullif(trim(coalesce(p_note, '')), ''),
         use_in_plan = coalesce(p_use_in_plan, use_in_plan) where id = p_id;
end;
$$;

-- Returns the storage path, for the caller to remove the file.
create function public.remove_project_reference(p_id uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare r public.project_references;
begin
  select * into r from public.project_references where id = p_id;
  if r.id is null then raise exception 'reference not found'; end if;
  perform public.need_role(r.project_id, '{owner,engineer}', 'remove mock-ups and references');
  if exists (select 1 from public.concept_rounds where project_id = r.project_id and p_id = any (reference_ids) and status in ('queued', 'generating')) then
    raise exception 'a concept round in progress uses this reference; wait for it to finish';
  end if;
  delete from public.project_references where id = p_id;
  perform public.worker_audit(r.project_id, 'reference.removed', 'project_reference', p_id, jsonb_build_object('ref_no', r.ref_no, 'title', r.title));
  return r.storage_path;
end;
$$;

create function public.set_flux_audit_in_plan(p_audit uuid, p_use boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare v_project uuid;
begin
  select project_id into v_project from public.flux_audits where id = p_audit;
  if v_project is null then raise exception 'audit not found'; end if;
  perform public.need_role(v_project, '{owner,engineer}', 'choose the prior work a plan uses');
  update public.flux_audits set use_in_plan = p_use where id = p_audit;
end;
$$;

-- Concept rounds with reference images: the same rules as before, plus the references must be images of the project.
create function public.request_concepts_with_references(p_project_id uuid, p_direction text, p_count integer, p_parent_variant_id uuid,
                                                        p_reference_ids uuid[]) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if not public.has_project_role(p_project_id, '{owner,engineer,client}') then
    raise exception 'only owners, engineers and clients of the project can ask for concepts' using errcode = '42501';
  end if;
  if coalesce(array_length(p_reference_ids, 1), 0) > 4 then raise exception 'use at most four reference images'; end if;
  if exists (select 1 from unnest(coalesce(p_reference_ids, '{}')) x
              where not exists (select 1 from public.project_references r where r.id = x and r.project_id = p_project_id
                                  and r.mime_type in ('image/png', 'image/jpeg', 'image/webp'))) then
    raise exception 'reference images must be PNG, JPEG or WebP mock-ups of this project';
  end if;
  v_id := public.request_concepts(p_project_id, p_direction, p_count, p_parent_variant_id);
  update public.concept_rounds set reference_ids = coalesce(p_reference_ids, '{}') where id = v_id;
  return v_id;
end;
$$;

-- Plans: carry the inputs and each task's basis. Same checks as before (g1_planning), with two more fields.
create or replace function public.create_plan_version(p_project_id uuid, p_payload jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_plan_id uuid;
  v_version integer;
  v_task jsonb;
  v_task_id uuid;
  v_ids jsonb := '{}'::jsonb;
  v_ref text;
  v_req_id uuid;
  v_up text;
  v_pos integer;
  v_order jsonb := '{}'::jsonb;
begin
  if auth.uid() is not null and not public.has_project_role(p_project_id, '{owner,engineer}') then
    raise exception 'not permitted to create plans in this project';
  end if;
  if jsonb_typeof(p_payload -> 'tasks') <> 'array' or jsonb_array_length(p_payload -> 'tasks') = 0 then
    raise exception 'plan payload must contain at least one task';
  end if;

  perform 1 from public.projects where id = p_project_id for update;
  select coalesce(max(version), 0) + 1 into v_version from public.plans where project_id = p_project_id;

  insert into public.plans (project_id, version, status, supervision_mode, summary, generator, assumptions, deferred, revised_from_id, inputs)
  values (
    p_project_id, v_version, 'draft',
    coalesce((p_payload ->> 'supervision_mode')::public.supervision_mode, 'guided'),
    p_payload ->> 'summary',
    coalesce(p_payload -> 'generator', '{}'::jsonb),
    coalesce(p_payload -> 'assumptions', '[]'::jsonb),
    coalesce(p_payload -> 'deferred', '[]'::jsonb),
    (p_payload ->> 'revised_from_id')::uuid,
    coalesce(p_payload -> 'inputs', '[]'::jsonb)
  )
  returning id into v_plan_id;

  for v_task, v_pos in select value, ordinality from jsonb_array_elements(p_payload -> 'tasks') with ordinality loop
    if v_ids ? (v_task ->> 'key') then
      raise exception 'duplicate task key %', v_task ->> 'key';
    end if;
    insert into public.tasks (project_id, plan_id, key, title, discipline, description, required_tools,
                              acceptance_tests, approval_policy, risk_level, estimated_hours, status, position, basis)
    values (
      p_project_id, v_plan_id, v_task ->> 'key', v_task ->> 'title',
      (v_task ->> 'discipline')::public.discipline, v_task ->> 'description',
      coalesce(array(select jsonb_array_elements_text(v_task -> 'required_tools')), '{}'),
      coalesce(v_task -> 'acceptance_tests', '[]'::jsonb),
      jsonb_build_object('required', coalesce((v_task ->> 'approval_required')::boolean, false),
                         'reason', v_task ->> 'approval_reason'),
      coalesce((v_task ->> 'risk_level')::public.risk_level, 'medium'),
      (v_task ->> 'estimated_hours')::numeric,
      'draft',
      v_pos,
      case when jsonb_typeof(v_task -> 'basis') = 'object' then v_task -> 'basis' end
    )
    returning id into v_task_id;
    v_ids := v_ids || jsonb_build_object(v_task ->> 'key', v_task_id);
    v_order := v_order || jsonb_build_object(v_task ->> 'key', v_pos);

    for v_ref in select jsonb_array_elements_text(coalesce(v_task -> 'requirement_refs', '[]'::jsonb)) loop
      select id into v_req_id from public.requirements where project_id = p_project_id and ref_code = v_ref;
      if v_req_id is null then
        raise exception 'task % references unknown requirement %', v_task ->> 'key', v_ref;
      end if;
      insert into public.task_requirements (task_id, requirement_id) values (v_task_id, v_req_id);
    end loop;
  end loop;

  for v_task in select * from jsonb_array_elements(p_payload -> 'tasks') loop
    for v_up in select jsonb_array_elements_text(coalesce(v_task -> 'upstream_keys', '[]'::jsonb)) loop
      if not v_ids ? v_up then
        raise exception 'task % depends on unknown task %', v_task ->> 'key', v_up;
      end if;
      if (v_order ->> v_up)::int >= (v_order ->> (v_task ->> 'key'))::int then
        raise exception 'tasks must be listed in dependency order: % comes before its dependency %', v_task ->> 'key', v_up;
      end if;
      insert into public.task_dependencies (task_id, depends_on_task_id)
      values ((v_ids ->> (v_task ->> 'key'))::uuid, (v_ids ->> v_up)::uuid);
    end loop;
  end loop;

  return v_plan_id;
end;
$$;

create or replace function public.revise_plan(p_plan_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_plan public.plans;
  v_payload jsonb;
begin
  select * into v_plan from public.plans where id = p_plan_id;
  if not found or (auth.uid() is not null and not public.has_project_role(v_plan.project_id, '{owner,engineer}')) then
    raise exception 'plan not found or not permitted';
  end if;
  select jsonb_build_object(
    'summary', v_plan.summary,
    'supervision_mode', v_plan.supervision_mode,
    'generator', v_plan.generator || jsonb_build_object('revised_from_version', v_plan.version),
    'assumptions', v_plan.assumptions,
    'deferred', v_plan.deferred,
    'inputs', v_plan.inputs,
    'revised_from_id', v_plan.id,
    'tasks', coalesce(jsonb_agg(jsonb_build_object(
      'key', t.key, 'title', t.title, 'discipline', t.discipline, 'description', t.description,
      'required_tools', to_jsonb(t.required_tools), 'acceptance_tests', t.acceptance_tests,
      'approval_required', coalesce((t.approval_policy ->> 'required')::boolean, false),
      'approval_reason', t.approval_policy ->> 'reason',
      'risk_level', t.risk_level, 'estimated_hours', t.estimated_hours, 'basis', t.basis,
      'upstream_keys', (select coalesce(jsonb_agg(u.key order by u.key), '[]'::jsonb)
                          from public.task_dependencies d join public.tasks u on u.id = d.depends_on_task_id
                         where d.task_id = t.id),
      'requirement_refs', (select coalesce(jsonb_agg(r.ref_code order by r.ref_code), '[]'::jsonb)
                             from public.task_requirements tr join public.requirements r on r.id = tr.requirement_id
                            where tr.task_id = t.id)
    ) order by t.position), '[]'::jsonb))
  into v_payload
  from public.tasks t where t.plan_id = p_plan_id;
  return public.create_plan_version(v_plan.project_id, v_payload);
end;
$$;

revoke all on function public.add_project_reference(uuid, text, text, text, text, text, text, bigint, text), public.update_project_reference(uuid, text, text, text, boolean),
  public.remove_project_reference(uuid), public.set_flux_audit_in_plan(uuid, boolean),
  public.request_concepts_with_references(uuid, text, integer, uuid, uuid[]) from public, anon;
grant execute on function public.add_project_reference(uuid, text, text, text, text, text, text, bigint, text), public.update_project_reference(uuid, text, text, text, boolean),
  public.remove_project_reference(uuid), public.set_flux_audit_in_plan(uuid, boolean),
  public.request_concepts_with_references(uuid, text, integer, uuid, uuid[]) to authenticated;
revoke all on function public.create_plan_version(uuid, jsonb), public.revise_plan(uuid) from public, anon;
grant execute on function public.create_plan_version(uuid, jsonb), public.revise_plan(uuid) to authenticated, service_role;

-- Owners and engineers may remove reference files they no longer want.
do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    create policy "engineers delete project references" on storage.objects for delete to authenticated
      using (bucket_id = 'project-files' and split_part(name, '/', 2) = 'references'
             and public.has_project_role(public.storage_path_project_id(name), '{owner,engineer}'));
  end if;
end;
$$;
