-- S0 requirement wizard. Answers are saved per project as they are given (owners, engineers and clients may answer);
-- applying them (owners and engineers) updates the intake and writes draft requirements, each with a stable wizard
-- key: answering again updates a requirement instead of adding a duplicate, unless a plan task already uses it, in
-- which case it is left alone and reported. Wizard requirements start as "extracted": the team confirms the wording.

alter table public.project_intake add column wizard jsonb not null default '{}'::jsonb, add column wizard_updated_at timestamptz;
alter table public.requirements drop constraint requirements_origin_check;
alter table public.requirements add constraint requirements_origin_check check (origin in ('extracted', 'manual', 'wizard'));
alter table public.requirements add column wizard_key text;
create unique index requirements_wizard_key_idx on public.requirements (project_id, wizard_key) where wizard_key is not null;

create function public.save_wizard_answers(p_project uuid, p_answers jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.need_role(p_project, '{owner,engineer,client}', 'answer the requirement wizard');
  if jsonb_typeof(p_answers) <> 'object' then raise exception 'answers must be an object'; end if;
  insert into public.project_intake (project_id, wizard, wizard_updated_at, updated_by, updated_at)
  values (p_project, p_answers, now(), auth.uid(), now())
  on conflict (project_id) do update set wizard = excluded.wizard, wizard_updated_at = now();
end;
$$;

-- p_requirements: [{key, code, kind, priority, text, acceptance_criteria, basis}] as the wizard generated them.
create function public.apply_wizard(p_project uuid, p_intake jsonb, p_requirements jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  r jsonb;
  e public.requirements;
  v_ref text;
  v_added text[] := '{}'; v_updated text[] := '{}'; v_in_use text[] := '{}'; v_same integer := 0;
  v_keys text[];
begin
  perform public.need_role(p_project, '{owner,engineer}', 'turn wizard answers into requirements');
  if jsonb_typeof(p_requirements) <> 'array' then raise exception 'requirements must be a list'; end if;
  perform public.save_intake(p_project, p_intake);
  for r in select * from jsonb_array_elements(p_requirements) loop
    if coalesce(r ->> 'key', '') !~ '^[a-z0-9_]{1,60}$' or coalesce(r ->> 'code', '') !~ '^[A-Z]{3}$' then raise exception 'malformed wizard requirement'; end if;
    select * into e from public.requirements where project_id = p_project and wizard_key = r ->> 'key';
    if e.id is null then
      perform pg_advisory_xact_lock(hashtext('req:' || p_project::text));
      select format('REQ-%s-%s', r ->> 'code', lpad((coalesce(max(substring(ref_code from '^REQ-[A-Z]+-(\d+)$')::integer), 0) + 1)::text, 3, '0'))
        into v_ref from public.requirements where project_id = p_project and ref_code like 'REQ-' || (r ->> 'code') || '-%';
      insert into public.requirements (project_id, ref_code, kind, status, priority, text, acceptance_criteria, source_section, origin, wizard_key, notes)
      values (p_project, v_ref, (r ->> 'kind')::public.requirement_kind, 'extracted', r ->> 'priority', r ->> 'text', r ->> 'acceptance_criteria',
              'Requirement wizard: ' || (r ->> 'basis'), 'wizard', r ->> 'key', null);
      v_added := v_added || v_ref;
    elsif e.text = r ->> 'text' and e.acceptance_criteria is not distinct from r ->> 'acceptance_criteria' and e.priority = r ->> 'priority' then
      v_same := v_same + 1;
    elsif exists (select 1 from public.task_requirements where requirement_id = e.id) then
      v_in_use := v_in_use || e.ref_code;
    else
      update public.requirements set text = r ->> 'text', acceptance_criteria = r ->> 'acceptance_criteria', priority = r ->> 'priority',
             kind = (r ->> 'kind')::public.requirement_kind, source_section = 'Requirement wizard: ' || (r ->> 'basis'),
             status = case when status = 'rejected' then status else 'extracted' end
       where id = e.id;
      v_updated := v_updated || e.ref_code;
    end if;
  end loop;
  select array_agg(x ->> 'key') into v_keys from jsonb_array_elements(p_requirements) x;
  perform public.worker_audit(p_project, 'wizard.applied', 'project', p_project,
                              jsonb_build_object('added', v_added, 'updated', v_updated, 'in_use', v_in_use, 'unchanged', v_same));
  return jsonb_build_object('added', to_jsonb(v_added), 'updated', to_jsonb(v_updated), 'in_use', to_jsonb(v_in_use), 'unchanged', v_same,
    'no_longer_answered', coalesce((select jsonb_agg(ref_code order by ref_code) from public.requirements
                                     where project_id = p_project and origin = 'wizard' and status <> 'rejected'
                                       and wizard_key <> all (coalesce(v_keys, '{}'))), '[]'::jsonb));
end;
$$;

revoke all on function public.save_wizard_answers(uuid, jsonb), public.apply_wizard(uuid, jsonb, jsonb) from public, anon;
grant execute on function public.save_wizard_answers(uuid, jsonb), public.apply_wizard(uuid, jsonb, jsonb) to authenticated, service_role;
