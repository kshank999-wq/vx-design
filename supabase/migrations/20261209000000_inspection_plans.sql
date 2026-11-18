-- Inspection plans (S5): what to check on bare boards, assembled boards and enclosures, drafted from the committed
-- fab package or enclosure fit report, edited by owners and engineers, approved by owners or reviewers. An approved
-- plan is frozen; changes make a new version, and approving it supersedes the previous approved plan of that kind.
-- Production lots name the plan they are inspected against.

create table public.inspection_plans (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references public.projects (id) on delete cascade,
  plan_no        integer not null,
  version        integer not null default 1,
  kind           text not null check (kind in ('bare_pcb', 'pcba', 'enclosure')),
  title          text not null check (length(trim(title)) between 1 and 200),
  source         jsonb not null default '{}'::jsonb,     -- {artifact, version_id, version, procedure}
  items          jsonb not null default '[]'::jsonb,     -- [{key, stage, characteristic, method, sample, acceptance, reference, critical}]
  status         text not null default 'draft' check (status in ('draft', 'approved', 'superseded')),
  supersedes_id  uuid unique references public.inspection_plans (id),
  approved_by    uuid references auth.users (id) on delete set null,
  approved_at    timestamptz,
  approval_note  text,
  created_by     uuid references auth.users (id) on delete set null default auth.uid(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (project_id, plan_no, version),
  check (status = 'draft' or approved_at is not null)
);
create trigger inspection_plans_updated_at before update on public.inspection_plans for each row execute function public.set_updated_at();

create function public.protect_inspection_plan() returns trigger
language plpgsql as $$
begin
  if old.status = 'draft' then return new; end if;
  if old.status = 'approved' and new.status = 'superseded' and new.items = old.items and new.title = old.title then return new; end if;
  raise exception 'inspection plan IP-% v% is % and cannot be changed (revise it to make a new version)', lpad(old.plan_no::text, 3, '0'), old.version, old.status;
end;
$$;
create trigger inspection_plans_protect before update on public.inspection_plans for each row execute function public.protect_inspection_plan();
revoke all on function public.protect_inspection_plan() from public, anon, authenticated;

alter table public.inspection_plans enable row level security;
create policy "members read inspection plans" on public.inspection_plans for select to authenticated using (public.is_project_member(project_id));
grant select on public.inspection_plans to authenticated;
grant all on public.inspection_plans to service_role;

alter table public.production_lots add column inspection_plan_id uuid references public.inspection_plans (id);

-- Items must be well formed: unique keys, a known stage and sample, and the text a supplier needs.
create function public.inspection_items_problem(p_items jsonb) returns text
language plpgsql immutable set search_path = '' as $$
declare i jsonb; keys text[] := '{}';
begin
  if jsonb_typeof(p_items) <> 'array' then return 'items must be a list'; end if;
  for i in select * from jsonb_array_elements(p_items) loop
    if coalesce(i ->> 'key', '') !~ '^[a-z0-9_]{1,60}$' then return format('item key %s is not valid', coalesce(i ->> 'key', '(none)')); end if;
    if (i ->> 'key') = any (keys) then return format('item key %s is used twice', i ->> 'key'); end if;
    keys := keys || (i ->> 'key');
    if coalesce(i ->> 'stage', '') not in ('incoming', 'in_process', 'final') then return format('%s: stage is incoming, in_process or final', i ->> 'key'); end if;
    if coalesce(i ->> 'sample', '') not in ('100%', 'sample', 'first article') then return format('%s: sample is 100%%, sample or first article', i ->> 'key'); end if;
    if coalesce(trim(i ->> 'characteristic'), '') = '' or coalesce(trim(i ->> 'method'), '') = '' or coalesce(trim(i ->> 'acceptance'), '') = '' then
      return format('%s: give the characteristic, method and acceptance', i ->> 'key');
    end if;
  end loop;
  return null;
end;
$$;

create function public.save_inspection_plan(p_project uuid, p_id uuid, p_kind text, p_title text, p_source jsonb, p_items jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid := p_id; v_no integer; v_problem text; p public.inspection_plans;
begin
  perform public.need_role(p_project, '{owner,engineer}', 'edit inspection plans');
  v_problem := public.inspection_items_problem(p_items);
  if v_problem is not null then raise exception '%', v_problem; end if;
  if v_id is null then
    perform pg_advisory_xact_lock(hashtext('inspection:' || p_project::text));
    select coalesce(max(plan_no), 0) + 1 into v_no from public.inspection_plans where project_id = p_project;
    insert into public.inspection_plans (project_id, plan_no, kind, title, source, items)
    values (p_project, v_no, p_kind, trim(p_title), coalesce(p_source, '{}'), p_items) returning id into v_id;
    perform public.worker_audit(p_project, 'inspection_plan.drafted', 'inspection_plan', v_id, jsonb_build_object('plan_no', v_no, 'kind', p_kind, 'items', jsonb_array_length(p_items)));
  else
    select * into p from public.inspection_plans where id = v_id and project_id = p_project for update;
    if p.id is null then raise exception 'inspection plan not found'; end if;
    if p.status <> 'draft' then raise exception 'inspection plan IP-% v% is % (revise it to make a new version)', lpad(p.plan_no::text, 3, '0'), p.version, p.status; end if;
    update public.inspection_plans set title = trim(p_title), items = p_items, source = coalesce(p_source, source) where id = v_id;
  end if;
  return v_id;
end;
$$;

create function public.approve_inspection_plan(p_id uuid, p_note text) returns void
language plpgsql security definer set search_path = '' as $$
declare p public.inspection_plans;
begin
  select * into p from public.inspection_plans where id = p_id for update;
  if p.id is null then raise exception 'inspection plan not found'; end if;
  perform public.need_role(p.project_id, '{owner,reviewer}', 'approve inspection plans');
  if p.status <> 'draft' then raise exception 'the plan is already %', p.status; end if;
  if jsonb_array_length(p.items) = 0 then raise exception 'the plan has no items'; end if;
  update public.inspection_plans set status = 'superseded'
   where project_id = p.project_id and kind = p.kind and status = 'approved' and id <> p.id;
  update public.inspection_plans set status = 'approved', approved_by = auth.uid(), approved_at = now(), approval_note = nullif(trim(coalesce(p_note, '')), '')
   where id = p.id;
  perform public.worker_audit(p.project_id, 'inspection_plan.approved', 'inspection_plan', p.id, jsonb_build_object('plan_no', p.plan_no, 'version', p.version));
end;
$$;

create function public.revise_inspection_plan(p_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare p public.inspection_plans; v_id uuid;
begin
  select * into p from public.inspection_plans where id = p_id;
  if p.id is null then raise exception 'inspection plan not found'; end if;
  perform public.need_role(p.project_id, '{owner,engineer}', 'revise inspection plans');
  if p.status <> 'approved' then raise exception 'only an approved plan is revised (edit the draft instead)'; end if;
  if exists (select 1 from public.inspection_plans where supersedes_id = p.id) then raise exception 'a newer version of this plan already exists'; end if;
  insert into public.inspection_plans (project_id, plan_no, version, kind, title, source, items, supersedes_id)
  values (p.project_id, p.plan_no, p.version + 1, p.kind, p.title, p.source, p.items, p.id) returning id into v_id;
  return v_id;
end;
$$;

create function public.set_lot_inspection_plan(p_lot uuid, p_plan uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare l public.production_lots;
begin
  select * into l from public.production_lots where id = p_lot for update;
  if l.id is null then raise exception 'lot not found'; end if;
  perform public.need_role(l.project_id, '{owner,engineer}', 'set a lot''s inspection plan');
  if l.status in ('accepted', 'rejected') then raise exception 'the lot is % and closed', l.status; end if;
  if p_plan is not null and not exists (select 1 from public.inspection_plans where id = p_plan and project_id = l.project_id and status = 'approved') then
    raise exception 'choose an approved inspection plan of this project';
  end if;
  update public.production_lots set inspection_plan_id = p_plan where id = l.id;
  perform public.worker_audit(l.project_id, 'lot.inspection_plan', 'production_lot', l.id, jsonb_build_object('plan', p_plan));
end;
$$;

revoke all on function public.save_inspection_plan(uuid, uuid, text, text, jsonb, jsonb), public.approve_inspection_plan(uuid, text),
  public.revise_inspection_plan(uuid), public.set_lot_inspection_plan(uuid, uuid), public.inspection_items_problem(jsonb) from public, anon;
grant execute on function public.save_inspection_plan(uuid, uuid, text, text, jsonb, jsonb), public.approve_inspection_plan(uuid, text),
  public.revise_inspection_plan(uuid), public.set_lot_inspection_plan(uuid, uuid), public.inspection_items_problem(jsonb) to authenticated, service_role;
