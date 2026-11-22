-- Runs that do not stop for every approval, and continuing a run instead of starting another.
--
-- auto_approve (in runs.stop_conditions): results that complete with every check passing are approved on the authority
-- of the person who started the run, recorded as automatic approvals with the reason they would have stopped. Failing
-- checks still stop a task (the rest of the plan carries on around it). Releases are never issued automatically.
--
-- continue_run reopens a run that stopped because nothing could run without input (or its budget): with a new budget
-- and auto-approve setting, and when auto-approve is on, the results waiting in it are approved the same way.

create or replace function public.complete_execution(p_execution_id uuid, p_worker_id text, p_validations jsonb,
                                          p_summary text default null, p_review_reason text default null)
returns public.task_status
language plpgsql security definer set search_path = '' as $$
declare
  v_exec public.executions := public.held_execution(p_execution_id, p_worker_id);
  v_task public.tasks;
  v_run  public.runs;
  v_v jsonb;
  v_gate text;
  v_status public.task_status;
  v_committed integer := 0;
begin
  select * into v_task from public.tasks where id = v_exec.task_id for update;
  if v_task.status <> 'validating' then
    raise exception 'task % is %, expected validating', v_task.id, v_task.status;
  end if;
  select * into v_run from public.runs where id = v_exec.run_id;

  for v_v in select * from jsonb_array_elements(coalesce(p_validations, '[]'::jsonb)) loop
    if v_v ->> 'result' in ('fail', 'error') then
      raise exception 'complete_execution called with a failing validation (%); use fail_execution', v_v ->> 'summary';
    end if;
    insert into public.validations (project_id, task_id, execution_id, artifact_version_id, kind, result,
                                    evidence_category, summary, details, tool_name, tool_version)
    values (v_exec.project_id, v_task.id, v_exec.id, (v_v ->> 'artifact_version_id')::uuid,
            (v_v ->> 'kind')::public.validation_kind, (v_v ->> 'result')::public.validation_result,
            (v_v ->> 'evidence_category')::public.evidence_category, v_v ->> 'summary',
            coalesce(v_v -> 'details', '{}'::jsonb), v_v ->> 'tool_name', v_v ->> 'tool_version');
  end loop;

  update public.artifact_versions set validated_at = now()
   where produced_by_task_id = v_task.id and status = 'scratch' and validated_at is null
     and produced_by_execution_id = any (public.attempt_execution_ids(v_task.id, v_exec.attempt));

  -- Sign-off: the plan's approval policy always applies; Guided mode also gates design disciplines.
  v_gate := case
    when p_review_reason is not null then p_review_reason
    when coalesce((v_task.approval_policy ->> 'required')::boolean, false)
      then coalesce(v_task.approval_policy ->> 'reason', 'approval required by the plan')
    when v_run.mode = 'guided' and v_task.discipline in
         ('architecture', 'components', 'schematic', 'pcb_layout', 'power', 'mechanical', 'enclosure')
      then format('Guided mode: %s results need your review', v_task.discipline)
  end;

  -- Overnight runs (stop_conditions.auto_approve): a result that would stop for sign-off is approved on the run's
  -- authority instead, because it completed with every check passing (failing checks never reach this function).
  -- The approval is recorded with what it would have asked, so it can be read and reversed later.
  if v_gate is not null and coalesce((v_run.stop_conditions ->> 'auto_approve')::boolean, false) and v_run.started_by is not null then
    insert into public.approvals (project_id, task_id, reason, requested_by, status, responded_by, responded_at, response_note)
    values (v_exec.project_id, v_task.id, v_gate, null, 'approved', v_run.started_by, now(),
            'Approved automatically: every VX Design check passed (overnight run; the run''s owner authorized this).');
    v_gate := null;
  end if;

  if v_gate is not null then
    update public.tasks set status = 'awaiting_approval', assigned_worker = null where id = v_task.id;
    insert into public.approvals (project_id, task_id, reason, requested_by)
    values (v_exec.project_id, v_task.id, v_gate, null);
    v_status := 'awaiting_approval';
  else
    v_committed := public.commit_task_outputs(v_task.id, v_exec.attempt);
    update public.tasks set status = 'complete', assigned_worker = null where id = v_task.id;
    v_status := 'complete';
  end if;

  update public.executions set status = 'succeeded', finished_at = now(), summary = p_summary where id = v_exec.id;
  perform public.release_locks(v_exec.id);
  perform public.worker_audit(v_exec.project_id, 'execution.succeeded', 'execution', v_exec.id,
                              jsonb_build_object('task_status', v_status, 'committed_versions', v_committed, 'gate', v_gate));
  return v_status;
end;
$$;


create function public.continue_run(p_run uuid, p_ai numeric, p_auto_approve boolean) returns text
language plpgsql security definer set search_path = '' as $$
declare
  r public.runs;
  t record;
  n integer := 0;
begin
  select * into r from public.runs where id = p_run for update;
  if r.id is null or not public.has_project_role(r.project_id, '{owner,engineer}') then raise exception 'run not found or not permitted'; end if;
  if r.status in ('canceled', 'failed') then raise exception 'a % run cannot be continued: start a new one', r.status; end if;
  if exists (select 1 from public.runs o where o.plan_id = r.plan_id and o.id <> r.id and o.status in ('pending', 'running', 'paused')) then
    raise exception 'another run of this plan is active';
  end if;
  if (select status from public.plans where id = r.plan_id) <> 'approved' then raise exception 'the plan is no longer the approved baseline'; end if;
  if p_auto_approve then
    for t in select id from public.tasks where plan_id = r.plan_id and status = 'awaiting_approval' loop
      perform public.decide_task(t.id, true, 'Approved: every VX Design check passed (continued as an overnight run).');
      n := n + 1;
    end loop;
  end if;
  update public.runs set status = 'running', stop_reason = null, finished_at = null, report = null, paused_at = null,
         max_ai_spend_usd = greatest(max_ai_spend_usd, coalesce(p_ai, 0)),
         stop_conditions = stop_conditions || jsonb_build_object('auto_approve', coalesce(p_auto_approve, false)),
         started_by = case when p_auto_approve then auth.uid() else started_by end
   where id = r.id;
  insert into public.audit_events (project_id, actor_id, actor_type, event_type, entity_type, entity_id, payload)
  values (r.project_id, auth.uid(), 'user', 'run.continued', 'run', r.id,
          jsonb_build_object('ai_usd', greatest(r.max_ai_spend_usd, coalesce(p_ai, 0)), 'auto_approve', p_auto_approve, 'approved_waiting', n));
  return format('%s', n);
end;
$$;

-- Turn overnight auto-approval on or off for a run while it goes.
create function public.set_run_auto_approve(p_run uuid, p_on boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.runs;
begin
  select * into r from public.runs where id = p_run for update;
  if r.id is null or not public.has_project_role(r.project_id, '{owner,engineer}') then raise exception 'run not found or not permitted'; end if;
  update public.runs set stop_conditions = stop_conditions || jsonb_build_object('auto_approve', p_on),
         started_by = case when p_on then auth.uid() else started_by end where id = r.id;
  insert into public.audit_events (project_id, actor_id, actor_type, event_type, entity_type, entity_id, payload)
  values (r.project_id, auth.uid(), 'user', 'run.auto_approve', 'run', r.id, jsonb_build_object('on', p_on));
end;
$$;

revoke all on function public.continue_run(uuid, numeric, boolean), public.set_run_auto_approve(uuid, boolean) from public, anon;
grant execute on function public.continue_run(uuid, numeric, boolean), public.set_run_auto_approve(uuid, boolean) to authenticated;
