-- S7 compliance and production tracking (spec §3.1). Tracking only: the platform records what labs and inspectors
-- report, with their files; it never certifies anything or says a product is compliant.
--
-- Compliance items are the regimes a product must meet in its markets (FCC Part 15, the EU Radio Equipment Directive,
-- RoHS, battery transport tests...). Each item keeps an immutable history of lab results, each with the lab's report
-- file and the released revision that was tested. Marking an item not applicable needs a reason and an owner or
-- reviewer.
--
-- Releases lock a revision: a named set of committed files (the fab package, BOM, enclosure...) frozen with their
-- checksums. Issuing one is checked for readiness (unverified faults, failing requirements, failed compliance) and
-- needs the owner; blockers can only be overridden with a written waiver. A newer release supersedes the older one.
--
-- Production lots (pilot or production) are built from a released revision. Their units are registered with serial
-- numbers and carry the release's revision; each unit's production test is an ordinary S6 test run of the lot's
-- approved procedure. Inspections against the lot's sampling plan (sample size, accept number) are immutable and
-- their verdict is computed here. A lot is accepted only on a passing final inspection. Any serial number traces back
-- to its lot, release, files, test runs and faults.

create type public.compliance_status as enum ('identified', 'in_progress', 'at_lab', 'passed', 'failed', 'not_applicable');
create type public.release_status as enum ('draft', 'released', 'superseded', 'withdrawn');
create type public.lot_status as enum ('planned', 'in_build', 'inspection', 'accepted', 'rejected', 'on_hold');

-- ---------------------------------------------------------------------------
-- Releases (revision lock)
-- ---------------------------------------------------------------------------
create table public.releases (
  id               uuid primary key default gen_random_uuid(),
  project_id       uuid not null references public.projects (id) on delete cascade,
  release_no       integer not null,
  revision         text not null check (revision ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$'),
  notes            text,
  version_ids      uuid[] not null default '{}',     -- committed artifact versions in the release
  manifest         jsonb,                            -- frozen at issue: [{version_id, artifact, kind, version, path, sha256, size_bytes}]
  manifest_sha256  text,
  readiness        jsonb,                            -- the readiness check as it stood at issue
  waiver           text,                             -- why blockers were overridden, if any
  status           public.release_status not null default 'draft',
  decision_id      uuid references public.decisions (id),
  released_by      uuid references auth.users (id) on delete set null,
  released_at      timestamptz,
  withdrawn_reason text,
  created_by       uuid references auth.users (id) on delete set null default auth.uid(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (project_id, release_no),
  unique (project_id, revision),
  check (status = 'draft' or (manifest is not null and manifest_sha256 is not null and released_at is not null)),
  check (status <> 'withdrawn' or withdrawn_reason is not null)
);
create trigger releases_updated_at before update on public.releases for each row execute function public.set_updated_at();

-- Issued releases are frozen: only the status may move on (released → superseded or withdrawn).
create function public.protect_release() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then raise exception 'release % has been issued and cannot be deleted', old.revision; end if;
    return old;
  end if;
  if old.status = 'draft' then return new; end if;
  if (new.revision, new.version_ids, new.manifest, new.manifest_sha256, new.notes, new.waiver, new.readiness, new.released_at, new.released_by)
     is not distinct from (old.revision, old.version_ids, old.manifest, old.manifest_sha256, old.notes, old.waiver, old.readiness, old.released_at, old.released_by)
     and ((old.status = 'released' and new.status in ('superseded', 'withdrawn')) or (old.status = 'superseded' and new.status = 'withdrawn')) then
    return new;
  end if;
  raise exception 'release % is % and cannot be changed (make a new release)', old.revision, old.status;
end;
$$;
create trigger releases_protect before update or delete on public.releases for each row execute function public.protect_release();

-- ---------------------------------------------------------------------------
-- Compliance
-- ---------------------------------------------------------------------------
create table public.compliance_items (
  id               uuid primary key default gen_random_uuid(),
  project_id       uuid not null references public.projects (id) on delete cascade,
  item_no          integer not null,
  title            text not null check (length(trim(title)) between 1 and 200),
  market           text not null check (length(trim(market)) between 1 and 40),   -- US, EU, UK, CA, global...
  standards        text[] not null default '{}',
  basis            text,                     -- why it applies (which intake fact, which requirement)
  suggestion_key   text,                     -- set when added from the deterministic suggestions
  status           public.compliance_status not null default 'identified',
  lab_name         text,
  status_note      text,
  decided_by       uuid references auth.users (id) on delete set null,
  latest_result_id uuid,
  created_by       uuid references auth.users (id) on delete set null default auth.uid(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (project_id, item_no),
  unique (project_id, suggestion_key),
  check (status <> 'not_applicable' or (status_note is not null and decided_by is not null)),
  check (status not in ('passed', 'failed') or latest_result_id is not null)
);
create trigger compliance_items_updated_at before update on public.compliance_items for each row execute function public.set_updated_at();

create table public.compliance_results (
  id                uuid primary key default gen_random_uuid(),
  item_id           uuid not null references public.compliance_items (id) on delete cascade,
  project_id        uuid not null references public.projects (id) on delete cascade,
  outcome           text not null check (outcome in ('pass', 'fail')),
  lab_name          text not null check (length(trim(lab_name)) > 0),
  lab_reference     text,                    -- the lab's report number
  certificate_ref   text,                    -- grant ID, certificate or declaration number, when there is one
  result_date       date not null,
  expires_on        date,
  tested_release_id uuid not null references public.releases (id),
  report_name       text not null,
  report_path       text not null,
  report_sha256     text not null check (report_sha256 ~ '^[0-9a-f]{64}$'),
  report_size       bigint not null check (report_size > 0),
  notes             text,
  recorded_by       uuid references auth.users (id) on delete set null default auth.uid(),
  recorded_at       timestamptz not null default now(),
  check (expires_on is null or expires_on > result_date)
);
alter table public.compliance_items add constraint compliance_items_latest_result_fk
  foreign key (latest_result_id) references public.compliance_results (id);
create trigger compliance_results_immutable before update or delete on public.compliance_results for each row execute function public.forbid_modification();

-- ---------------------------------------------------------------------------
-- Production lots, inspections, units
-- ---------------------------------------------------------------------------
create table public.production_lots (
  id                  uuid primary key default gen_random_uuid(),
  project_id          uuid not null references public.projects (id) on delete cascade,
  lot_no              integer not null,
  kind                text not null default 'pilot' check (kind in ('pilot', 'production')),
  release_id          uuid not null references public.releases (id),
  quantity            integer not null check (quantity > 0),
  manufacturer_id     uuid references public.manufacturers (id) on delete set null,
  built_by            text,                  -- the assembler, when not in the directory
  procedure_id        uuid references public.test_procedures (id),   -- the production (jig) test each unit runs
  sample_size         integer not null check (sample_size > 0),
  accept_max_defects  integer not null default 0 check (accept_max_defects >= 0),
  status              public.lot_status not null default 'planned',
  status_note         text,
  notes               text,
  created_by          uuid references auth.users (id) on delete set null default auth.uid(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (project_id, lot_no),
  check (sample_size <= quantity),
  check (accept_max_defects < sample_size)
);
create trigger production_lots_updated_at before update on public.production_lots for each row execute function public.set_updated_at();

create table public.lot_inspections (
  id            uuid primary key default gen_random_uuid(),
  lot_id        uuid not null references public.production_lots (id) on delete cascade,
  project_id    uuid not null references public.projects (id) on delete cascade,
  stage         text not null check (stage in ('incoming', 'in_process', 'final')),
  inspected     integer not null check (inspected > 0),
  defects       integer not null check (defects >= 0),
  findings      jsonb not null default '[]'::jsonb,   -- [{defect, count}]
  verdict       text not null check (verdict in ('accept', 'reject', 'incomplete')),
  sample_size   integer not null,                      -- the plan it was judged against
  accept_max    integer not null,
  notes         text,
  inspected_by  uuid references auth.users (id) on delete set null default auth.uid(),
  inspected_at  timestamptz not null default now(),
  check (defects <= inspected)
);
create trigger lot_inspections_immutable before update or delete on public.lot_inspections for each row execute function public.forbid_modification();

alter table public.units add column lot_id uuid references public.production_lots (id);
create index units_lot_idx on public.units (lot_id);

-- Every member, clients included, reads compliance and production records; writes go through the functions below.
alter table public.releases enable row level security;
alter table public.compliance_items enable row level security;
alter table public.compliance_results enable row level security;
alter table public.production_lots enable row level security;
alter table public.lot_inspections enable row level security;
create policy "members read releases" on public.releases for select to authenticated using (public.is_project_member(project_id));
create policy "members read compliance items" on public.compliance_items for select to authenticated using (public.is_project_member(project_id));
create policy "members read compliance results" on public.compliance_results for select to authenticated using (public.is_project_member(project_id));
create policy "members read lots" on public.production_lots for select to authenticated using (public.is_project_member(project_id));
create policy "members read lot inspections" on public.lot_inspections for select to authenticated using (public.is_project_member(project_id));
grant select on public.releases, public.compliance_items, public.compliance_results, public.production_lots, public.lot_inspections to authenticated;
grant all on public.releases, public.compliance_items, public.compliance_results, public.production_lots, public.lot_inspections to service_role;

-- Lab reports are uploads: inspected and virus-scanned like the others.
create or replace function public.is_upload_path(p_bucket text, p_name text) returns boolean
language sql immutable set search_path = '' as $$
  select p_bucket = 'knowledge-files' or (p_bucket = 'project-files' and split_part(p_name, '/', 2) in ('documents', 'models', 'sources', 'flux', 'evidence', 'compliance'));
$$;

-- ---------------------------------------------------------------------------
-- Release functions
-- ---------------------------------------------------------------------------
create function public.save_release(p_project uuid, p_id uuid, p_revision text, p_notes text, p_version_ids uuid[]) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid := p_id;
  v_no integer;
  r public.releases;
  v_bad integer;
begin
  perform public.need_role(p_project, '{owner,engineer}', 'prepare releases');
  select count(*) into v_bad from unnest(coalesce(p_version_ids, '{}')) x(id)
   where not exists (select 1 from public.artifact_versions v where v.id = x.id and v.project_id = p_project and v.status = 'committed');
  if v_bad > 0 then raise exception 'a release can only hold committed (approved) files of this project'; end if;
  if (select count(distinct v.artifact_id) <> count(*) from public.artifact_versions v where v.id = any (coalesce(p_version_ids, '{}'))) then
    raise exception 'a release holds one version of each file';
  end if;
  if v_id is null then
    perform pg_advisory_xact_lock(hashtext('release:' || p_project::text));
    select coalesce(max(release_no), 0) + 1 into v_no from public.releases where project_id = p_project;
    insert into public.releases (project_id, release_no, revision, notes, version_ids)
    values (p_project, v_no, trim(p_revision), nullif(trim(coalesce(p_notes, '')), ''), coalesce(p_version_ids, '{}'))
    returning id into v_id;
    perform public.worker_audit(p_project, 'release.drafted', 'release', v_id, jsonb_build_object('revision', p_revision));
  else
    select * into r from public.releases where id = v_id and project_id = p_project for update;
    if r.id is null then raise exception 'release not found'; end if;
    if r.status <> 'draft' then raise exception 'release % is % and cannot be changed (make a new release)', r.revision, r.status; end if;
    update public.releases set revision = trim(p_revision), notes = nullif(trim(coalesce(p_notes, '')), ''),
                               version_ids = coalesce(p_version_ids, '{}') where id = v_id;
  end if;
  return v_id;
end;
$$;

-- What stands between a draft and its issue. "block" items need a written waiver from the owner; "warn" items are
-- shown and recorded.
create function public.check_release_readiness(p_release uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  r public.releases;
  out jsonb := '[]'::jsonb;
  x record;
begin
  select * into r from public.releases where id = p_release;
  if r.id is null or not public.is_project_member(r.project_id) then raise exception 'release not found'; end if;
  if coalesce(array_length(r.version_ids, 1), 0) = 0 then
    out := out || '[{"severity":"block","kind":"files","text":"the release holds no files"}]';
  else
    if not exists (select 1 from public.artifact_versions v join public.artifacts a on a.id = v.artifact_id
                    where v.id = any (r.version_ids) and a.kind = 'fab_package') then
      out := out || '[{"severity":"warn","kind":"files","text":"no fab package in the release"}]';
    end if;
    for x in select a.name, v.version, n.version as newer from public.artifact_versions v join public.artifacts a on a.id = v.artifact_id
              join lateral (select max(version) as version from public.artifact_versions w where w.artifact_id = v.artifact_id and w.status = 'committed') n on true
              where v.id = any (r.version_ids) and n.version > v.version order by a.name loop
      out := out || jsonb_build_array(jsonb_build_object('severity', 'warn', 'kind', 'files',
                     'text', format('%s v%s is in the release but v%s is newer', x.name, x.version, x.newer)));
    end loop;
  end if;
  for x in select fault_no, title, severity from public.faults where project_id = r.project_id and status in ('open', 'corrected') order by fault_no loop
    out := out || jsonb_build_array(jsonb_build_object('severity', case when x.severity = 'minor' then 'warn' else 'block' end, 'kind', 'fault',
                   'text', format('fault F-%s (%s) is not verified: %s', lpad(x.fault_no::text, 3, '0'), x.severity, x.title)));
  end loop;
  for x in select ref_code, status from public.requirement_verification(r.project_id) where status <> 'verified' order by ref_code loop
    out := out || jsonb_build_array(jsonb_build_object('severity', case when x.status = 'failing' then 'block' else 'warn' end, 'kind', 'requirement',
                   'text', format('%s is %s', x.ref_code, replace(x.status, '_', ' '))));
  end loop;
  for x in select item_no, title, status from public.compliance_items where project_id = r.project_id and status not in ('passed', 'not_applicable') order by item_no loop
    out := out || jsonb_build_array(jsonb_build_object('severity', case when x.status = 'failed' then 'block' else 'warn' end, 'kind', 'compliance',
                   'text', format('C-%s %s: %s', lpad(x.item_no::text, 3, '0'), replace(x.status::text, '_', ' '), x.title)));
  end loop;
  return out;
end;
$$;

create function public.issue_release(p_release uuid, p_waiver text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  r public.releases;
  v_ready jsonb;
  v_blocks integer;
  v_manifest jsonb;
  v_decision uuid;
  v_prev text[];
begin
  select * into r from public.releases where id = p_release for update;
  if r.id is null then raise exception 'release not found'; end if;
  perform public.need_role(r.project_id, '{owner}', 'issue a release');
  if r.status <> 'draft' then raise exception 'release % is already %', r.revision, r.status; end if;
  if coalesce(array_length(r.version_ids, 1), 0) = 0 then raise exception 'the release holds no files'; end if;
  v_ready := public.check_release_readiness(p_release);
  select count(*) into v_blocks from jsonb_array_elements(v_ready) e where e ->> 'severity' = 'block';
  if v_blocks > 0 and coalesce(trim(p_waiver), '') = '' then
    raise exception '% blocker(s) stand in the way: resolve them, or give the reason for releasing anyway', v_blocks;
  end if;
  select jsonb_agg(jsonb_build_object('version_id', v.id, 'artifact', a.name, 'kind', a.kind, 'version', v.version,
                                      'path', v.storage_path, 'sha256', v.sha256, 'size_bytes', v.size_bytes) order by a.name)
    into v_manifest
    from public.artifact_versions v join public.artifacts a on a.id = v.artifact_id
   where v.id = any (r.version_ids) and v.status <> 'scratch';
  if jsonb_array_length(coalesce(v_manifest, '[]')) <> array_length(r.version_ids, 1) then
    raise exception 'a file in the release is no longer committed';
  end if;
  select array_agg(revision order by release_no) into v_prev from public.releases where project_id = r.project_id and status = 'released';
  update public.releases set status = 'superseded' where project_id = r.project_id and status = 'released';
  insert into public.decisions (project_id, decision_class, title, statement, rationale, alternatives, evidence_category, evidence_refs)
  values (r.project_id, 'manufacturing', format('Release %s', r.revision),
          format('Revision %s released with %s file(s).', r.revision, jsonb_array_length(v_manifest)),
          coalesce(nullif(trim(coalesce(p_waiver, '')), ''), r.notes, 'Released with no blockers.'), '[]'::jsonb,
          case when jsonb_array_length(v_ready) = 0 then 'hardware_test' else 'unverified_assumption' end::public.evidence_category,
          jsonb_build_array(jsonb_build_object('release', r.id, 'manifest_sha256', encode(sha256(convert_to(v_manifest::text, 'UTF8')), 'hex'),
                                               'readiness', v_ready, 'supersedes', v_prev)))
  returning id into v_decision;
  update public.releases set status = 'released', manifest = v_manifest, manifest_sha256 = encode(sha256(convert_to(v_manifest::text, 'UTF8')), 'hex'),
                             readiness = v_ready, waiver = nullif(trim(coalesce(p_waiver, '')), ''), released_by = auth.uid(), released_at = now(),
                             decision_id = v_decision
   where id = r.id;
  perform public.worker_audit(r.project_id, 'release.issued', 'release', r.id,
                              jsonb_build_object('revision', r.revision, 'files', jsonb_array_length(v_manifest), 'blockers', v_blocks, 'waiver', p_waiver));
  return v_decision;
end;
$$;

create function public.withdraw_release(p_release uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.releases;
begin
  select * into r from public.releases where id = p_release for update;
  if r.id is null then raise exception 'release not found'; end if;
  perform public.need_role(r.project_id, '{owner}', 'withdraw a release');
  if coalesce(trim(p_reason), '') = '' then raise exception 'say why the release is withdrawn'; end if;
  if r.status = 'draft' then
    delete from public.releases where id = r.id;
  elsif r.status = 'withdrawn' then
    raise exception 'release % is already withdrawn', r.revision;
  else
    update public.releases set status = 'withdrawn', withdrawn_reason = trim(p_reason) where id = r.id;
  end if;
  perform public.worker_audit(r.project_id, 'release.withdrawn', 'release', r.id, jsonb_build_object('revision', r.revision, 'reason', p_reason, 'was', r.status));
end;
$$;

-- ---------------------------------------------------------------------------
-- Compliance functions
-- ---------------------------------------------------------------------------
create function public.add_compliance_item(p_project uuid, p_title text, p_market text, p_standards text[] default '{}',
                                           p_basis text default null, p_suggestion_key text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_no integer;
begin
  perform public.need_role(p_project, '{owner,engineer}', 'add compliance items');
  if p_suggestion_key is not null and exists (select 1 from public.compliance_items where project_id = p_project and suggestion_key = p_suggestion_key) then
    raise exception 'this item is already on the list';
  end if;
  perform pg_advisory_xact_lock(hashtext('compliance:' || p_project::text));
  select coalesce(max(item_no), 0) + 1 into v_no from public.compliance_items where project_id = p_project;
  insert into public.compliance_items (project_id, item_no, title, market, standards, basis, suggestion_key)
  values (p_project, v_no, trim(p_title), trim(p_market),
          coalesce((select array_agg(trim(s)) from unnest(p_standards) s where trim(s) <> ''), '{}'),
          nullif(trim(coalesce(p_basis, '')), ''), p_suggestion_key)
  returning id into v_id;
  perform public.worker_audit(p_project, 'compliance.added', 'compliance_item', v_id, jsonb_build_object('item_no', v_no, 'title', p_title, 'market', p_market));
  return v_id;
end;
$$;

-- Progress before a result: identified → in progress (pre-scans, test plan) → at the lab. Results go through
-- record_compliance_result; "not applicable" through mark_compliance_not_applicable.
create function public.set_compliance_status(p_item uuid, p_status public.compliance_status, p_lab_name text default null, p_note text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare c public.compliance_items;
begin
  select * into c from public.compliance_items where id = p_item for update;
  if c.id is null then raise exception 'compliance item not found'; end if;
  perform public.need_role(c.project_id, '{owner,engineer}', 'update compliance items');
  if p_status not in ('identified', 'in_progress', 'at_lab') then
    raise exception 'record a lab result, or mark the item not applicable, instead';
  end if;
  update public.compliance_items set status = p_status, lab_name = coalesce(nullif(trim(coalesce(p_lab_name, '')), ''), lab_name),
                                     status_note = nullif(trim(coalesce(p_note, '')), ''), decided_by = null where id = c.id;
  perform public.worker_audit(c.project_id, 'compliance.status', 'compliance_item', c.id, jsonb_build_object('status', p_status, 'note', p_note));
end;
$$;

create function public.mark_compliance_not_applicable(p_item uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare c public.compliance_items;
begin
  select * into c from public.compliance_items where id = p_item for update;
  if c.id is null then raise exception 'compliance item not found'; end if;
  perform public.need_role(c.project_id, '{owner,reviewer}', 'mark compliance items not applicable');
  if coalesce(trim(p_reason), '') = '' then raise exception 'give the reason the item does not apply'; end if;
  update public.compliance_items set status = 'not_applicable', status_note = trim(p_reason), decided_by = auth.uid() where id = c.id;
  perform public.worker_audit(c.project_id, 'compliance.not_applicable', 'compliance_item', c.id, jsonb_build_object('reason', p_reason));
end;
$$;

create function public.record_compliance_result(p_item uuid, p_outcome text, p_lab_name text, p_lab_reference text, p_certificate_ref text,
                                                p_result_date date, p_expires_on date, p_tested_release uuid, p_report_name text,
                                                p_report_path text, p_report_sha256 text, p_report_size bigint, p_notes text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  c public.compliance_items;
  v_id uuid;
begin
  select * into c from public.compliance_items where id = p_item for update;
  if c.id is null then raise exception 'compliance item not found'; end if;
  perform public.need_role(c.project_id, '{owner,engineer}', 'record compliance results');
  if p_outcome not in ('pass', 'fail') then raise exception 'the outcome is pass or fail'; end if;
  if not exists (select 1 from public.releases where id = p_tested_release and project_id = c.project_id and status in ('released', 'superseded')) then
    raise exception 'say which released revision was tested (issue a release first)';
  end if;
  if p_result_date is null or p_result_date > current_date then raise exception 'the result date is missing or in the future'; end if;
  if p_report_path not like c.project_id::text || '/compliance/' || c.id::text || '/%' then
    raise exception 'the lab report must be stored in the item''s folder';
  end if;
  insert into public.compliance_results (item_id, project_id, outcome, lab_name, lab_reference, certificate_ref, result_date, expires_on,
                                         tested_release_id, report_name, report_path, report_sha256, report_size, notes)
  values (c.id, c.project_id, p_outcome, trim(p_lab_name), nullif(trim(coalesce(p_lab_reference, '')), ''),
          nullif(trim(coalesce(p_certificate_ref, '')), ''), p_result_date, p_expires_on, p_tested_release, p_report_name, p_report_path,
          lower(p_report_sha256), p_report_size, nullif(trim(coalesce(p_notes, '')), ''))
  returning id into v_id;
  update public.compliance_items set status = case when p_outcome = 'pass' then 'passed' else 'failed' end::public.compliance_status,
                                     lab_name = trim(p_lab_name), latest_result_id = v_id, status_note = null, decided_by = null where id = c.id;
  perform public.worker_audit(c.project_id, 'compliance.result', 'compliance_item', c.id,
                              jsonb_build_object('outcome', p_outcome, 'lab', p_lab_name, 'release', p_tested_release, 'sha256', p_report_sha256));
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Production functions
-- ---------------------------------------------------------------------------
create function public.create_lot(p_project uuid, p_kind text, p_release uuid, p_quantity integer, p_sample_size integer, p_accept_max integer,
                                  p_procedure uuid default null, p_manufacturer uuid default null, p_built_by text default null,
                                  p_notes text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_no integer; r public.releases;
begin
  perform public.need_role(p_project, '{owner,engineer}', 'plan production lots');
  select * into r from public.releases where id = p_release and project_id = p_project;
  if r.id is null then raise exception 'release not found'; end if;
  if r.status <> 'released' then
    raise exception 'lots are built from the current released revision (% is %)', r.revision, r.status;
  end if;
  if p_procedure is not null and not exists (select 1 from public.test_procedures where id = p_procedure and project_id = p_project and status = 'approved') then
    raise exception 'the production test must be an approved procedure of this project';
  end if;
  perform pg_advisory_xact_lock(hashtext('lot:' || p_project::text));
  select coalesce(max(lot_no), 0) + 1 into v_no from public.production_lots where project_id = p_project;
  insert into public.production_lots (project_id, lot_no, kind, release_id, quantity, sample_size, accept_max_defects, procedure_id, manufacturer_id, built_by, notes)
  values (p_project, v_no, p_kind, p_release, p_quantity, p_sample_size, coalesce(p_accept_max, 0), p_procedure, p_manufacturer,
          nullif(trim(coalesce(p_built_by, '')), ''), nullif(trim(coalesce(p_notes, '')), ''))
  returning id into v_id;
  perform public.worker_audit(p_project, 'lot.created', 'production_lot', v_id,
                              jsonb_build_object('lot_no', v_no, 'kind', p_kind, 'revision', r.revision, 'quantity', p_quantity));
  return v_id;
end;
$$;

-- Registers units SERIAL-<start>..SERIAL-<start+count-1> in a lot; they carry the release's revision and are traced to
-- its fab package when the release has one.
create function public.add_lot_units(p_lot uuid, p_prefix text, p_start integer, p_count integer, p_digits integer default 4) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  l public.production_lots;
  r public.releases;
  v_fab uuid;
  v_have integer;
  v_serial text;
begin
  select * into l from public.production_lots where id = p_lot for update;
  if l.id is null then raise exception 'lot not found'; end if;
  perform public.need_role(l.project_id, '{owner,engineer}', 'register units');
  if l.status in ('accepted', 'rejected') then raise exception 'the lot is % and closed', l.status; end if;
  if p_count is null or p_count < 1 or p_start is null or p_start < 0 then raise exception 'give a start number and a count of at least one'; end if;
  select count(*) into v_have from public.units where lot_id = l.id;
  if v_have + p_count > l.quantity then
    raise exception 'the lot is for % unit(s) and % are registered', l.quantity, v_have;
  end if;
  select * into r from public.releases where id = l.release_id;
  select (m ->> 'version_id')::uuid into v_fab from jsonb_array_elements(r.manifest) m where m ->> 'kind' = 'fab_package' limit 1;
  for i in 0 .. p_count - 1 loop
    v_serial := trim(p_prefix) || lpad((p_start + i)::text, greatest(coalesce(p_digits, 4), length((p_start + i)::text)), '0');
    if exists (select 1 from public.units where project_id = l.project_id and serial = v_serial) then
      raise exception 'serial % is already registered', v_serial;
    end if;
    insert into public.units (project_id, serial, revision, built_from_version_id, lot, lot_id, assembled_by)
    values (l.project_id, v_serial, r.revision, v_fab, format('LOT-%s', lpad(l.lot_no::text, 3, '0')), l.id,
            coalesce(l.built_by, (select display_name from public.manufacturers where id = l.manufacturer_id)));
  end loop;
  if l.status = 'planned' then update public.production_lots set status = 'in_build' where id = l.id; end if;
  perform public.worker_audit(l.project_id, 'lot.units_added', 'production_lot', l.id,
                              jsonb_build_object('prefix', p_prefix, 'start', p_start, 'count', p_count));
  return p_count;
end;
$$;

create function public.record_lot_inspection(p_lot uuid, p_stage text, p_inspected integer, p_defects integer, p_findings jsonb default '[]',
                                             p_notes text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  l public.production_lots;
  v_verdict text;
  v_id uuid;
begin
  select * into l from public.production_lots where id = p_lot for update;
  if l.id is null then raise exception 'lot not found'; end if;
  perform public.need_role(l.project_id, '{owner,engineer,reviewer}', 'record inspections');
  if l.status in ('accepted', 'rejected') then raise exception 'the lot is % and closed', l.status; end if;
  if p_inspected is null or p_inspected < 1 then raise exception 'say how many units were inspected'; end if;
  if p_inspected > l.quantity then raise exception 'the lot has only % unit(s)', l.quantity; end if;
  if p_defects is null or p_defects < 0 or p_defects > p_inspected then raise exception 'the defect count must be between 0 and the number inspected'; end if;
  if jsonb_typeof(coalesce(p_findings, '[]')) <> 'array' then raise exception 'findings must be a list'; end if;
  -- Single sampling: reject as soon as defects pass the accept number; accept only once the full sample is checked.
  v_verdict := case when p_defects > l.accept_max_defects then 'reject'
                    when p_inspected >= l.sample_size then 'accept' else 'incomplete' end;
  insert into public.lot_inspections (lot_id, project_id, stage, inspected, defects, findings, verdict, sample_size, accept_max, notes)
  values (l.id, l.project_id, p_stage, p_inspected, p_defects, coalesce(p_findings, '[]'), v_verdict, l.sample_size, l.accept_max_defects,
          nullif(trim(coalesce(p_notes, '')), ''))
  returning id into v_id;
  if l.status in ('planned', 'in_build') then update public.production_lots set status = 'inspection' where id = l.id; end if;
  perform public.worker_audit(l.project_id, 'lot.inspected', 'production_lot', l.id,
                              jsonb_build_object('stage', p_stage, 'inspected', p_inspected, 'defects', p_defects, 'verdict', v_verdict));
  return v_id;
end;
$$;

-- Lot disposition. Accepting needs a passing final inspection and every unit (bar scrapped ones) passing its latest
-- production test, and marks those units passed; rejecting or holding needs a reason.
create function public.set_lot_status(p_lot uuid, p_status public.lot_status, p_note text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  l public.production_lots;
  v_failed integer;
begin
  select * into l from public.production_lots where id = p_lot for update;
  if l.id is null then raise exception 'lot not found'; end if;
  if p_status in ('accepted', 'rejected') then
    perform public.need_role(l.project_id, '{owner,reviewer}', 'accept or reject lots');
  else
    perform public.need_role(l.project_id, '{owner,engineer}', 'change lot status');
  end if;
  if l.status in ('accepted', 'rejected') then raise exception 'the lot is already %', l.status; end if;
  if p_status in ('rejected', 'on_hold') and coalesce(trim(p_note), '') = '' then raise exception 'give the reason'; end if;
  if p_status = 'accepted' then
    if not exists (select 1 from public.lot_inspections where lot_id = l.id and stage = 'final' and verdict = 'accept'
                    and inspected_at = (select max(inspected_at) from public.lot_inspections where lot_id = l.id and stage = 'final')) then
      raise exception 'the latest final inspection must pass the sampling plan before the lot is accepted';
    end if;
    if l.procedure_id is not null then
      select count(*) into v_failed from public.units u
       where u.lot_id = l.id and u.status <> 'scrapped'
         and (select t.verdict from public.test_runs t join public.test_procedures p on p.id = t.procedure_id
               where t.unit_id = u.id and p.code = (select code from public.test_procedures where id = l.procedure_id)
               order by t.performed_at desc, t.run_no desc limit 1) is distinct from 'pass';
      if v_failed > 0 then
        raise exception '% unit(s) have not passed the production test (scrap them or retest them first)', v_failed;
      end if;
    end if;
  end if;
  update public.production_lots set status = p_status, status_note = nullif(trim(coalesce(p_note, '')), '') where id = l.id;
  -- An accepted lot's units have all passed the production test (checked above), so they are marked passed.
  if p_status = 'accepted' then
    update public.units set status = 'passed' where lot_id = l.id and status <> 'scrapped';
  end if;
  perform public.worker_audit(l.project_id, 'lot.status', 'production_lot', l.id, jsonb_build_object('status', p_status, 'note', p_note));
end;
$$;

-- Per-lot production test summary: units registered, tested, first-pass yield (first run of the production test
-- passed) and current pass count (latest run passed). Runs as the caller, so row security applies.
create function public.lot_summary(p_lot uuid) returns jsonb
language sql stable security invoker set search_path = '' as $$
  with l as (select * from public.production_lots where id = p_lot),
  code as (select p.code from public.test_procedures p join l on p.id = l.procedure_id),
  u as (select un.id, un.status from public.units un join l on un.lot_id = l.id),
  runs as (select t.unit_id, t.verdict, row_number() over (partition by t.unit_id order by t.performed_at, t.run_no) as first_rank,
                  row_number() over (partition by t.unit_id order by t.performed_at desc, t.run_no desc) as last_rank
             from public.test_runs t join public.test_procedures p on p.id = t.procedure_id join u on u.id = t.unit_id
            where p.code = (select code from code))
  select jsonb_build_object(
    'units', (select count(*) from u),
    'scrapped', (select count(*) from u where status = 'scrapped'),
    'tested', (select count(distinct unit_id) from runs),
    'first_pass', (select count(*) from runs where first_rank = 1 and verdict = 'pass'),
    'passing', (select count(*) from runs where last_rank = 1 and verdict = 'pass'),
    'failing', (select count(*) from runs where last_rank = 1 and verdict <> 'pass'));
$$;

-- Everything known about one serial number: the unit, its lot and release (with the frozen file list), its test runs
-- and faults. Runs as the caller, so row security applies.
create function public.trace_unit(p_project uuid, p_serial text) returns jsonb
language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'unit', to_jsonb(u) - 'created_by',
    'lot', (select jsonb_build_object('id', l.id, 'lot_no', l.lot_no, 'kind', l.kind, 'status', l.status, 'built_by', l.built_by)
              from public.production_lots l where l.id = u.lot_id),
    'release', (select jsonb_build_object('id', r.id, 'revision', r.revision, 'status', r.status, 'released_at', r.released_at,
                                          'manifest_sha256', r.manifest_sha256, 'files', r.manifest)
                  from public.releases r
                 where r.id = coalesce((select release_id from public.production_lots where id = u.lot_id),
                                       (select r2.id from public.releases r2 where r2.project_id = u.project_id and r2.revision = u.revision))),
    'built_from', (select jsonb_build_object('id', v.id, 'artifact', a.name, 'version', v.version, 'sha256', v.sha256)
                     from public.artifact_versions v join public.artifacts a on a.id = v.artifact_id where v.id = u.built_from_version_id),
    'runs', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'run_no', t.run_no, 'procedure', p.code, 'version', p.version, 'title', p.title,
                                                          'verdict', t.verdict, 'performed_at', t.performed_at) order by t.performed_at)
                        from public.test_runs t join public.test_procedures p on p.id = t.procedure_id where t.unit_id = u.id), '[]'::jsonb),
    'faults', coalesce((select jsonb_agg(jsonb_build_object('fault_no', f.fault_no, 'title', f.title, 'status', f.status, 'severity', f.severity) order by f.fault_no)
                          from public.faults f where f.unit_id = u.id), '[]'::jsonb))
  from public.units u where u.project_id = p_project and u.serial = trim(p_serial);
$$;

-- ---------------------------------------------------------------------------
-- S7 stage blockers: a released revision, compliance items resolved, an accepted pilot or production lot.
-- ---------------------------------------------------------------------------
create or replace function public.stage_blockers(p_project uuid, p_stage public.project_stage) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  b jsonb := '[]'::jsonb;
  v_plan uuid;
  i public.project_intake;
  r record;
begin
  select id into v_plan from public.plans where project_id = p_project and status = 'approved' order by version desc limit 1;
  if p_stage = 'S0' then
    select * into i from public.project_intake where project_id = p_project;
    if i.project_id is null or i.feasibility_checked_at is null then
      b := b || jsonb_build_array(jsonb_build_object('kind', 'feasibility', 'text', 'run the feasibility check'));
    end if;
    if coalesce(trim(i.intended_use), '') = '' then b := b || '[{"kind":"intake","text":"intended use is not recorded"}]'; end if;
    if coalesce(array_length(i.regions, 1), 0) = 0 then b := b || '[{"kind":"intake","text":"target markets (regions) are not recorded"}]'; end if;
    if i.quantity is null then b := b || '[{"kind":"intake","text":"first production quantity is not recorded"}]'; end if;
    if i.target_unit_cost is null then b := b || '[{"kind":"intake","text":"target unit cost is not recorded"}]'; end if;
    if coalesce(trim(i.power_source), '') = '' then b := b || '[{"kind":"intake","text":"power source is not recorded"}]'; end if;
    for r in select ref_code, status from public.requirements
              where project_id = p_project and status in ('extracted', 'ambiguous') order by ref_code loop
      b := b || jsonb_build_array(jsonb_build_object('kind', 'requirement',
             'text', format('%s is %s: confirm or reject it', r.ref_code, r.status)));
    end loop;
    if not exists (select 1 from public.requirements where project_id = p_project and status = 'confirmed') then
      b := b || '[{"kind":"requirement","text":"no confirmed requirements yet"}]';
    end if;
  elsif p_stage = 'S1' then
    if not exists (select 1 from public.design_freezes where project_id = p_project) then
      b := b || '[{"kind":"design_freeze","text":"no design freeze recorded (choose a concept, or sign off with a reason if the product needs no industrial design)"}]';
    end if;
  else
    if v_plan is null then
      b := b || '[{"kind":"plan","text":"no approved plan"}]';
    else
      for r in select key, status from public.tasks where plan_id = v_plan and stage = p_stage
                and status not in ('complete', 'canceled', 'superseded') order by position loop
        b := b || jsonb_build_array(jsonb_build_object('kind', 'task', 'text', format('task %s is %s', r.key, replace(r.status::text, '_', ' '))));
      end loop;
    end if;
    if p_stage = 'S6' then
      for r in select fault_no, title from public.faults where project_id = p_project and status in ('open', 'corrected') order by fault_no loop
        b := b || jsonb_build_array(jsonb_build_object('kind', 'fault', 'text', format('fault F-%s is not verified: %s', lpad(r.fault_no::text, 3, '0'), r.title)));
      end loop;
    end if;
    if p_stage = 'S7' then
      if not exists (select 1 from public.releases where project_id = p_project and status = 'released') then
        b := b || '[{"kind":"release","text":"no released revision"}]';
      end if;
      if not exists (select 1 from public.compliance_items where project_id = p_project) then
        b := b || '[{"kind":"compliance","text":"no compliance items listed (add them from the suggestions, or sign off with a reason)"}]';
      end if;
      for r in select item_no, title, status from public.compliance_items where project_id = p_project
                and status not in ('passed', 'not_applicable') order by item_no loop
        b := b || jsonb_build_array(jsonb_build_object('kind', 'compliance',
               'text', format('C-%s is %s: %s', lpad(r.item_no::text, 3, '0'), replace(r.status::text, '_', ' '), r.title)));
      end loop;
      if not exists (select 1 from public.production_lots where project_id = p_project and status = 'accepted') then
        b := b || '[{"kind":"lot","text":"no accepted pilot or production lot"}]';
      end if;
    end if;
  end if;
  for r in select risk_no, title, level from public.risks
            where project_id = p_project and stage = p_stage and level in ('high', 'critical') and status in ('open', 'mitigating')
            order by risk_no loop
    b := b || jsonb_build_array(jsonb_build_object('kind', 'risk', 'text',
           format('RISK-%s (%s) is unresolved: %s', lpad(r.risk_no::text, 3, '0'), r.level, r.title)));
  end loop;
  return b;
end;
$$;

revoke all on function public.save_release(uuid, uuid, text, text, uuid[]), public.check_release_readiness(uuid), public.issue_release(uuid, text),
  public.withdraw_release(uuid, text), public.add_compliance_item(uuid, text, text, text[], text, text),
  public.set_compliance_status(uuid, public.compliance_status, text, text), public.mark_compliance_not_applicable(uuid, text),
  public.record_compliance_result(uuid, text, text, text, text, date, date, uuid, text, text, text, bigint, text),
  public.create_lot(uuid, text, uuid, integer, integer, integer, uuid, uuid, text, text), public.add_lot_units(uuid, text, integer, integer, integer),
  public.record_lot_inspection(uuid, text, integer, integer, jsonb, text), public.set_lot_status(uuid, public.lot_status, text),
  public.lot_summary(uuid), public.trace_unit(uuid, text) from public, anon;
grant execute on function public.save_release(uuid, uuid, text, text, uuid[]), public.check_release_readiness(uuid), public.issue_release(uuid, text),
  public.withdraw_release(uuid, text), public.add_compliance_item(uuid, text, text, text[], text, text),
  public.set_compliance_status(uuid, public.compliance_status, text, text), public.mark_compliance_not_applicable(uuid, text),
  public.record_compliance_result(uuid, text, text, text, text, date, date, uuid, text, text, text, bigint, text),
  public.create_lot(uuid, text, uuid, integer, integer, integer, uuid, uuid, text, text), public.add_lot_units(uuid, text, integer, integer, integer),
  public.record_lot_inspection(uuid, text, integer, integer, jsonb, text), public.set_lot_status(uuid, public.lot_status, text),
  public.lot_summary(uuid), public.trace_unit(uuid, text) to authenticated, service_role;
revoke all on function public.protect_release() from public, anon, authenticated;
