-- "Discard this draft": a draft plan version nobody will approve (for example one made before a newer plan was approved)
-- can be removed, so it stops showing as the latest plan. Only drafts and plans returned for changes; never an approved
-- or superseded plan, never one a run used, never one a later version was made from.
create or replace function public.discard_plan_draft(p_plan uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare p public.plans;
begin
  select * into p from public.plans where id = p_plan for update;
  if p.id is null or not public.has_project_role(p.project_id, '{owner,engineer}') then
    raise exception 'plan not found or not permitted' using errcode = '42501';
  end if;
  if p.status not in ('draft', 'awaiting_approval') then raise exception 'only a draft can be discarded (this plan is %)', p.status; end if;
  if exists (select 1 from public.runs where plan_id = p_plan) then raise exception 'a run used this plan, so it is kept'; end if;
  if exists (select 1 from public.plans where revised_from_id = p_plan) then raise exception 'a later plan version was made from this draft, so it is kept'; end if;
  perform public.worker_audit(p.project_id, 'plan.discarded', 'plan', p.id, jsonb_build_object('version', p.version, 'status', p.status));
  delete from public.plans where id = p_plan;
end;
$$;
revoke all on function public.discard_plan_draft(uuid) from public, anon;
grant execute on function public.discard_plan_draft(uuid) to authenticated;
