-- Requirements reviewed in bulk. A large specification yields hundreds of requirements, each "extracted" (clear) or
-- "ambiguous" (flagged by extraction, with the reason in its notes); S0 sign-off asks for every one to be confirmed or
-- rejected. Owners and engineers confirm a whole group at once (optionally one document's), each change audited.
-- Ambiguous requirements confirmed this way keep their notes, so the plan still sees the doubt.
--
-- Confirming accepts a requirement as written, so it no longer changes a task's fingerprint: only whether a linked
-- requirement is rejected does (with its text, kind, priority and criteria), and reuse is not lost by reviewing.

create function public.bulk_review_requirements(p_project uuid, p_from text, p_to text, p_document uuid default null) returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  if not public.has_project_role(p_project, '{owner,engineer}') then
    raise exception 'only owners and engineers review requirements' using errcode = '42501';
  end if;
  if p_from not in ('extracted', 'ambiguous') or p_to not in ('confirmed', 'rejected') then raise exception 'bulk review moves extracted or ambiguous requirements to confirmed or rejected'; end if;
  update public.requirements set status = p_to::public.requirement_status
   where project_id = p_project and status = p_from::public.requirement_status and (p_document is null or document_id = p_document);
  get diagnostics n = row_count;
  insert into public.audit_events (project_id, actor_id, actor_type, event_type, entity_type, entity_id, payload)
  values (p_project, auth.uid(), 'user', 'requirements.bulk_review', 'project', p_project,
          jsonb_build_object('from', p_from, 'to', p_to, 'document', p_document, 'count', n));
  return n;
end;
$$;
revoke all on function public.bulk_review_requirements(uuid, text, text, uuid) from public, anon;
grant execute on function public.bulk_review_requirements(uuid, text, text, uuid) to authenticated;

create or replace function public.compute_plan_fingerprints(p_plan_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare t record;
begin
  for t in select * from public.tasks where plan_id = p_plan_id order by position loop
    update public.tasks set fingerprint = encode(sha256(convert_to(jsonb_build_object(
        'v', 1,
        'discipline', t.discipline, 'title', t.title, 'description', coalesce(t.description, ''),
        'acceptance_tests', coalesce(t.acceptance_tests, '[]'::jsonb), 'required_tools', to_jsonb(coalesce(t.required_tools, '{}')),
        'board', t.board, 'basis', t.basis, 'risk', t.risk_level, 'approval', t.approval_policy,
        'requirements', (select coalesce(jsonb_agg(jsonb_build_array(r.ref_code, r.kind, r.priority, r.status = 'rejected', r.text, r.acceptance_criteria)
                                                   order by r.ref_code), '[]'::jsonb)
                           from public.task_requirements tr join public.requirements r on r.id = tr.requirement_id where tr.task_id = t.id),
        'upstream', (select coalesce(jsonb_agg(u.fingerprint order by u.fingerprint), '[]'::jsonb)
                       from public.task_dependencies d join public.tasks u on u.id = d.depends_on_task_id where d.task_id = t.id)
      )::text, 'UTF8')), 'hex')
     where id = t.id;
  end loop;
end;
$$;

