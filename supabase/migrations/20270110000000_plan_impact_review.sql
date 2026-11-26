-- Updating a plan without redoing everything. When a new plan version changes some steps, the steps that build on them
-- used to be redone automatically (their fingerprints change with any upstream change). Before approval the design agent
-- now reviews each such step: does the change really alter what this step produces? The review is stored per plan, the
-- owner sees it in plain words (and can ask for any step to be redone anyway), and on approval the steps that keep their
-- result take over the finished work of the same step in the earlier plan, marked as kept and why.
create table if not exists public.plan_impact_reviews (
  plan_id     uuid primary key references public.plans(id) on delete cascade,
  project_id  uuid not null references public.projects(id) on delete cascade,
  review      jsonb not null,
  created_by  uuid references auth.users(id) default auth.uid(),
  created_at  timestamptz not null default now()
);
alter table public.plan_impact_reviews enable row level security;
revoke all on public.plan_impact_reviews from anon;
grant select, insert, update on public.plan_impact_reviews to authenticated;
create policy plan_impact_reviews_read on public.plan_impact_reviews for select to authenticated using (public.is_project_member(project_id));
create policy plan_impact_reviews_write on public.plan_impact_reviews for insert to authenticated
  with check (public.has_project_role(project_id, '{owner,engineer}')
              and exists (select 1 from public.plans p where p.id = plan_id and p.project_id = plan_impact_reviews.project_id));
create policy plan_impact_reviews_update on public.plan_impact_reviews for update to authenticated
  using (public.has_project_role(project_id, '{owner,engineer}'));

-- Keep the finished work of the named steps of an approved plan: each takes over the newest finished result of the step
-- with the same key in an earlier plan (outputs linked, checks copied with "Kept from vN"), like an unchanged step.
create or replace function public.keep_finished_work(p_plan uuid, p_keys text[], p_reason text default null) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  pl public.plans;
  t record;
  o record;
  n integer := 0;
begin
  select * into pl from public.plans where id = p_plan;
  if pl.id is null or not public.has_project_role(pl.project_id, '{owner,engineer}') then
    raise exception 'plan not found or not permitted' using errcode = '42501';
  end if;
  if pl.status <> 'approved' then raise exception 'only steps of the approved plan can keep earlier work'; end if;
  perform set_config('vx.task_reuse', 'on', true);
  for t in select * from public.tasks where plan_id = p_plan and key = any(p_keys) and status in ('draft', 'ready') order by position loop
    select ot.*, p.version as plan_version into o
      from public.tasks ot join public.plans p on p.id = ot.plan_id
     where ot.project_id = t.project_id and ot.plan_id <> t.plan_id and ot.key = t.key
       and ot.completed_at is not null and ot.status in ('complete', 'superseded')
       and exists (select 1 from public.task_artifacts ta join public.artifact_versions av on av.id = ta.artifact_version_id
                    where ta.task_id = ot.id and ta.role = 'output' and av.status = 'committed')
     order by ot.completed_at desc limit 1;
    if o.id is null then continue; end if;
    insert into public.task_artifacts (task_id, artifact_version_id, role)
    select t.id, ta.artifact_version_id, 'output' from public.task_artifacts ta join public.artifact_versions av on av.id = ta.artifact_version_id
     where ta.task_id = o.id and ta.role = 'output' and av.status = 'committed'
    on conflict do nothing;
    insert into public.validations (project_id, task_id, artifact_version_id, kind, result, evidence_category, summary, details, report_path, tool_name, tool_version)
    select v.project_id, t.id, v.artifact_version_id, v.kind, v.result, v.evidence_category,
           format('Kept from v%s (%s: the plan change does not affect it): %s', o.plan_version, o.key, v.summary),
           v.details || jsonb_build_object('kept_from_task', o.id, 'kept_from_plan_version', o.plan_version, 'reason', p_reason),
           v.report_path, v.tool_name, v.tool_version
      from public.validations v
     where v.task_id = o.id
       and v.execution_id is not distinct from (select v2.execution_id from public.validations v2 where v2.task_id = o.id order by v2.created_at desc limit 1);
    update public.tasks set status = 'complete', completed_at = now(), reused_from_task_id = o.id, stage = coalesce(o.stage, stage) where id = t.id;
    n := n + 1;
  end loop;
  perform set_config('vx.task_reuse', '', true);
  if n > 0 then
    insert into public.audit_events (project_id, actor_id, actor_type, event_type, entity_type, entity_id, payload)
    values (pl.project_id, auth.uid(), 'user', 'plan.kept_unaffected', 'plan', pl.id, jsonb_build_object('tasks', n, 'keys', p_keys));
  end if;
  return n;
end;
$$;
revoke all on function public.keep_finished_work(uuid, text[], text) from public, anon;
grant execute on function public.keep_finished_work(uuid, text[], text) to authenticated;
