-- Plans from large inputs are made by a worker. Planning hundreds of requirements takes longer than the web server's
-- request limit (5 minutes on the hosted platform), so the web app records a request with everything the planner
-- reads (requirements, context, inputs) and a worker generates the plan and stores it as a new draft version.

create table public.plan_requests (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references public.projects (id) on delete cascade,
  status        text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  payload       jsonb not null,             -- {requirements, context, input_ids, inputs, capabilities, supervision_mode}
  requirements  integer not null,
  plan_id       uuid references public.plans (id) on delete set null,
  model         text,
  error         text,
  attempts      integer not null default 0,
  claimed_by    text,
  claimed_at    timestamptz,
  requested_by  uuid references auth.users (id) on delete set null default auth.uid(),
  created_at    timestamptz not null default now(),
  completed_at  timestamptz,
  check (status <> 'done' or plan_id is not null)
);
create index plan_requests_queue_idx on public.plan_requests (status, created_at) where status in ('queued', 'running');
alter table public.plan_requests enable row level security;
create policy "members read plan requests" on public.plan_requests for select to authenticated using (public.is_project_member(project_id));
grant select on public.plan_requests to authenticated;
grant all on public.plan_requests to service_role;

create function public.request_plan(p_project uuid, p_payload jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_n integer;
begin
  perform public.need_role(p_project, '{owner,engineer}', 'generate plans');
  if jsonb_typeof(p_payload -> 'requirements') <> 'array' or jsonb_array_length(p_payload -> 'requirements') = 0 then
    raise exception 'extract or add requirements before generating a plan';
  end if;
  perform pg_advisory_xact_lock(hashtext('plan-request:' || p_project::text));
  if exists (select 1 from public.plan_requests where project_id = p_project and status in ('queued', 'running')) then
    raise exception 'a plan is already being generated for this project; wait for it to finish';
  end if;
  v_n := jsonb_array_length(p_payload -> 'requirements');
  insert into public.plan_requests (project_id, payload, requirements) values (p_project, p_payload, v_n) returning id into v_id;
  perform public.worker_audit(p_project, 'plan.requested', 'plan_request', v_id, jsonb_build_object('requirements', v_n));
  return v_id;
end;
$$;

create function public.claim_plan_request(p_worker_id text, p_stale_seconds integer default 1800) returns public.plan_requests
language plpgsql security definer set search_path = '' as $$
declare v public.plan_requests;
begin
  update public.plan_requests set status = 'failed', error = 'gave up after 3 attempts', claimed_by = null, completed_at = now()
   where status = 'running' and claimed_at < now() - make_interval(secs => p_stale_seconds) and attempts >= 3;
  select * into v from public.plan_requests
   where status = 'queued' or (status = 'running' and claimed_at < now() - make_interval(secs => p_stale_seconds))
   order by created_at for update skip locked limit 1;
  if v.id is null then return null; end if;
  update public.plan_requests set status = 'running', claimed_by = p_worker_id, claimed_at = now(), attempts = attempts + 1
   where id = v.id returning * into v;
  return v;
end;
$$;

-- Stores the generated plan as a new draft version (create_plan_version's checks apply), or records the failure.
create function public.complete_plan_request(p_id uuid, p_worker_id text, p_plan jsonb, p_model text, p_error text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v public.plan_requests; v_plan uuid;
begin
  select * into v from public.plan_requests where id = p_id for update;
  if v.status <> 'running' or v.claimed_by is distinct from p_worker_id then
    raise exception 'plan request % is not held by this worker', p_id;
  end if;
  if p_error is not null then
    update public.plan_requests set status = 'failed', error = left(p_error, 2000), model = p_model, completed_at = now(), claimed_by = null where id = p_id;
    return null;
  end if;
  v_plan := public.create_plan_version(v.project_id, p_plan);
  update public.plan_requests set status = 'done', plan_id = v_plan, model = p_model, error = null, completed_at = now(), claimed_by = null where id = p_id;
  perform public.worker_audit(v.project_id, 'plan.generated', 'plan', v_plan, jsonb_build_object('request', p_id, 'model', p_model));
  return v_plan;
end;
$$;

revoke all on function public.request_plan(uuid, jsonb) from public, anon;
grant execute on function public.request_plan(uuid, jsonb) to authenticated;
revoke all on function public.claim_plan_request(text, integer), public.complete_plan_request(uuid, text, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.claim_plan_request(text, integer), public.complete_plan_request(uuid, text, jsonb, text, text) to service_role;
