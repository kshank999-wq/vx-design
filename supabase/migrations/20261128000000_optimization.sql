-- Optimization proposals (spec §14). An owner or engineer asks for an analysis; a worker reads the project's latest
-- approved sourced BOM and power budget, looks up alternates at the distributors, and writes ranked proposals, each
-- with its computed before/after, basis, confidence, effort and constraint checks (proposals that would break a hard
-- constraint are listed as excluded, never offered). An owner or reviewer accepts or rejects each one: acceptance
-- becomes a project decision (change control, §7) for the next design revision; a rejection needs a reason. A later
-- analysis carries earlier decisions over by the proposal's fingerprint, so a rejected idea is not offered again.

create type public.optimization_status as enum ('queued', 'running', 'ready', 'failed');
create type public.proposal_status as enum ('open', 'accepted', 'rejected', 'superseded');

create table public.optimization_runs (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references public.projects(id) on delete cascade,
  run_no        integer not null,
  status        public.optimization_status not null default 'queued',
  settings      jsonb not null default '{}'::jsonb,
  inputs        jsonb not null default '{}'::jsonb,     -- artifact versions and lookups used
  summary       jsonb not null default '{}'::jsonb,
  excluded      jsonb not null default '[]'::jsonb,     -- ideas dropped because they break a hard constraint, with why
  error         text,
  attempts      integer not null default 0,
  claimed_by    text,
  claimed_at    timestamptz,
  requested_by  uuid references auth.users(id) on delete set null default auth.uid(),
  requested_at  timestamptz not null default now(),
  completed_at  timestamptz,
  unique (project_id, run_no)
);
create index optimization_runs_queue_idx on public.optimization_runs (status, requested_at) where status in ('queued', 'running');

create table public.proposals (
  id                uuid primary key default gen_random_uuid(),
  run_id            uuid not null references public.optimization_runs(id) on delete cascade,
  project_id        uuid not null references public.projects(id) on delete cascade,
  rank              integer not null,
  fingerprint       text not null,
  objective         text not null,
  title             text not null,
  subject           text not null,
  change            jsonb not null,
  targets           text[] not null default '{}',
  impact            jsonb not null default '[]'::jsonb,
  basis             jsonb not null default '{}'::jsonb,
  confidence        text not null check (confidence in ('high', 'medium', 'low')),
  confidence_reason text,
  effort            text not null check (effort in ('S', 'M', 'L')),
  cost_note         text,
  affects           jsonb not null default '{}'::jsonb,
  constraints       jsonb not null default '[]'::jsonb,
  score             numeric not null,
  status            public.proposal_status not null default 'open',
  decided_by        uuid references auth.users(id) on delete set null,
  decided_at        timestamptz,
  decision_note     text,
  review_acknowledged boolean not null default false,
  decision_id       uuid references public.decisions(id),
  carried_from      uuid references public.proposals(id) on delete set null,
  created_at        timestamptz not null default now(),
  unique (run_id, fingerprint)
);
create index proposals_project_idx on public.proposals (project_id, fingerprint);

alter table public.optimization_runs enable row level security;
alter table public.proposals enable row level security;
-- Engineering and commercial detail: project staff (open decision: whether clients see proposals).
create policy "staff read optimization runs" on public.optimization_runs for select to authenticated using (public.is_project_staff(project_id));
create policy "staff read proposals" on public.proposals for select to authenticated using (public.is_project_staff(project_id));
grant select on public.optimization_runs, public.proposals to authenticated;
grant all on public.optimization_runs, public.proposals to service_role;

create function public.request_optimization(p_project_id uuid, p_settings jsonb default '{}'::jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_no integer;
begin
  if not public.has_project_role(p_project_id, '{owner,engineer}') then
    raise exception 'only owners and engineers of the project can ask for an optimization analysis' using errcode = '42501';
  end if;
  if jsonb_typeof(coalesce(p_settings, '{}'::jsonb)) <> 'object' then raise exception 'settings must be an object'; end if;
  perform pg_advisory_xact_lock(hashtext('optimize:' || p_project_id::text));
  if exists (select 1 from public.optimization_runs where project_id = p_project_id and status in ('queued', 'running')) then
    raise exception 'an analysis is already running for this project';
  end if;
  select coalesce(max(run_no), 0) + 1 into v_no from public.optimization_runs where project_id = p_project_id;
  insert into public.optimization_runs (project_id, run_no, settings) values (p_project_id, v_no, coalesce(p_settings, '{}'::jsonb)) returning id into v_id;
  perform public.worker_audit(p_project_id, 'optimization.requested', 'optimization_run', v_id, jsonb_build_object('run_no', v_no, 'settings', p_settings));
  return v_id;
end;
$$;

create function public.claim_optimization(p_worker_id text, p_stale_seconds integer default 600) returns public.optimization_runs
language plpgsql security definer set search_path = '' as $$
declare v public.optimization_runs;
begin
  update public.optimization_runs set status = 'failed', error = 'gave up after 3 attempts', claimed_by = null, completed_at = now()
   where status = 'running' and claimed_at < now() - make_interval(secs => p_stale_seconds) and attempts >= 3;
  select * into v from public.optimization_runs
   where status = 'queued' or (status = 'running' and claimed_at < now() - make_interval(secs => p_stale_seconds))
   order by requested_at for update skip locked limit 1;
  if v.id is null then return null; end if;
  update public.optimization_runs set status = 'running', claimed_by = p_worker_id, claimed_at = now(), attempts = attempts + 1
   where id = v.id returning * into v;
  return v;
end;
$$;

-- p_result: {proposals: [...], excluded: [...], summary: {...}} as produced by @vx/optimize.
create function public.complete_optimization(p_run_id uuid, p_worker_id text, p_inputs jsonb, p_result jsonb, p_error text default null)
returns public.optimization_status
language plpgsql security definer set search_path = '' as $$
declare v public.optimization_runs; n integer;
begin
  select * into v from public.optimization_runs where id = p_run_id for update;
  if v.status <> 'running' or v.claimed_by is distinct from p_worker_id then
    raise exception 'analysis % is not being run by %', p_run_id, p_worker_id using hint = 'lease_lost';
  end if;
  if p_error is not null then
    update public.optimization_runs set status = 'failed', error = p_error, inputs = coalesce(p_inputs, '{}'::jsonb), claimed_by = null, completed_at = now() where id = v.id;
    return 'failed';
  end if;
  -- Open proposals of earlier analyses are replaced by this one.
  update public.proposals set status = 'superseded' where project_id = v.project_id and status = 'open';
  insert into public.proposals (run_id, project_id, rank, fingerprint, objective, title, subject, change, targets, impact, basis,
                                confidence, confidence_reason, effort, cost_note, affects, constraints, score)
  select v.id, v.project_id, (p ->> 'rank')::integer, p ->> 'fingerprint', p ->> 'objective', p ->> 'title', p ->> 'subject', p -> 'change',
         coalesce(array(select jsonb_array_elements_text(p -> 'targets')), '{}'), coalesce(p -> 'impact', '[]'::jsonb), coalesce(p -> 'basis', '{}'::jsonb),
         p ->> 'confidence', p ->> 'confidence_reason', p ->> 'effort', p ->> 'cost_note', coalesce(p -> 'affects', '{}'::jsonb),
         coalesce(p -> 'constraints', '[]'::jsonb), (p ->> 'score')::numeric
    from jsonb_array_elements(coalesce(p_result -> 'proposals', '[]'::jsonb)) p;
  get diagnostics n = row_count;
  if exists (select 1 from public.proposals where run_id = v.id and constraints @> '[{"status": "violated"}]') then
    raise exception 'a proposal that violates a hard constraint cannot be offered';
  end if;
  -- Carry earlier decisions over (same change → same fingerprint): a rejected idea is not offered again.
  update public.proposals np set status = op.status, decided_by = op.decided_by, decided_at = op.decided_at,
         decision_note = 'carried over from analysis ' || (select run_no from public.optimization_runs where id = op.run_id) || ': ' || coalesce(op.decision_note, ''),
         decision_id = op.decision_id, carried_from = op.id
    from (select distinct on (fingerprint) * from public.proposals
           where project_id = v.project_id and status in ('accepted', 'rejected') and run_id <> v.id
           order by fingerprint, decided_at desc) op
   where np.run_id = v.id and np.fingerprint = op.fingerprint;
  update public.optimization_runs set status = 'ready', inputs = coalesce(p_inputs, '{}'::jsonb), summary = coalesce(p_result -> 'summary', '{}'::jsonb),
         excluded = coalesce(p_result -> 'excluded', '[]'::jsonb), error = null, claimed_by = null, completed_at = now() where id = v.id;
  perform public.worker_audit(v.project_id, 'optimization.completed', 'optimization_run', v.id,
                              jsonb_build_object('proposals', n, 'excluded', jsonb_array_length(coalesce(p_result -> 'excluded', '[]'::jsonb)), 'inputs', p_inputs));
  return 'ready';
end;
$$;

-- The approval control. Accepting records a decision (change control) for the next design revision; constraints that
-- need an engineer's review must be acknowledged; rejecting needs a reason.
create function public.decide_proposal(p_proposal_id uuid, p_accept boolean, p_note text default null, p_review_acknowledged boolean default false)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare p public.proposals; v_decision uuid; v_class public.decision_class; v_assumed boolean; v_run public.optimization_runs;
begin
  select * into p from public.proposals where id = p_proposal_id for update;
  if p.id is null or not public.has_project_role(p.project_id, '{owner,reviewer}') then
    raise exception 'only owners and reviewers of the project can decide proposals' using errcode = '42501';
  end if;
  if p.status <> 'open' then raise exception 'this proposal is %', p.status; end if;
  if not p_accept then
    if coalesce(trim(p_note), '') = '' then raise exception 'say why the proposal is rejected'; end if;
    update public.proposals set status = 'rejected', decided_by = auth.uid(), decided_at = now(), decision_note = trim(p_note) where id = p.id;
    perform public.worker_audit(p.project_id, 'proposal.rejected', 'proposal', p.id, jsonb_build_object('title', p.title, 'note', p_note));
    return null;
  end if;
  if p.constraints @> '[{"status": "needs_review"}]' and not coalesce(p_review_acknowledged, false) then
    raise exception 'confirm that the constraints marked for review have been checked';
  end if;
  select * into v_run from public.optimization_runs where id = p.run_id;
  v_class := case p.objective when 'cost' then 'bom_budget' when 'consolidation' then 'passive_substitution'
                              when 'power' then 'power_architecture' when 'standby' then 'power_architecture'
                              when 'thermal' then 'other' else 'component_selection' end::public.decision_class;
  v_assumed := jsonb_array_length(coalesce(p.basis -> 'assumptions', '[]'::jsonb)) > 0;
  insert into public.decisions (project_id, decision_class, title, statement, rationale, alternatives, evidence_category, evidence_refs)
  values (p.project_id, v_class, p.title,
          format('%s → %s (%s). To be implemented in the next design revision.', p.change ->> 'from', p.change ->> 'to', p.subject),
          p_note, jsonb_build_array(jsonb_build_object('kept', p.change ->> 'from')),
          case when v_assumed then 'unverified_assumption' else 'deterministic_calculation' end::public.evidence_category,
          jsonb_build_array(jsonb_build_object('proposal', p.id, 'analysis', v_run.run_no, 'inputs', v_run.inputs, 'impact', p.impact,
                                               'basis', p.basis, 'constraints_reviewed', coalesce(p_review_acknowledged, false))))
  returning id into v_decision;
  update public.proposals set status = 'accepted', decided_by = auth.uid(), decided_at = now(), decision_note = nullif(trim(coalesce(p_note, '')), ''),
         review_acknowledged = coalesce(p_review_acknowledged, false), decision_id = v_decision where id = p.id;
  perform public.worker_audit(p.project_id, 'proposal.accepted', 'proposal', p.id,
                              jsonb_build_object('title', p.title, 'decision', v_decision, 'note', p_note, 'review_acknowledged', p_review_acknowledged));
  return v_decision;
end;
$$;

revoke all on function public.request_optimization, public.decide_proposal from public, anon;
grant execute on function public.request_optimization, public.decide_proposal to authenticated;
revoke all on function public.claim_optimization, public.complete_optimization from public, anon, authenticated;
grant execute on function public.claim_optimization, public.complete_optimization to service_role;
