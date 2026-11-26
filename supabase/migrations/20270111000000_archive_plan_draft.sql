-- Drafts are archived, never deleted: "Archive this draft" keeps the plan version (status superseded, marked archived)
-- so it stays in the plan archive for reference. The old discard function now archives too.
create or replace function public.discard_plan_draft(p_plan uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare p public.plans;
begin
  select * into p from public.plans where id = p_plan for update;
  if p.id is null or not public.has_project_role(p.project_id, '{owner,engineer}') then
    raise exception 'plan not found or not permitted' using errcode = '42501';
  end if;
  if p.status not in ('draft', 'awaiting_approval') then raise exception 'only a draft can be archived (this plan is %)', p.status; end if;
  perform set_config('vx.plan_transition', 'on', true);
  update public.plans set status = 'superseded',
         generator = coalesce(generator, '{}'::jsonb) || jsonb_build_object('archived_at', now(), 'archived_from', p.status)
   where id = p_plan;
  perform set_config('vx.plan_transition', '', true);
  perform public.worker_audit(p.project_id, 'plan.archived', 'plan', p.id, jsonb_build_object('version', p.version, 'status', p.status));
end;
$$;
revoke all on function public.discard_plan_draft(uuid) from public, anon;
grant execute on function public.discard_plan_draft(uuid) to authenticated;
