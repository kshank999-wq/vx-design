-- Build and validation evidence (S6, spec §3.1 and the test_results catalog in §8).
--
-- Units are the physical prototypes, each with a serial number and the design revision it was built from. Test
-- procedures are versioned: a draft is edited, approved by an owner or reviewer, then frozen (changes make a new
-- version). A test run records one procedure on one unit: conditions (temperature, supply, firmware, equipment and
-- calibration), measurements, and evidence files. Each measurement's verdict, and the run's, are computed here from
-- the approved procedure's limits, never typed in; runs are immutable (a correction is a new run that supersedes the
-- old one). A failing run opens a fault, which is closed only by a passing run of the same procedure. The verification
-- matrix shows, per requirement, which procedures cover it and what the latest results on each unit say. Hardware test
-- evidence is evidence, not certification (§15).

create type public.test_stage as enum ('incoming_inspection', 'bring_up', 'functional', 'firmware', 'fit_finish', 'environmental', 'other');
create type public.unit_status as enum ('built', 'in_test', 'passed', 'failed', 'reworked', 'scrapped');
create type public.procedure_status as enum ('draft', 'approved', 'superseded');
create type public.measure_verdict as enum ('pass', 'fail', 'info', 'missing');
create type public.run_verdict as enum ('pass', 'fail', 'incomplete');
create type public.fault_status as enum ('open', 'corrected', 'verified', 'wont_fix');

create table public.units (
  id                   uuid primary key default gen_random_uuid(),
  project_id           uuid not null references public.projects(id) on delete cascade,
  serial               text not null check (serial ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$'),
  revision             text not null check (length(trim(revision)) between 1 and 40),
  built_from_version_id uuid references public.artifact_versions(id),
  lot                  text,
  assembled_by         text,
  received_at          date,
  notes                text,
  status               public.unit_status not null default 'built',
  created_by           uuid references auth.users(id) on delete set null default auth.uid(),
  created_at           timestamptz not null default now(),
  unique (project_id, serial)
);

create table public.test_procedures (
  id                uuid primary key default gen_random_uuid(),
  project_id        uuid not null references public.projects(id) on delete cascade,
  code              text not null check (code ~ '^TP-[0-9]{3,}$'),
  version           integer not null default 1,
  title             text not null check (length(trim(title)) between 1 and 200),
  stage             public.test_stage not null,
  requirement_refs  text[] not null default '{}',
  setup             text,                            -- equipment, fixtures, firmware to load
  steps             text,
  measurements      jsonb not null default '[]'::jsonb,
  -- [{key, label, kind: numeric|boolean|text, unit, min, max, expected, requirement_ref, basis}]
  status            public.procedure_status not null default 'draft',
  supersedes_id     uuid unique references public.test_procedures(id),
  approved_by       uuid references auth.users(id) on delete set null,
  approved_at       timestamptz,
  created_by        uuid references auth.users(id) on delete set null default auth.uid(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (project_id, code, version),
  check (status = 'draft' or approved_at is not null)
);
create trigger test_procedures_updated_at before update on public.test_procedures for each row execute function public.set_updated_at();

-- Approved procedures are frozen: only approved → superseded may change.
create function public.protect_procedure() returns trigger
language plpgsql as $$
begin
  if old.status = 'draft' then return new; end if;
  if old.status = 'approved' and new.status = 'superseded'
     and (new.measurements, new.steps, new.setup, new.title, new.requirement_refs, new.stage)
         is not distinct from (old.measurements, old.steps, old.setup, old.title, old.requirement_refs, old.stage) then
    return new;
  end if;
  raise exception 'procedure %-v% is % and cannot be changed (revise it to make a new version)', old.code, old.version, old.status;
end;
$$;
create trigger test_procedures_protect before update on public.test_procedures for each row execute function public.protect_procedure();

create table public.test_runs (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references public.projects(id) on delete cascade,
  run_no         integer not null,
  unit_id        uuid not null references public.units(id),
  procedure_id   uuid not null references public.test_procedures(id),
  performed_by   uuid references auth.users(id) on delete set null default auth.uid(),
  performed_at   timestamptz not null,
  recorded_at    timestamptz not null default now(),
  conditions     jsonb not null default '{}'::jsonb,  -- {temperature_c, supply_v, firmware, location, equipment: [{name, id, calibrated_until}]}
  notes          text,
  verdict        public.run_verdict not null,
  supersedes_id  uuid unique references public.test_runs(id),
  unique (project_id, run_no)
);
create index test_runs_unit_idx on public.test_runs (unit_id, procedure_id, performed_at);

create table public.test_measurements (
  run_id          uuid not null references public.test_runs(id) on delete cascade,
  project_id      uuid not null references public.projects(id) on delete cascade,
  key             text not null,
  label           text not null,
  kind            text not null,
  value_num       numeric,
  value_text      text,
  unit            text,
  min             numeric,
  max             numeric,
  expected        text,
  requirement_ref text,
  verdict         public.measure_verdict not null,
  primary key (run_id, key)
);

create table public.test_evidence (
  id           uuid primary key default gen_random_uuid(),
  run_id       uuid not null references public.test_runs(id) on delete cascade,
  project_id   uuid not null references public.projects(id) on delete cascade,
  name         text not null,
  kind         text not null check (kind in ('photo', 'scope', 'log', 'data', 'report', 'other')),
  storage_path text not null,
  sha256       text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes   bigint not null,
  added_by     uuid references auth.users(id) on delete set null default auth.uid(),
  added_at     timestamptz not null default now(),
  unique (run_id, sha256)
);

create table public.faults (
  id               uuid primary key default gen_random_uuid(),
  project_id       uuid not null references public.projects(id) on delete cascade,
  fault_no         integer not null,
  unit_id          uuid references public.units(id),
  run_id           uuid references public.test_runs(id),
  title            text not null,
  description      text,
  severity         text not null default 'major' check (severity in ('critical', 'major', 'minor')),
  status           public.fault_status not null default 'open',
  root_cause       text,
  correction_kind  text check (correction_kind in ('rework', 'design_change', 'firmware', 'procedure', 'component', 'none')),
  correction       text,
  decision_id      uuid references public.decisions(id),
  verified_by_run  uuid references public.test_runs(id),
  opened_by        uuid references auth.users(id) on delete set null default auth.uid(),
  opened_at        timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (project_id, fault_no),
  check (status <> 'verified' or verified_by_run is not null),
  check (status not in ('corrected', 'verified') or (correction is not null and correction_kind is not null))
);
create trigger faults_updated_at before update on public.faults for each row execute function public.set_updated_at();

create trigger test_runs_immutable before update or delete on public.test_runs for each row execute function public.forbid_modification();
create trigger test_measurements_immutable before update or delete on public.test_measurements for each row execute function public.forbid_modification();
create trigger test_evidence_immutable before update or delete on public.test_evidence for each row execute function public.forbid_modification();

-- Every member, clients included, reads validation evidence; writes go through the functions below.
alter table public.units enable row level security;
alter table public.test_procedures enable row level security;
alter table public.test_runs enable row level security;
alter table public.test_measurements enable row level security;
alter table public.test_evidence enable row level security;
alter table public.faults enable row level security;
create policy "members read units" on public.units for select to authenticated using (public.is_project_member(project_id));
create policy "members read procedures" on public.test_procedures for select to authenticated using (public.is_project_member(project_id));
create policy "members read test runs" on public.test_runs for select to authenticated using (public.is_project_member(project_id));
create policy "members read measurements" on public.test_measurements for select to authenticated using (public.is_project_member(project_id));
create policy "members read evidence" on public.test_evidence for select to authenticated using (public.is_project_member(project_id));
create policy "members read faults" on public.faults for select to authenticated using (public.is_project_member(project_id));
grant select on public.units, public.test_procedures, public.test_runs, public.test_measurements, public.test_evidence, public.faults to authenticated;
grant all on public.units, public.test_procedures, public.test_runs, public.test_measurements, public.test_evidence, public.faults to service_role;

-- Evidence files are uploads: inspected at upload and virus-scanned like the others.
create or replace function public.is_upload_path(p_bucket text, p_name text) returns boolean
language sql immutable set search_path = '' as $$
  select p_bucket = 'knowledge-files' or (p_bucket = 'project-files' and split_part(p_name, '/', 2) in ('documents', 'models', 'sources', 'flux', 'evidence'));
$$;

create function public.need_role(p_project_id uuid, p_roles public.project_role[], p_what text) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.has_project_role(p_project_id, p_roles) then
    raise exception 'only % of the project can %', array_to_string(p_roles, ', '), p_what using errcode = '42501';
  end if;
end;
$$;
revoke all on function public.need_role from public, anon, authenticated;

create function public.create_unit(p_project_id uuid, p_serial text, p_revision text, p_built_from uuid default null, p_lot text default null,
                                   p_assembled_by text default null, p_received_at date default null, p_notes text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform public.need_role(p_project_id, '{owner,engineer}', 'register units');
  if p_built_from is not null and not exists (select 1 from public.artifact_versions where id = p_built_from and project_id = p_project_id and status = 'committed') then
    raise exception 'the unit must be built from an approved (committed) file of this project';
  end if;
  insert into public.units (project_id, serial, revision, built_from_version_id, lot, assembled_by, received_at, notes)
  values (p_project_id, trim(p_serial), trim(p_revision), p_built_from, nullif(trim(coalesce(p_lot, '')), ''), nullif(trim(coalesce(p_assembled_by, '')), ''), p_received_at,
          nullif(trim(coalesce(p_notes, '')), ''))
  returning id into v_id;
  perform public.worker_audit(p_project_id, 'unit.registered', 'unit', v_id, jsonb_build_object('serial', p_serial, 'revision', p_revision, 'built_from', p_built_from));
  return v_id;
end;
$$;

create function public.set_unit_status(p_unit_id uuid, p_status public.unit_status, p_note text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare u public.units;
begin
  select * into u from public.units where id = p_unit_id;
  if u.id is null then raise exception 'unit not found'; end if;
  perform public.need_role(u.project_id, '{owner,engineer}', 'change unit status');
  update public.units set status = p_status where id = u.id;
  perform public.worker_audit(u.project_id, 'unit.status', 'unit', u.id, jsonb_build_object('serial', u.serial, 'status', p_status, 'note', p_note));
end;
$$;

-- Measurement definitions must be well formed: unique keys, a kind, min ≤ max.
create function public.check_measurement_defs(p jsonb) returns void
language plpgsql immutable set search_path = '' as $$
declare m jsonb; keys text[] := '{}';
begin
  if jsonb_typeof(p) <> 'array' then raise exception 'measurements must be a list'; end if;
  for m in select * from jsonb_array_elements(p) loop
    if coalesce(m ->> 'key', '') !~ '^[a-z][a-z0-9_]{0,40}$' then raise exception 'measurement key "%" must be lower case letters, digits and _', m ->> 'key'; end if;
    if (m ->> 'key') = any (keys) then raise exception 'measurement key "%" is used twice', m ->> 'key'; end if;
    keys := keys || (m ->> 'key');
    if coalesce(m ->> 'kind', '') not in ('numeric', 'boolean', 'text') then raise exception 'measurement "%" needs a kind (numeric, boolean or text)', m ->> 'key'; end if;
    if m ? 'min' and m ? 'max' and (m ->> 'min') is not null and (m ->> 'max') is not null and (m ->> 'min')::numeric > (m ->> 'max')::numeric then
      raise exception 'measurement "%": min is above max', m ->> 'key';
    end if;
  end loop;
end;
$$;

-- Creates (p_id null) or edits a draft procedure.
create function public.save_procedure(p_project_id uuid, p_id uuid, p_title text, p_stage public.test_stage, p_requirement_refs text[],
                                      p_setup text, p_steps text, p_measurements jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_code text; p public.test_procedures;
begin
  perform public.need_role(p_project_id, '{owner,engineer}', 'write test procedures');
  perform public.check_measurement_defs(coalesce(p_measurements, '[]'::jsonb));
  if exists (select 1 from unnest(coalesce(p_requirement_refs, '{}')) r where not exists
               (select 1 from public.requirements q where q.project_id = p_project_id and q.ref_code = r)) then
    raise exception 'unknown requirement reference';
  end if;
  if p_id is null then
    perform pg_advisory_xact_lock(hashtext('tp:' || p_project_id::text));
    select 'TP-' || lpad((coalesce(max(substr(code, 4)::integer), 0) + 1)::text, 3, '0') into v_code from public.test_procedures where project_id = p_project_id;
    insert into public.test_procedures (project_id, code, title, stage, requirement_refs, setup, steps, measurements)
    values (p_project_id, v_code, trim(p_title), p_stage, coalesce(p_requirement_refs, '{}'), p_setup, p_steps, coalesce(p_measurements, '[]'::jsonb))
    returning id into v_id;
    return v_id;
  end if;
  select * into p from public.test_procedures where id = p_id and project_id = p_project_id;
  if p.id is null then raise exception 'procedure not found'; end if;
  if p.status <> 'draft' then raise exception 'procedure %-v% is approved: revise it to make a new version', p.code, p.version; end if;
  update public.test_procedures set title = trim(p_title), stage = p_stage, requirement_refs = coalesce(p_requirement_refs, '{}'), setup = p_setup,
         steps = p_steps, measurements = coalesce(p_measurements, '[]'::jsonb) where id = p.id;
  return p.id;
end;
$$;

create function public.approve_procedure(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare p public.test_procedures;
begin
  select * into p from public.test_procedures where id = p_id for update;
  if p.id is null then raise exception 'procedure not found'; end if;
  perform public.need_role(p.project_id, '{owner,reviewer}', 'approve test procedures');
  if p.status <> 'draft' then raise exception 'only a draft can be approved'; end if;
  if jsonb_array_length(p.measurements) = 0 then raise exception 'add at least one measurement or check before approving'; end if;
  if p.supersedes_id is not null then update public.test_procedures set status = 'superseded' where id = p.supersedes_id; end if;
  update public.test_procedures set status = 'approved', approved_by = auth.uid(), approved_at = now() where id = p.id;
  perform public.worker_audit(p.project_id, 'procedure.approved', 'test_procedure', p.id,
                              jsonb_build_object('code', p.code, 'version', p.version, 'measurements', p.measurements, 'requirements', p.requirement_refs));
end;
$$;

create function public.revise_procedure(p_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare p public.test_procedures; v_id uuid;
begin
  select * into p from public.test_procedures where id = p_id;
  if p.id is null then raise exception 'procedure not found'; end if;
  perform public.need_role(p.project_id, '{owner,engineer}', 'revise test procedures');
  if p.status <> 'approved' then raise exception 'only the approved version can be revised'; end if;
  if exists (select 1 from public.test_procedures where supersedes_id = p.id) then raise exception 'a revision of %-v% already exists', p.code, p.version; end if;
  insert into public.test_procedures (project_id, code, version, title, stage, requirement_refs, setup, steps, measurements, supersedes_id)
  values (p.project_id, p.code, p.version + 1, p.title, p.stage, p.requirement_refs, p.setup, p.steps, p.measurements, p.id) returning id into v_id;
  return v_id;
end;
$$;

-- One measurement against its approved definition.
create function public.judge(def jsonb, val jsonb) returns public.measure_verdict
language plpgsql immutable set search_path = '' as $$
declare kind text := def ->> 'kind'; v numeric;
begin
  if val is null or val = 'null'::jsonb or (jsonb_typeof(val) = 'string' and btrim(val #>> '{}') = '') then return 'missing'; end if;
  if kind = 'numeric' then
    begin v := (val #>> '{}')::numeric; exception when others then raise exception 'measurement "%" must be a number', def ->> 'key'; end;
    if (def ->> 'min') is null and (def ->> 'max') is null then return 'info'; end if;
    if ((def ->> 'min') is not null and v < (def ->> 'min')::numeric) or ((def ->> 'max') is not null and v > (def ->> 'max')::numeric) then return 'fail'; end if;
    return 'pass';
  elsif kind = 'boolean' then
    if lower(val #>> '{}') not in ('true', 'false', 'yes', 'no', 'pass', 'fail') then raise exception 'measurement "%" must be yes or no', def ->> 'key'; end if;
    if (def ->> 'expected') is null then return 'info'; end if;
    return case when (lower(val #>> '{}') in ('true', 'yes', 'pass')) = (lower(def ->> 'expected') in ('true', 'yes', 'pass')) then 'pass' else 'fail' end::public.measure_verdict;
  else
    if (def ->> 'expected') is null then return 'info'; end if;
    return case when lower(btrim(val #>> '{}')) = lower(btrim(def ->> 'expected')) then 'pass' else 'fail' end::public.measure_verdict;
  end if;
end;
$$;

-- p_values: {key: value}. Verdicts come from the approved procedure; a failing run opens a fault.
create function public.record_test_run(p_unit_id uuid, p_procedure_id uuid, p_performed_at timestamptz, p_conditions jsonb, p_values jsonb,
                                       p_notes text default null, p_supersedes uuid default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare u public.units; p public.test_procedures; v_id uuid; v_no integer; d jsonb; v public.measure_verdict; v_run public.run_verdict;
        fails text[] := '{}'; missing integer := 0; extra text[]; old public.test_runs; v_fault integer; judged jsonb := '[]'::jsonb;
begin
  select * into u from public.units where id = p_unit_id;
  select * into p from public.test_procedures where id = p_procedure_id;
  if u.id is null or p.id is null or u.project_id <> p.project_id then raise exception 'unit or procedure not found'; end if;
  perform public.need_role(u.project_id, '{owner,engineer,reviewer}', 'record test results');
  if p.status <> 'approved' then raise exception 'tests are recorded against the approved version of a procedure (%-v% is %)', p.code, p.version, p.status; end if;
  if u.status = 'scrapped' then raise exception 'unit % is scrapped', u.serial; end if;
  if p_performed_at is null or p_performed_at > now() + interval '5 minutes' then raise exception 'give when the test was performed (not in the future)'; end if;
  if jsonb_typeof(coalesce(p_values, '{}'::jsonb)) <> 'object' then raise exception 'values must be an object of key: value'; end if;
  select array_agg(k) into extra from jsonb_object_keys(coalesce(p_values, '{}'::jsonb)) k
   where not exists (select 1 from jsonb_array_elements(p.measurements) m where m ->> 'key' = k);
  if extra is not null then raise exception 'values for unknown measurements: %', array_to_string(extra, ', '); end if;
  if p_supersedes is not null then
    select * into old from public.test_runs where id = p_supersedes;
    if old.id is null or old.unit_id <> u.id or old.procedure_id <> p.id then raise exception 'a correction must be for the same unit and procedure'; end if;
    if coalesce(trim(p_notes), '') = '' then raise exception 'say what the correction fixes'; end if;
  end if;
  -- Judge every measurement against the approved definition first, so the run is written once, with its verdict.
  for d in select * from jsonb_array_elements(p.measurements) loop
    v := public.judge(d, p_values -> (d ->> 'key'));
    if v = 'fail' then fails := fails || (d ->> 'label'); end if;
    if v = 'missing' then missing := missing + 1; end if;
    judged := judged || jsonb_build_object('d', d, 'v', v);
  end loop;
  v_run := case when cardinality(fails) > 0 then 'fail' when missing > 0 then 'incomplete' else 'pass' end;
  perform pg_advisory_xact_lock(hashtext('run:' || u.project_id::text));
  select coalesce(max(run_no), 0) + 1 into v_no from public.test_runs where project_id = u.project_id;
  insert into public.test_runs (project_id, run_no, unit_id, procedure_id, performed_at, conditions, notes, verdict, supersedes_id)
  values (u.project_id, v_no, u.id, p.id, p_performed_at, coalesce(p_conditions, '{}'::jsonb), nullif(trim(coalesce(p_notes, '')), ''), v_run, p_supersedes)
  returning id into v_id;
  insert into public.test_measurements (run_id, project_id, key, label, kind, value_num, value_text, unit, min, max, expected, requirement_ref, verdict)
  select v_id, u.project_id, j -> 'd' ->> 'key', coalesce(j -> 'd' ->> 'label', j -> 'd' ->> 'key'), j -> 'd' ->> 'kind',
         case when j -> 'd' ->> 'kind' = 'numeric' and j ->> 'v' <> 'missing' then (p_values ->> (j -> 'd' ->> 'key'))::numeric end,
         case when j -> 'd' ->> 'kind' <> 'numeric' and j ->> 'v' <> 'missing' then p_values ->> (j -> 'd' ->> 'key') end,
         j -> 'd' ->> 'unit', (j -> 'd' ->> 'min')::numeric, (j -> 'd' ->> 'max')::numeric, j -> 'd' ->> 'expected', j -> 'd' ->> 'requirement_ref',
         (j ->> 'v')::public.measure_verdict
    from jsonb_array_elements(judged) j;
  update public.units set status = case when v_run = 'fail' then 'failed'::public.unit_status
                                        when status in ('built') then 'in_test'::public.unit_status else status end where id = u.id;
  if v_run = 'fail' then
    select coalesce(max(fault_no), 0) + 1 into v_fault from public.faults where project_id = u.project_id;
    insert into public.faults (project_id, fault_no, unit_id, run_id, title, severity)
    values (u.project_id, v_fault, u.id, v_id, format('%s failed on %s: %s', p.code, u.serial, array_to_string(fails, ', ')), 'major');
  end if;
  perform public.worker_audit(u.project_id, 'test.recorded', 'test_run', v_id, jsonb_build_object('run_no', v_no, 'unit', u.serial, 'procedure', p.code || '-v' || p.version,
                              'verdict', v_run, 'supersedes', p_supersedes));
  return v_id;
end;
$$;

create function public.add_test_evidence(p_run_id uuid, p_name text, p_kind text, p_path text, p_sha256 text, p_size bigint) returns uuid
language plpgsql security definer set search_path = '' as $$
declare r public.test_runs; v_id uuid;
begin
  select * into r from public.test_runs where id = p_run_id;
  if r.id is null then raise exception 'test run not found'; end if;
  perform public.need_role(r.project_id, '{owner,engineer}', 'attach evidence');
  if p_path not like r.project_id::text || '/evidence/' || r.id::text || '/%' then raise exception 'evidence must be stored in the run''s folder'; end if;
  insert into public.test_evidence (run_id, project_id, name, kind, storage_path, sha256, size_bytes)
  values (r.id, r.project_id, p_name, p_kind, p_path, lower(p_sha256), p_size)
  on conflict (run_id, sha256) do nothing returning id into v_id;
  perform public.worker_audit(r.project_id, 'test.evidence_added', 'test_run', r.id, jsonb_build_object('name', p_name, 'sha256', p_sha256));
  return v_id;
end;
$$;

-- Fault workflow: open → corrected (with what was done) → verified (by a passing run of the failing procedure on the
-- same unit, recorded after the fault was opened), or won't fix (owner, with a reason).
create function public.update_fault(p_fault_id uuid, p_status public.fault_status, p_root_cause text default null, p_correction_kind text default null,
                                    p_correction text default null, p_verified_by_run uuid default null, p_note text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare f public.faults; fr public.test_runs; vr public.test_runs;
begin
  select * into f from public.faults where id = p_fault_id for update;
  if f.id is null then raise exception 'fault not found'; end if;
  perform public.need_role(f.project_id, case when p_status = 'wont_fix' then '{owner}'::public.project_role[] else '{owner,engineer}'::public.project_role[] end, 'update this fault');
  if p_status = 'verified' then
    select * into fr from public.test_runs where id = f.run_id;
    select * into vr from public.test_runs where id = p_verified_by_run;
    if vr.id is null or vr.verdict <> 'pass' or vr.unit_id <> f.unit_id or vr.run_no <= fr.run_no
       or (select code from public.test_procedures where id = vr.procedure_id) <> (select code from public.test_procedures where id = fr.procedure_id) then
      raise exception 'a fault is verified by a later passing run of the same procedure on the same unit';
    end if;
  end if;
  if p_status = 'wont_fix' and coalesce(trim(p_note), '') = '' then raise exception 'say why it will not be fixed'; end if;
  update public.faults set status = p_status, root_cause = coalesce(nullif(trim(coalesce(p_root_cause, '')), ''), root_cause),
         correction_kind = coalesce(p_correction_kind, correction_kind), correction = coalesce(nullif(trim(coalesce(p_correction, '')), ''), correction),
         verified_by_run = coalesce(p_verified_by_run, verified_by_run) where id = f.id;
  if p_status = 'verified' then update public.units set status = 'reworked' where id = f.unit_id and status = 'failed'; end if;
  perform public.worker_audit(f.project_id, 'fault.' || p_status, 'fault', f.id, jsonb_build_object('fault_no', f.fault_no, 'correction', p_correction,
                              'verified_by_run', p_verified_by_run, 'note', p_note));
end;
$$;

-- Verification matrix: per requirement, the approved procedures that cover it and the latest result on each unit.
-- 'verified' needs at least one passing unit and no unit whose latest run of a covering procedure failed.
create function public.requirement_verification(p_project_id uuid)
returns table (ref_code text, text text, procedures text[], units_passed integer, units_failed integer, units_incomplete integer,
               last_run_at timestamptz, status text)
language sql stable set search_path = '' as $$
  with cover as (
    select r.ref_code, p.id as procedure_id, p.code from public.requirements r
      join public.test_procedures p on p.project_id = r.project_id and p.status = 'approved'
       and (r.ref_code = any (p.requirement_refs) or exists (select 1 from jsonb_array_elements(p.measurements) m where m ->> 'requirement_ref' = r.ref_code))
     where r.project_id = p_project_id
  ), latest as (
    select distinct on (c.ref_code, t.unit_id, c.code) c.ref_code, t.unit_id, t.verdict, t.performed_at
      from cover c join public.test_procedures pp on pp.project_id = p_project_id and pp.code = c.code
      join public.test_runs t on t.procedure_id = pp.id
      join public.units u on u.id = t.unit_id and u.status <> 'scrapped'
     order by c.ref_code, t.unit_id, c.code, t.performed_at desc, t.run_no desc
  ), per_unit as (
    select ref_code, unit_id,
           case when bool_or(verdict = 'fail') then 'fail' when bool_and(verdict = 'pass') then 'pass' else 'incomplete' end as v,
           max(performed_at) as at
      from latest group by ref_code, unit_id
  )
  select r.ref_code, r.text,
         coalesce((select array_agg(distinct c.code order by c.code) from cover c where c.ref_code = r.ref_code), '{}'),
         (select count(*)::integer from per_unit x where x.ref_code = r.ref_code and x.v = 'pass'),
         (select count(*)::integer from per_unit x where x.ref_code = r.ref_code and x.v = 'fail'),
         (select count(*)::integer from per_unit x where x.ref_code = r.ref_code and x.v = 'incomplete'),
         (select max(at) from per_unit x where x.ref_code = r.ref_code),
         case when not exists (select 1 from cover c where c.ref_code = r.ref_code) then 'no_procedure'
              when exists (select 1 from per_unit x where x.ref_code = r.ref_code and x.v = 'fail') then 'failing'
              when exists (select 1 from per_unit x where x.ref_code = r.ref_code and x.v = 'pass') then 'verified'
              when exists (select 1 from per_unit x where x.ref_code = r.ref_code) then 'incomplete'
              else 'not_tested' end
    from public.requirements r
   where r.project_id = p_project_id and r.status <> 'rejected'
   order by r.ref_code;
$$;

revoke all on function public.create_unit, public.set_unit_status, public.save_procedure, public.approve_procedure, public.revise_procedure,
  public.record_test_run, public.add_test_evidence, public.update_fault, public.requirement_verification from public, anon;
grant execute on function public.create_unit, public.set_unit_status, public.save_procedure, public.approve_procedure, public.revise_procedure,
  public.record_test_run, public.add_test_evidence, public.update_fault, public.requirement_verification to authenticated, service_role;
revoke all on function public.check_measurement_defs(jsonb), public.judge(jsonb, jsonb), public.protect_procedure() from public, anon, authenticated;
revoke all on function public.is_upload_path(text, text) from public, anon;
grant execute on function public.is_upload_path(text, text) to authenticated, service_role;
