-- Boards: a product is often several circuit boards, each designed over several tasks (schematic sections, power,
-- stackup, placement, routing). tasks.board names the board a schematic, layout or board-power task works on; the
-- worker builds each board's circuit up task by task, reuses a board's layout while its circuit is unchanged, and
-- packages and sources every board. Plans carry it in each task's "board"; revisions keep it.
alter table public.tasks add column board text check (board ~ '^[a-z0-9][a-z0-9-]*$');
create index if not exists tasks_plan_board_idx on public.tasks (plan_id, board) where board is not null;

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
                              acceptance_tests, approval_policy, risk_level, estimated_hours, status, position, basis, board)
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
      case when jsonb_typeof(v_task -> 'basis') = 'object' then v_task -> 'basis' end,
      nullif(v_task ->> 'board', '')
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
      'risk_level', t.risk_level, 'estimated_hours', t.estimated_hours, 'basis', t.basis, 'board', t.board,
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

revoke all on function public.create_plan_version(uuid, jsonb), public.revise_plan(uuid) from public, anon;
grant execute on function public.create_plan_version(uuid, jsonb), public.revise_plan(uuid) to authenticated, service_role;
