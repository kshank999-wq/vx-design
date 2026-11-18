-- Mechanical checks: tolerance stacks, gasket compression and enclosure thermal estimates, saved per project.
-- The calculation is deterministic (@vx/mech) and runs where the inputs are edited; the stored result is what the
-- inputs gave. Saving clears a review, and an owner or reviewer reviews with a note. Every member reads them.

create table public.mech_analyses (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references public.projects (id) on delete cascade,
  analysis_no    integer not null,
  kind           text not null check (kind in ('tolerance_stack', 'gasket', 'thermal')),
  title          text not null check (length(trim(title)) between 1 and 200),
  note           text,
  inputs         jsonb not null,
  result         jsonb not null,
  verdict        text not null check (verdict in ('pass', 'pass_statistical', 'fail', 'no_limit')),
  assumptions    integer not null default 0 check (assumptions >= 0),   -- inputs marked as assumptions
  calc_version   text not null,
  reviewed_by    uuid references auth.users (id) on delete set null,
  reviewed_at    timestamptz,
  review_note    text,
  created_by     uuid references auth.users (id) on delete set null default auth.uid(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (project_id, analysis_no),
  check (reviewed_at is null or review_note is not null)
);
create trigger mech_analyses_updated_at before update on public.mech_analyses for each row execute function public.set_updated_at();
alter table public.mech_analyses enable row level security;
create policy "members read mech analyses" on public.mech_analyses for select to authenticated using (public.is_project_member(project_id));
grant select on public.mech_analyses to authenticated;
grant all on public.mech_analyses to service_role;

create function public.save_mech_analysis(p_project uuid, p_id uuid, p_kind text, p_title text, p_note text, p_inputs jsonb, p_result jsonb,
                                          p_verdict text, p_assumptions integer, p_calc_version text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid := p_id; v_no integer;
begin
  perform public.need_role(p_project, '{owner,engineer}', 'save mechanical analyses');
  if jsonb_typeof(p_inputs) <> 'object' or jsonb_typeof(p_result) <> 'object' then raise exception 'inputs and result must be objects'; end if;
  if v_id is null then
    perform pg_advisory_xact_lock(hashtext('mech:' || p_project::text));
    select coalesce(max(analysis_no), 0) + 1 into v_no from public.mech_analyses where project_id = p_project;
    insert into public.mech_analyses (project_id, analysis_no, kind, title, note, inputs, result, verdict, assumptions, calc_version)
    values (p_project, v_no, p_kind, trim(p_title), nullif(trim(coalesce(p_note, '')), ''), p_inputs, p_result, p_verdict, coalesce(p_assumptions, 0), p_calc_version)
    returning id into v_id;
  else
    update public.mech_analyses set title = trim(p_title), note = nullif(trim(coalesce(p_note, '')), ''), inputs = p_inputs, result = p_result,
                                    verdict = p_verdict, assumptions = coalesce(p_assumptions, 0), calc_version = p_calc_version,
                                    reviewed_by = null, reviewed_at = null, review_note = null
     where id = v_id and project_id = p_project and kind = p_kind;
    if not found then raise exception 'analysis not found'; end if;
  end if;
  perform public.worker_audit(p_project, 'mech.saved', 'mech_analysis', v_id, jsonb_build_object('kind', p_kind, 'title', p_title, 'verdict', p_verdict));
  return v_id;
end;
$$;

create function public.review_mech_analysis(p_id uuid, p_note text) returns void
language plpgsql security definer set search_path = '' as $$
declare a public.mech_analyses;
begin
  select * into a from public.mech_analyses where id = p_id for update;
  if a.id is null then raise exception 'analysis not found'; end if;
  perform public.need_role(a.project_id, '{owner,reviewer}', 'review mechanical analyses');
  if coalesce(trim(p_note), '') = '' then raise exception 'write the review note'; end if;
  update public.mech_analyses set reviewed_by = auth.uid(), reviewed_at = now(), review_note = trim(p_note) where id = a.id;
  perform public.worker_audit(a.project_id, 'mech.reviewed', 'mech_analysis', a.id, jsonb_build_object('note', p_note, 'verdict', a.verdict));
end;
$$;

create function public.delete_mech_analysis(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare a public.mech_analyses;
begin
  select * into a from public.mech_analyses where id = p_id;
  if a.id is null then raise exception 'analysis not found'; end if;
  perform public.need_role(a.project_id, '{owner,engineer}', 'delete mechanical analyses');
  if a.reviewed_at is not null then raise exception 'a reviewed analysis is kept; edit it to make a new version for review'; end if;
  delete from public.mech_analyses where id = a.id;
  perform public.worker_audit(a.project_id, 'mech.deleted', 'mech_analysis', a.id, jsonb_build_object('title', a.title));
end;
$$;

revoke all on function public.save_mech_analysis(uuid, uuid, text, text, text, jsonb, jsonb, text, integer, text), public.review_mech_analysis(uuid, text),
  public.delete_mech_analysis(uuid) from public, anon;
grant execute on function public.save_mech_analysis(uuid, uuid, text, text, text, jsonb, jsonb, text, integer, text), public.review_mech_analysis(uuid, text),
  public.delete_mech_analysis(uuid) to authenticated, service_role;
