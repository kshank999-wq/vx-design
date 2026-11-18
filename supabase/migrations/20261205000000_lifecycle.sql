-- S8 lifecycle (spec §3.1): change and end-of-life notices, the parts each project uses, impact cases, substitute
-- qualification, supplier performance, and delivery dates on production lots. Cost history and revision changes
-- are read from records that already exist (offers, sourced BOMs, release manifests).
--
-- Notices are catalog facts about a part, shared like the catalog: a manufacturer's product change notice (PCN),
-- end-of-life or last-time-buy notice, each with its source; a lifecycle change seen in distributor data is recorded
-- automatically. A project's BOM parts are loaded from its committed sourced BOM. A lifecycle case is a project's
-- response to a risk on one of its parts: assessed, then resolved by a qualified substitute, a last-time buy, a
-- redesign, an accepted risk, or "not affected". Every resolution is a project decision. A substitute is qualified
-- only with a basis for each check, the pin-out and electrical checks passing, and, where a test was run, a passing
-- S6 test run.

create type public.notice_kind as enum ('pcn', 'eol', 'last_time_buy', 'lifecycle_change', 'counterfeit_alert', 'other');
create type public.case_status as enum ('open', 'assessing', 'resolved');
create type public.case_resolution as enum ('substitute', 'last_time_buy', 'redesign', 'accepted_risk', 'not_affected');
create type public.substitute_status as enum ('proposed', 'qualifying', 'qualified', 'rejected');

-- ---------------------------------------------------------------------------
-- Notices (shared catalog)
-- ---------------------------------------------------------------------------
create table public.part_notices (
  id              uuid primary key default gen_random_uuid(),
  part_id         uuid not null references public.parts (id) on delete cascade,
  kind            public.notice_kind not null,
  title           text not null check (length(trim(title)) between 1 and 200),
  notice_ref      text,                        -- the manufacturer's PCN or EOL number
  summary         text,                        -- what changes: die, package, site, material, form/fit/function
  issued_on       date,
  effective_on    date,                        -- when the change takes effect
  last_order_on   date,                        -- last-time-buy date
  last_ship_on    date,
  source_url      text check (source_url is null or source_url ~ '^https://'),
  source_note     text,
  automatic       boolean not null default false,
  details         jsonb not null default '{}'::jsonb,
  recorded_by     uuid references auth.users (id) on delete set null default auth.uid(),
  recorded_at     timestamptz not null default now(),
  check (automatic or source_url is not null or coalesce(trim(source_note), '') <> ''),
  check (last_ship_on is null or last_order_on is null or last_ship_on >= last_order_on)
);
create index part_notices_part_idx on public.part_notices (part_id, recorded_at desc);
create trigger part_notices_immutable before update or delete on public.part_notices for each row execute function public.forbid_modification();

-- A lifecycle change in distributor data is a notice, so nothing changes silently.
create function public.note_lifecycle_change() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.lifecycle is distinct from new.lifecycle and old.lifecycle <> 'unknown' or (old.lifecycle = 'unknown' and new.lifecycle in ('nrnd', 'last_time_buy', 'obsolete')) then
    insert into public.part_notices (part_id, kind, title, summary, automatic, recorded_by, details)
    values (new.id, 'lifecycle_change', format('Lifecycle changed: %s → %s', old.lifecycle, new.lifecycle),
            case when new.lifecycle_raw is not null then format('Distributor wording: %s', new.lifecycle_raw) end, true, null,
            jsonb_build_object('from', old.lifecycle, 'to', new.lifecycle, 'sources', new.sources));
  end if;
  return new;
end;
$$;
create trigger parts_lifecycle_notice after update of lifecycle on public.parts for each row execute function public.note_lifecycle_change();
revoke all on function public.note_lifecycle_change() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Project BOM parts, cases, substitutes
-- ---------------------------------------------------------------------------
create table public.project_bom_parts (
  project_id        uuid not null references public.projects (id) on delete cascade,
  bom_version_id    uuid not null references public.artifact_versions (id),
  line_no           integer not null,
  part_id           uuid references public.parts (id),
  mpn               text not null,
  manufacturer      text,
  refs              text[] not null default '{}',
  qty_per_board     numeric not null default 1 check (qty_per_board > 0),
  alternates        jsonb not null default '[]'::jsonb,     -- the sourced BOM's alternates [{mpn, manufacturer}]
  loaded_at         timestamptz not null default now(),
  primary key (project_id, bom_version_id, line_no)
);
create index project_bom_parts_part_idx on public.project_bom_parts (part_id);

create table public.lifecycle_cases (
  id               uuid primary key default gen_random_uuid(),
  project_id       uuid not null references public.projects (id) on delete cascade,
  case_no          integer not null,
  part_id          uuid references public.parts (id),
  mpn              text not null,
  manufacturer     text,
  refs             text[] not null default '{}',
  notice_id        uuid references public.part_notices (id),
  trigger_text     text not null,                -- why it was opened
  severity         text not null default 'medium' check (severity in ('low', 'medium', 'high')),
  status           public.case_status not null default 'open',
  impact           text,                         -- the assessment: affected boards, releases, stock on hand, options
  resolution       public.case_resolution,
  resolution_note  text,
  ltb_quantity     integer check (ltb_quantity > 0),
  substitute_id    uuid,
  decision_id      uuid references public.decisions (id),
  opened_by        uuid references auth.users (id) on delete set null default auth.uid(),
  opened_at        timestamptz not null default now(),
  resolved_by      uuid references auth.users (id) on delete set null,
  resolved_at      timestamptz,
  updated_at       timestamptz not null default now(),
  unique (project_id, case_no),
  check (status <> 'resolved' or (resolution is not null and resolution_note is not null and decision_id is not null)),
  check (resolution is distinct from 'substitute' or substitute_id is not null),
  check (resolution is distinct from 'last_time_buy' or ltb_quantity is not null)
);
create unique index lifecycle_cases_one_open on public.lifecycle_cases (project_id, part_id) where status <> 'resolved' and part_id is not null;
create trigger lifecycle_cases_updated_at before update on public.lifecycle_cases for each row execute function public.set_updated_at();

create table public.substitutes (
  id                uuid primary key default gen_random_uuid(),
  project_id        uuid not null references public.projects (id) on delete cascade,
  case_id           uuid references public.lifecycle_cases (id) on delete cascade,
  original_part_id  uuid references public.parts (id),
  original_mpn      text not null,
  part_id           uuid references public.parts (id),
  mpn               text not null check (length(trim(mpn)) between 1 and 80),
  manufacturer      text not null check (length(trim(manufacturer)) between 1 and 80),
  checks            jsonb not null default '{}'::jsonb,
  -- {pinout|electrical|environmental|supply|test: {result: pass|fail|na, basis, test_run_id?}}
  status            public.substitute_status not null default 'proposed',
  status_note       text,
  decided_by        uuid references auth.users (id) on delete set null,
  decided_at        timestamptz,
  created_by        uuid references auth.users (id) on delete set null default auth.uid(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  check (status not in ('qualified', 'rejected') or (decided_by is not null and status_note is not null))
);
alter table public.lifecycle_cases add constraint lifecycle_cases_substitute_fk foreign key (substitute_id) references public.substitutes (id);
create trigger substitutes_updated_at before update on public.substitutes for each row execute function public.set_updated_at();

-- Delivery dates on lots, for supplier on-time performance.
alter table public.production_lots add column promised_on date, add column delivered_on date;

alter table public.part_notices enable row level security;
alter table public.project_bom_parts enable row level security;
alter table public.lifecycle_cases enable row level security;
alter table public.substitutes enable row level security;
create policy "authenticated read notices" on public.part_notices for select to authenticated using (true);
create policy "members read bom parts" on public.project_bom_parts for select to authenticated using (public.is_project_member(project_id));
create policy "members read lifecycle cases" on public.lifecycle_cases for select to authenticated using (public.is_project_member(project_id));
create policy "members read substitutes" on public.substitutes for select to authenticated using (public.is_project_member(project_id));
grant select on public.part_notices, public.project_bom_parts, public.lifecycle_cases, public.substitutes to authenticated;
grant all on public.part_notices, public.project_bom_parts, public.lifecycle_cases, public.substitutes to service_role;

-- ---------------------------------------------------------------------------
-- Functions
-- ---------------------------------------------------------------------------
create function public.record_part_notice(p_part uuid, p_kind public.notice_kind, p_title text, p_notice_ref text, p_summary text,
                                          p_issued_on date, p_effective_on date, p_last_order_on date, p_last_ship_on date,
                                          p_source_url text, p_source_note text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if not public.is_directory_user() then
    raise exception 'only project owners, engineers and library editors can record notices' using errcode = '42501';
  end if;
  if p_kind = 'lifecycle_change' then raise exception 'lifecycle changes are recorded from distributor data'; end if;
  if not exists (select 1 from public.parts where id = p_part) then raise exception 'part not found'; end if;
  if p_source_url is null and coalesce(trim(p_source_note), '') = '' then raise exception 'say where the notice comes from (a link or a note)'; end if;
  insert into public.part_notices (part_id, kind, title, notice_ref, summary, issued_on, effective_on, last_order_on, last_ship_on, source_url, source_note)
  values (p_part, p_kind, trim(p_title), nullif(trim(coalesce(p_notice_ref, '')), ''), nullif(trim(coalesce(p_summary, '')), ''),
          p_issued_on, p_effective_on, p_last_order_on, p_last_ship_on, nullif(trim(coalesce(p_source_url, '')), ''), nullif(trim(coalesce(p_source_note, '')), ''))
  returning id into v_id;
  -- Mirror the lifecycle a notice implies onto the catalog (which records its own lifecycle-change notice too).
  if p_kind in ('eol', 'last_time_buy') then
    update public.parts set lifecycle = case when p_kind = 'eol' and p_last_order_on is not null and p_last_order_on < current_date then 'obsolete'
                                             else 'last_time_buy' end::public.part_lifecycle,
                            lifecycle_raw = format('%s notice %s', upper(p_kind::text), coalesce(p_notice_ref, ''))
     where id = p_part and lifecycle in ('active', 'nrnd', 'unknown');
  end if;
  return v_id;
end;
$$;

-- Loads the lines of a committed sourced BOM. Normalised keys come from the caller (the same normaliser the catalog
-- uses) and are matched to catalog parts here.
create function public.load_bom_parts(p_project uuid, p_version uuid, p_lines jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  l jsonb;
  n integer := 0;
begin
  perform public.need_role(p_project, '{owner,engineer}', 'load BOM parts');
  if not exists (select 1 from public.artifact_versions v join public.artifacts a on a.id = v.artifact_id
                  where v.id = p_version and v.project_id = p_project and v.status <> 'scratch' and a.kind = 'bom') then
    raise exception 'that is not a committed BOM of this project';
  end if;
  if jsonb_typeof(p_lines) <> 'array' then raise exception 'lines must be a list'; end if;
  delete from public.project_bom_parts where project_id = p_project and bom_version_id = p_version;
  for l in select * from jsonb_array_elements(p_lines) loop
    if coalesce(trim(l ->> 'mpn'), '') = '' then continue; end if;
    n := n + 1;
    insert into public.project_bom_parts (project_id, bom_version_id, line_no, part_id, mpn, manufacturer, refs, qty_per_board, alternates)
    values (p_project, p_version, n,
            (select id from public.parts p where p.normalized_mpn = l ->> 'normalized_mpn'
                and (coalesce(l ->> 'normalized_mfr', '') = '' or p.normalized_mfr = l ->> 'normalized_mfr') order by p.updated_at desc limit 1),
            trim(l ->> 'mpn'), nullif(trim(coalesce(l ->> 'manufacturer', '')), ''),
            coalesce(array(select jsonb_array_elements_text(l -> 'refs')), '{}'),
            greatest(coalesce((l ->> 'qty_per_board')::numeric, 1), 0.001), coalesce(l -> 'alternates', '[]'));
  end loop;
  perform public.worker_audit(p_project, 'lifecycle.bom_loaded', 'artifact_version', p_version, jsonb_build_object('lines', n));
  return n;
end;
$$;

create function public.open_lifecycle_case(p_project uuid, p_part uuid, p_mpn text, p_manufacturer text, p_refs text[], p_trigger text,
                                           p_severity text default 'medium', p_notice uuid default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_no integer;
begin
  perform public.need_role(p_project, '{owner,engineer}', 'open lifecycle cases');
  if coalesce(trim(p_trigger), '') = '' then raise exception 'say why the case is opened'; end if;
  if p_part is not null and exists (select 1 from public.lifecycle_cases where project_id = p_project and part_id = p_part and status <> 'resolved') then
    raise exception 'a case for % is already open', p_mpn;
  end if;
  if p_notice is not null and not exists (select 1 from public.part_notices where id = p_notice and part_id is not distinct from p_part) then
    raise exception 'the notice is not about this part';
  end if;
  perform pg_advisory_xact_lock(hashtext('lifecycle:' || p_project::text));
  select coalesce(max(case_no), 0) + 1 into v_no from public.lifecycle_cases where project_id = p_project;
  insert into public.lifecycle_cases (project_id, case_no, part_id, mpn, manufacturer, refs, notice_id, trigger_text, severity)
  values (p_project, v_no, p_part, trim(p_mpn), nullif(trim(coalesce(p_manufacturer, '')), ''), coalesce(p_refs, '{}'), p_notice, trim(p_trigger), p_severity)
  returning id into v_id;
  perform public.worker_audit(p_project, 'lifecycle.case_opened', 'lifecycle_case', v_id, jsonb_build_object('case_no', v_no, 'mpn', p_mpn, 'trigger', p_trigger));
  return v_id;
end;
$$;

create function public.assess_lifecycle_case(p_case uuid, p_impact text, p_severity text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare c public.lifecycle_cases;
begin
  select * into c from public.lifecycle_cases where id = p_case for update;
  if c.id is null then raise exception 'case not found'; end if;
  perform public.need_role(c.project_id, '{owner,engineer}', 'assess lifecycle cases');
  if c.status = 'resolved' then raise exception 'the case is resolved'; end if;
  if coalesce(trim(p_impact), '') = '' then raise exception 'write the impact assessment'; end if;
  update public.lifecycle_cases set impact = trim(p_impact), status = 'assessing', severity = coalesce(p_severity, severity) where id = c.id;
  perform public.worker_audit(c.project_id, 'lifecycle.case_assessed', 'lifecycle_case', c.id, jsonb_build_object('severity', coalesce(p_severity, c.severity)));
end;
$$;

-- Owners and reviewers resolve a case; the resolution becomes a project decision.
create function public.resolve_lifecycle_case(p_case uuid, p_resolution public.case_resolution, p_note text, p_substitute uuid default null,
                                              p_ltb_quantity integer default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  c public.lifecycle_cases;
  s public.substitutes;
  v_decision uuid;
  v_statement text;
begin
  select * into c from public.lifecycle_cases where id = p_case for update;
  if c.id is null then raise exception 'case not found'; end if;
  perform public.need_role(c.project_id, '{owner,reviewer}', 'resolve lifecycle cases');
  if c.status = 'resolved' then raise exception 'the case is already resolved'; end if;
  if coalesce(trim(p_note), '') = '' then raise exception 'give the reason for the resolution'; end if;
  if c.impact is null and p_resolution <> 'not_affected' then raise exception 'assess the impact before resolving'; end if;
  if p_resolution = 'substitute' then
    select * into s from public.substitutes where id = p_substitute and project_id = c.project_id;
    if s.id is null or s.status <> 'qualified' then raise exception 'choose a qualified substitute'; end if;
    v_statement := format('Replace %s with %s %s.', c.mpn, s.manufacturer, s.mpn);
  elsif p_resolution = 'last_time_buy' then
    if p_ltb_quantity is null or p_ltb_quantity < 1 then raise exception 'give the last-time-buy quantity'; end if;
    v_statement := format('Last-time buy of %s × %s.', p_ltb_quantity, c.mpn);
  else
    v_statement := format('%s: %s.', c.mpn, replace(p_resolution::text, '_', ' '));
  end if;
  insert into public.decisions (project_id, decision_class, title, statement, rationale, alternatives, evidence_category, evidence_refs)
  values (c.project_id, case when p_resolution in ('substitute', 'redesign') then 'component_selection' else 'bom_budget' end::public.decision_class,
          format('LC-%s: %s', lpad(c.case_no::text, 3, '0'), c.trigger_text), v_statement, trim(p_note),
          coalesce((select jsonb_agg(jsonb_build_object('option', x.manufacturer || ' ' || x.mpn, 'status', x.status))
                      from public.substitutes x where x.case_id = c.id and x.id is distinct from p_substitute), '[]'::jsonb),
          case when p_resolution = 'substitute' and (s.checks -> 'test' ->> 'result') = 'pass' then 'hardware_test'
               when p_resolution = 'substitute' then 'datasheet_verified' else 'unverified_assumption' end::public.evidence_category,
          jsonb_build_array(jsonb_build_object('lifecycle_case', c.id, 'notice', c.notice_id, 'impact', c.impact,
                                               'substitute', case when s.id is not null then jsonb_build_object('id', s.id, 'mpn', s.mpn, 'checks', s.checks) end)))
  returning id into v_decision;
  update public.lifecycle_cases set status = 'resolved', resolution = p_resolution, resolution_note = trim(p_note), substitute_id = s.id,
                                    ltb_quantity = case when p_resolution = 'last_time_buy' then p_ltb_quantity end, decision_id = v_decision,
                                    resolved_by = auth.uid(), resolved_at = now()
   where id = c.id;
  perform public.worker_audit(c.project_id, 'lifecycle.case_resolved', 'lifecycle_case', c.id,
                              jsonb_build_object('resolution', p_resolution, 'substitute', p_substitute, 'ltb_quantity', p_ltb_quantity));
  return v_decision;
end;
$$;

create function public.propose_substitute(p_project uuid, p_case uuid, p_original_mpn text, p_mpn text, p_manufacturer text, p_part uuid default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; c public.lifecycle_cases;
begin
  perform public.need_role(p_project, '{owner,engineer}', 'propose substitutes');
  if p_case is not null then
    select * into c from public.lifecycle_cases where id = p_case and project_id = p_project;
    if c.id is null then raise exception 'case not found'; end if;
    if c.status = 'resolved' then raise exception 'the case is resolved'; end if;
  end if;
  if upper(trim(p_mpn)) = upper(trim(coalesce(c.mpn, p_original_mpn))) then raise exception 'a substitute must be a different part'; end if;
  insert into public.substitutes (project_id, case_id, original_part_id, original_mpn, part_id, mpn, manufacturer)
  values (p_project, p_case, c.part_id, coalesce(c.mpn, trim(p_original_mpn)), p_part, trim(p_mpn), trim(p_manufacturer))
  returning id into v_id;
  perform public.worker_audit(p_project, 'substitute.proposed', 'substitute', v_id, jsonb_build_object('original', coalesce(c.mpn, p_original_mpn), 'mpn', p_mpn));
  return v_id;
end;
$$;

-- The qualification checklist. Each check is pass, fail or not applicable, always with its basis; a passing test
-- check names a passing S6 test run of this project.
create function public.save_substitute_checks(p_substitute uuid, p_checks jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  s public.substitutes;
  k text;
  v jsonb;
begin
  select * into s from public.substitutes where id = p_substitute for update;
  if s.id is null then raise exception 'substitute not found'; end if;
  perform public.need_role(s.project_id, '{owner,engineer}', 'qualify substitutes');
  if s.status in ('qualified', 'rejected') then raise exception 'the substitute is already %', s.status; end if;
  if jsonb_typeof(p_checks) <> 'object' then raise exception 'checks must be an object'; end if;
  for k, v in select * from jsonb_each(p_checks) loop
    if k not in ('pinout', 'electrical', 'environmental', 'supply', 'test') then raise exception 'unknown check %', k; end if;
    if coalesce(v ->> 'result', '') not in ('pass', 'fail', 'na', '') then raise exception '%: the result is pass, fail or na', k; end if;
    if coalesce(v ->> 'result', '') <> '' and coalesce(trim(v ->> 'basis'), '') = '' then raise exception '%: give the basis for the result', k; end if;
    if k = 'test' and v ->> 'result' = 'pass' and not exists (
         select 1 from public.test_runs where id = (v ->> 'test_run_id')::uuid and project_id = s.project_id and verdict = 'pass') then
      raise exception 'test: a passing result names a passing test run of this project';
    end if;
  end loop;
  update public.substitutes set checks = p_checks, status = 'qualifying' where id = s.id;
end;
$$;

create function public.decide_substitute(p_substitute uuid, p_qualified boolean, p_note text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  s public.substitutes;
  k text;
  v_missing text[] := '{}';
begin
  select * into s from public.substitutes where id = p_substitute for update;
  if s.id is null then raise exception 'substitute not found'; end if;
  perform public.need_role(s.project_id, '{owner,reviewer}', 'qualify or reject substitutes');
  if s.status in ('qualified', 'rejected') then raise exception 'the substitute is already %', s.status; end if;
  if coalesce(trim(p_note), '') = '' then raise exception 'give the reason'; end if;
  if p_qualified then
    foreach k in array array['pinout', 'electrical', 'environmental', 'supply', 'test'] loop
      if coalesce(s.checks -> k ->> 'result', '') = '' then v_missing := v_missing || k; end if;
      if s.checks -> k ->> 'result' = 'fail' then raise exception 'the % check failed', k; end if;
    end loop;
    if array_length(v_missing, 1) > 0 then raise exception 'checks not done: %', array_to_string(v_missing, ', '); end if;
    if s.checks -> 'pinout' ->> 'result' <> 'pass' or s.checks -> 'electrical' ->> 'result' <> 'pass' then
      raise exception 'the pin-out and electrical checks must pass';
    end if;
  end if;
  update public.substitutes set status = case when p_qualified then 'qualified' else 'rejected' end::public.substitute_status,
                                status_note = trim(p_note), decided_by = auth.uid(), decided_at = now() where id = s.id;
  perform public.worker_audit(s.project_id, case when p_qualified then 'substitute.qualified' else 'substitute.rejected' end, 'substitute', s.id,
                              jsonb_build_object('mpn', s.mpn, 'note', p_note));
end;
$$;

create function public.set_lot_delivery(p_lot uuid, p_promised_on date, p_delivered_on date) returns void
language plpgsql security definer set search_path = '' as $$
declare l public.production_lots;
begin
  select * into l from public.production_lots where id = p_lot for update;
  if l.id is null then raise exception 'lot not found'; end if;
  perform public.need_role(l.project_id, '{owner,engineer}', 'record delivery dates');
  if p_delivered_on > current_date then raise exception 'the delivery date is in the future'; end if;
  update public.production_lots set promised_on = p_promised_on, delivered_on = p_delivered_on where id = l.id;
  perform public.worker_audit(l.project_id, 'lot.delivery', 'production_lot', l.id, jsonb_build_object('promised_on', p_promised_on, 'delivered_on', p_delivered_on));
end;
$$;

-- A supplier's record across the projects the caller can see (row security applies): RFQ responses, quoted lead
-- times, awards, production lots, inspection defect rates and on-time delivery.
create function public.vendor_performance(p_manufacturer uuid) returns jsonb
language sql stable security invoker set search_path = '' as $$
  with r as (select rr.status, rr.id from public.rfq_recipients rr where rr.manufacturer_id = p_manufacturer),
  q as (select distinct on (qq.recipient_id) qq.lead_time_days, qq.id from public.rfq_quotes qq join r on r.id = qq.recipient_id
         order by qq.recipient_id, qq.revision desc),
  l as (select * from public.production_lots where manufacturer_id = p_manufacturer),
  i as (select li.* from public.lot_inspections li join l on l.id = li.lot_id)
  select jsonb_build_object(
    'rfqs_invited', (select count(*) from r where status <> 'pending' and status <> 'revoked'),
    'rfqs_quoted', (select count(*) from r where status = 'quoted'),
    'rfqs_declined', (select count(*) from r where status = 'declined'),
    'awards', (select count(*) from public.rfqs x join q on q.id = x.awarded_quote_id),
    'median_lead_days', (select percentile_cont(0.5) within group (order by lead_time_days) from q where lead_time_days is not null),
    'lots', (select count(*) from l),
    'lots_accepted', (select count(*) from l where status = 'accepted'),
    'lots_rejected', (select count(*) from l where status = 'rejected'),
    'units_inspected', (select coalesce(sum(inspected), 0) from i),
    'defects', (select coalesce(sum(defects), 0) from i),
    'deliveries', (select count(*) from l where delivered_on is not null and promised_on is not null),
    'on_time', (select count(*) from l where delivered_on is not null and promised_on is not null and delivered_on <= promised_on));
$$;

-- S8 stage blockers: unresolved lifecycle cases.
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
    if p_stage = 'S8' then
      if not exists (select 1 from public.project_bom_parts where project_id = p_project) then
        b := b || '[{"kind":"lifecycle","text":"no BOM loaded into the lifecycle watch"}]';
      end if;
      for r in select case_no, mpn, status, severity from public.lifecycle_cases where project_id = p_project and status <> 'resolved' order by case_no loop
        b := b || jsonb_build_array(jsonb_build_object('kind', 'lifecycle',
               'text', format('LC-%s (%s) is %s: %s', lpad(r.case_no::text, 3, '0'), r.severity, r.status, r.mpn)));
      end loop;
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

revoke all on function public.record_part_notice(uuid, public.notice_kind, text, text, text, date, date, date, date, text, text),
  public.load_bom_parts(uuid, uuid, jsonb), public.open_lifecycle_case(uuid, uuid, text, text, text[], text, text, uuid),
  public.assess_lifecycle_case(uuid, text, text), public.resolve_lifecycle_case(uuid, public.case_resolution, text, uuid, integer),
  public.propose_substitute(uuid, uuid, text, text, text, uuid), public.save_substitute_checks(uuid, jsonb),
  public.decide_substitute(uuid, boolean, text), public.set_lot_delivery(uuid, date, date), public.vendor_performance(uuid) from public, anon;
grant execute on function public.record_part_notice(uuid, public.notice_kind, text, text, text, date, date, date, date, text, text),
  public.load_bom_parts(uuid, uuid, jsonb), public.open_lifecycle_case(uuid, uuid, text, text, text[], text, text, uuid),
  public.assess_lifecycle_case(uuid, text, text), public.resolve_lifecycle_case(uuid, public.case_resolution, text, uuid, integer),
  public.propose_substitute(uuid, uuid, text, text, text, uuid), public.save_substitute_checks(uuid, jsonb),
  public.decide_substitute(uuid, boolean, text), public.set_lot_delivery(uuid, date, date), public.vendor_performance(uuid) to authenticated, service_role;
