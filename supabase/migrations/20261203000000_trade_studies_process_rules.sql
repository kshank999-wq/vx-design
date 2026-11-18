-- Manufacturer process rules (S4/S5) and trade studies (S2).
--
-- Process rules: each manufacturer's stated limits per process (bare PCB, assembly, printing, CNC, sheet metal,
-- molding), with where they were read and when. The design is checked against them in @vx/dfm (board facts from the
-- committed fab package's check file, enclosure facts from the fit report). Anyone who may use the directory can add or
-- change rules; a change clears the verification, and a library editor verifies them against the source.
--
-- Trade studies: a question, weighted criteria, options and scores (each with its basis), ranked deterministically by
-- @vx/planning. A study is edited as a draft; deciding it (owners and reviewers, with a rationale) records a project
-- decision (change control) holding the ranking and scores as evidence, and freezes the study.

create table public.process_rules (
  id              uuid primary key default gen_random_uuid(),
  manufacturer_id uuid not null references public.manufacturers (id) on delete cascade,
  process         text not null check (process in ('pcb_fab', 'pcb_assembly', 'fdm', 'sla', 'sls', 'cnc', 'sheet_metal', 'injection_molding')),
  rules           jsonb not null default '{}'::jsonb check (jsonb_typeof(rules) = 'object'),
  source_url      text check (source_url is null or source_url ~ '^https://'),
  source_note     text,
  checked_on      date,                       -- when the source was read
  verified_by     uuid references auth.users (id) on delete set null,
  verified_at     timestamptz,
  updated_by      uuid references auth.users (id) on delete set null default auth.uid(),
  updated_at      timestamptz not null default now(),
  unique (manufacturer_id, process)
);
alter table public.process_rules enable row level security;
create policy "directory users read process rules" on public.process_rules for select to authenticated using (public.is_directory_user());
grant select on public.process_rules to authenticated;
grant all on public.process_rules to service_role;

create function public.save_process_rules(p_manufacturer uuid, p_process text, p_rules jsonb, p_source_url text default null,
                                          p_source_note text default null, p_checked_on date default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  if not public.is_directory_user() then
    raise exception 'only project owners, engineers and library editors can edit the supplier directory' using errcode = '42501';
  end if;
  if not exists (select 1 from public.manufacturers where id = p_manufacturer) then raise exception 'manufacturer not found'; end if;
  if coalesce(trim(p_source_url), '') = '' and coalesce(trim(p_source_note), '') = '' then
    raise exception 'say where the rules come from (their capability page, a quote, an email)';
  end if;
  insert into public.process_rules (manufacturer_id, process, rules, source_url, source_note, checked_on, updated_by, updated_at)
  values (p_manufacturer, p_process, coalesce(p_rules, '{}'), nullif(trim(p_source_url), ''), nullif(trim(p_source_note), ''),
          coalesce(p_checked_on, current_date), auth.uid(), now())
  on conflict (manufacturer_id, process) do update set rules = excluded.rules, source_url = excluded.source_url,
    source_note = excluded.source_note, checked_on = excluded.checked_on, updated_by = excluded.updated_by, updated_at = now(),
    verified_by = null, verified_at = null
  returning id into v_id;
  return v_id;
end;
$$;

create function public.verify_process_rules(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_knowledge_editor() then
    raise exception 'only library editors can verify process rules' using errcode = '42501';
  end if;
  update public.process_rules set verified_by = auth.uid(), verified_at = now() where id = p_id;
  if not found then raise exception 'process rules not found'; end if;
end;
$$;

create function public.delete_process_rules(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_directory_user() then
    raise exception 'only project owners, engineers and library editors can edit the supplier directory' using errcode = '42501';
  end if;
  delete from public.process_rules where id = p_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Trade studies
-- ---------------------------------------------------------------------------
create table public.trade_studies (
  id               uuid primary key default gen_random_uuid(),
  project_id       uuid not null references public.projects (id) on delete cascade,
  study_no         integer not null,
  question         text not null check (length(trim(question)) > 0),
  context          text,
  stage            public.project_stage not null default 'S2',
  decision_class   public.decision_class not null default 'component_selection',
  requirement_refs text[] not null default '{}',
  criteria         jsonb not null default '[]'::jsonb check (jsonb_typeof(criteria) = 'array'),
  options          jsonb not null default '[]'::jsonb check (jsonb_typeof(options) = 'array'),
  scores           jsonb not null default '{}'::jsonb check (jsonb_typeof(scores) = 'object'),
  result           jsonb,
  status           text not null default 'draft' check (status in ('draft', 'decided', 'withdrawn')),
  chosen_option    text,
  decision_id      uuid references public.decisions (id),
  decision_note    text,
  decided_by       uuid references auth.users (id) on delete set null,
  decided_at       timestamptz,
  created_by       uuid references auth.users (id) on delete set null default auth.uid(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (project_id, study_no),
  check (status <> 'decided' or (chosen_option is not null and decision_id is not null))
);
alter table public.trade_studies enable row level security;
create policy "members read trade studies" on public.trade_studies for select to authenticated using (public.is_project_member(project_id));
grant select on public.trade_studies to authenticated;
grant all on public.trade_studies to service_role;

create function public.create_trade_study(p_project uuid, p_question text, p_criteria jsonb default '[]', p_options jsonb default '[]',
                                          p_stage public.project_stage default 'S2',
                                          p_decision_class public.decision_class default 'component_selection') returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  v_no integer;
begin
  if not public.has_project_role(p_project, '{owner,engineer}') then
    raise exception 'only owners and engineers of the project can start a trade study' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtext('trade:' || p_project::text));
  select coalesce(max(study_no), 0) + 1 into v_no from public.trade_studies where project_id = p_project;
  insert into public.trade_studies (project_id, study_no, question, criteria, options, stage, decision_class)
  values (p_project, v_no, trim(p_question), coalesce(p_criteria, '[]'), coalesce(p_options, '[]'), p_stage, p_decision_class)
  returning id into v_id;
  perform public.worker_audit(p_project, 'trade_study.created', 'trade_study', v_id, jsonb_build_object('study_no', v_no, 'question', p_question));
  return v_id;
end;
$$;

-- Keys must be unique and simple; every score must point at a known option and criterion.
create function public.trade_study_problem(p_criteria jsonb, p_options jsonb, p_scores jsonb) returns text
language plpgsql immutable set search_path = '' as $$
declare
  k text;
begin
  if exists (select 1 from jsonb_array_elements(p_criteria) c where coalesce(c ->> 'key', '') !~ '^[a-z0-9_]{1,40}$'
             or coalesce(trim(c ->> 'label'), '') = '' or c ->> 'kind' not in ('lower', 'higher', 'rating', 'must')
             or coalesce((c ->> 'weight')::numeric, -1) not between 0 and 10) then
    return 'each criterion needs a key (a-z, 0-9, _), a label, a kind (lower, higher, rating, must) and a weight 0–10';
  end if;
  if (select count(*) <> count(distinct c ->> 'key') from jsonb_array_elements(p_criteria) c) then return 'criterion keys must be unique'; end if;
  if exists (select 1 from jsonb_array_elements(p_options) o where coalesce(o ->> 'key', '') !~ '^[a-z0-9_]{1,40}$' or coalesce(trim(o ->> 'name'), '') = '') then
    return 'each option needs a key (a-z, 0-9, _) and a name';
  end if;
  if (select count(*) <> count(distinct o ->> 'key') from jsonb_array_elements(p_options) o) then return 'option keys must be unique'; end if;
  for k in select jsonb_object_keys(p_scores) loop
    if not exists (select 1 from jsonb_array_elements(p_options) o where o ->> 'key' = k) then return format('scores for unknown option %s', k); end if;
    if exists (select 1 from jsonb_object_keys(p_scores -> k) ck where not exists (select 1 from jsonb_array_elements(p_criteria) c where c ->> 'key' = ck)) then
      return format('scores for option %s name an unknown criterion', k);
    end if;
  end loop;
  return null;
end;
$$;

create function public.save_trade_study(p_id uuid, p_question text, p_context text, p_requirement_refs text[], p_criteria jsonb,
                                        p_options jsonb, p_scores jsonb, p_result jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  t public.trade_studies;
  v_problem text;
begin
  select * into t from public.trade_studies where id = p_id for update;
  if t.id is null or not public.has_project_role(t.project_id, '{owner,engineer}') then
    raise exception 'trade study not found or not permitted' using errcode = '42501';
  end if;
  if t.status <> 'draft' then raise exception 'the study is %; start a new one to revisit it', t.status; end if;
  v_problem := public.trade_study_problem(coalesce(p_criteria, '[]'), coalesce(p_options, '[]'), coalesce(p_scores, '{}'));
  if v_problem is not null then raise exception '%', v_problem; end if;
  update public.trade_studies set question = coalesce(nullif(trim(p_question), ''), question), context = nullif(trim(p_context), ''),
         requirement_refs = coalesce(p_requirement_refs, '{}'), criteria = coalesce(p_criteria, '[]'), options = coalesce(p_options, '[]'),
         scores = coalesce(p_scores, '{}'), result = p_result, updated_at = now()
   where id = p_id;
end;
$$;

-- Decide: record the choice as a project decision with the ranking and scores as evidence. Owners and reviewers.
create function public.decide_trade_study(p_id uuid, p_option text, p_rationale text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  t public.trade_studies;
  v_name text;
  v_decision uuid;
  v_excluded boolean;
  v_unsourced boolean;
begin
  select * into t from public.trade_studies where id = p_id for update;
  if t.id is null or not public.has_project_role(t.project_id, '{owner,reviewer}') then
    raise exception 'only owners and reviewers of the project can decide a trade study' using errcode = '42501';
  end if;
  if t.status <> 'draft' then raise exception 'the study is already %', t.status; end if;
  if coalesce(trim(p_rationale), '') = '' then raise exception 'give the rationale for the choice'; end if;
  select o ->> 'name' into v_name from jsonb_array_elements(t.options) o where o ->> 'key' = p_option;
  if v_name is null then raise exception 'choose one of the study''s options'; end if;
  if t.result is null then raise exception 'save the study (to rank the options) before deciding it'; end if;
  select coalesce(jsonb_array_length(r -> 'excluded'), 0) > 0 into v_excluded
    from jsonb_array_elements(t.result -> 'ranking') r where r ->> 'key' = p_option;
  if v_excluded then raise exception '% fails a must-have criterion; it cannot be chosen', v_name; end if;
  -- Scores entered by hand without a stated basis make the decision an assumption, not a calculation.
  select exists (select 1 from jsonb_each(t.scores) o, jsonb_each(o.value) s
                  where coalesce(s.value ->> 'source', 'manual') = 'manual' and coalesce(trim(s.value ->> 'basis'), '') = '')
    into v_unsourced;
  insert into public.decisions (project_id, decision_class, title, statement, rationale, alternatives, evidence_category, evidence_refs)
  values (t.project_id, t.decision_class, format('TS-%s: %s', lpad(t.study_no::text, 3, '0'), t.question),
          format('Chose %s.', v_name), trim(p_rationale),
          coalesce((select jsonb_agg(jsonb_build_object('option', r ->> 'name', 'score', r -> 'total', 'excluded', r -> 'excluded'))
                      from jsonb_array_elements(t.result -> 'ranking') r where r ->> 'key' <> p_option), '[]'::jsonb),
          case when v_unsourced then 'unverified_assumption' else 'deterministic_calculation' end::public.evidence_category,
          jsonb_build_array(jsonb_build_object('trade_study', t.id, 'study_no', t.study_no, 'criteria', t.criteria,
                                               'scores', t.scores, 'result', t.result, 'requirement_refs', t.requirement_refs)))
  returning id into v_decision;
  update public.trade_studies set status = 'decided', chosen_option = p_option, decision_id = v_decision,
         decision_note = trim(p_rationale), decided_by = auth.uid(), decided_at = now(), updated_at = now()
   where id = p_id;
  perform public.worker_audit(t.project_id, 'trade_study.decided', 'trade_study', p_id,
    jsonb_build_object('option', p_option, 'decision', v_decision, 'winner', t.result ->> 'winner'));
  return v_decision;
end;
$$;

create function public.withdraw_trade_study(p_id uuid, p_note text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  t public.trade_studies;
begin
  select * into t from public.trade_studies where id = p_id for update;
  if t.id is null or not public.has_project_role(t.project_id, '{owner,engineer}') then
    raise exception 'trade study not found or not permitted' using errcode = '42501';
  end if;
  if t.status <> 'draft' then raise exception 'the study is already %', t.status; end if;
  if coalesce(trim(p_note), '') = '' then raise exception 'say why the study is withdrawn'; end if;
  update public.trade_studies set status = 'withdrawn', decision_note = trim(p_note), updated_at = now() where id = p_id;
  perform public.worker_audit(t.project_id, 'trade_study.withdrawn', 'trade_study', p_id, jsonb_build_object('note', p_note));
end;
$$;

revoke all on function public.trade_study_problem(jsonb, jsonb, jsonb) from public, anon;
grant execute on function public.trade_study_problem(jsonb, jsonb, jsonb) to authenticated, service_role;
revoke all on function public.save_process_rules(uuid, text, jsonb, text, text, date), public.verify_process_rules(uuid),
  public.delete_process_rules(uuid), public.create_trade_study(uuid, text, jsonb, jsonb, public.project_stage, public.decision_class),
  public.save_trade_study(uuid, text, text, text[], jsonb, jsonb, jsonb, jsonb), public.decide_trade_study(uuid, text, text),
  public.withdraw_trade_study(uuid, text) from public, anon;
grant execute on function public.save_process_rules(uuid, text, jsonb, text, text, date), public.verify_process_rules(uuid),
  public.delete_process_rules(uuid), public.create_trade_study(uuid, text, jsonb, jsonb, public.project_stage, public.decision_class),
  public.save_trade_study(uuid, text, text, text[], jsonb, jsonb, jsonb, jsonb), public.decide_trade_study(uuid, text, text),
  public.withdraw_trade_study(uuid, text) to authenticated, service_role;
