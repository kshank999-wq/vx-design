-- Concept and industrial design (M-CON, spec §9).
--
-- A member asks for a round of concept variants with a direction ("rugged, matte black, one-hand use"), or asks to
-- refine an earlier variant. A worker has Claude turn the requirements and direction into a brief (variants with
-- image prompts, colour/material/finish, a rough envelope), then an image-generation provider renders each variant.
-- The client compares, refines, and signs off by freezing one variant: the freeze is recorded as a decision that
-- later engineering depends on, and changing it needs a stated reason (change control, §7).
--
-- Every image is a concept, not CAD: never used as engineering geometry. Prompts, references, provider, model and
-- seed are stored with each image.

create type public.concept_round_status as enum ('queued', 'generating', 'ready', 'partial', 'failed', 'canceled');

create table public.concept_rounds (
  id                uuid primary key default gen_random_uuid(),
  project_id        uuid not null references public.projects(id) on delete cascade,
  round_no          integer not null,
  direction         text not null check (length(direction) between 1 and 4000),
  variant_count     integer not null check (variant_count between 1 and 4),
  parent_variant_id uuid,                                   -- refinement of an earlier variant (FK added below)
  status            public.concept_round_status not null default 'queued',
  brief             jsonb not null default '{}'::jsonb,     -- Claude's brief: variants, envelope, assumptions
  brief_model       text,
  provider          text,
  model             text,
  error             text,
  attempts          integer not null default 0,
  claimed_by        text,
  claimed_at        timestamptz,
  requested_by      uuid references auth.users(id) on delete set null default auth.uid(),
  created_at        timestamptz not null default now(),
  completed_at      timestamptz,
  unique (project_id, round_no)
);
create index concept_rounds_queue_idx on public.concept_rounds (status, created_at) where status in ('queued', 'generating');

create table public.concept_variants (
  id              uuid primary key default gen_random_uuid(),
  round_id        uuid not null references public.concept_rounds(id) on delete cascade,
  project_id      uuid not null references public.projects(id) on delete cascade,
  ordinal         integer not null,
  name            text not null,
  rationale       text,
  prompt          text not null,                          -- exactly what the image provider was sent
  cmf             jsonb not null default '{}'::jsonb,     -- colours, materials, finishes
  status          text not null check (status in ('ready', 'failed')),
  error           text,
  image_path      text,
  mime_type       text,
  sha256          text,
  provider        text,
  model           text,
  seed            text,
  revised_prompt  text,                                   -- if the provider rewrote the prompt
  provider_meta   jsonb not null default '{}'::jsonb,     -- usage, safety notes, watermark notice
  created_at      timestamptz not null default now(),
  unique (round_id, ordinal),
  check (status <> 'ready' or (image_path is not null and sha256 is not null))
);
alter table public.concept_rounds add constraint concept_rounds_parent_fk
  foreign key (parent_variant_id) references public.concept_variants(id) on delete set null;

create table public.design_freezes (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references public.projects(id) on delete cascade,
  variant_id     uuid not null references public.concept_variants(id),
  decision_id    uuid not null references public.decisions(id),
  envelope       jsonb not null,                          -- {length_mm, width_mm, height_mm, basis}
  cmf            jsonb not null default '{}'::jsonb,
  note           text,
  change_reason  text,                                    -- required when replacing an earlier freeze
  supersedes_id  uuid unique references public.design_freezes(id),
  frozen_by      uuid references auth.users(id) on delete set null default auth.uid(),
  frozen_at      timestamptz not null default now()
);
create trigger design_freezes_immutable before update or delete on public.design_freezes
  for each row execute function public.forbid_modification();

create view public.current_design_freeze with (security_invoker = true) as
  select f.* from public.design_freezes f
   where not exists (select 1 from public.design_freezes n where n.supersedes_id = f.id);

alter table public.concept_rounds enable row level security;
alter table public.concept_variants enable row level security;
alter table public.design_freezes enable row level security;
create policy "members read concept rounds" on public.concept_rounds for select to authenticated using (public.is_project_member(project_id));
create policy "members read concept variants" on public.concept_variants for select to authenticated using (public.is_project_member(project_id));
create policy "members read design freezes" on public.design_freezes for select to authenticated using (public.is_project_member(project_id));
grant select on public.concept_rounds, public.concept_variants, public.design_freezes, public.current_design_freeze to authenticated;
grant all on public.concept_rounds, public.concept_variants, public.design_freezes to service_role;
grant select on public.current_design_freeze to service_role;

-- Ask for a round. Owners, engineers and clients may ask (concepts are where the client steers). Image generation
-- costs money, so a project gets at most 2 rounds in progress and 12 per day.
create function public.request_concepts(p_project_id uuid, p_direction text, p_count integer default 3,
                                        p_parent_variant_id uuid default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  v_no integer;
begin
  if not public.has_project_role(p_project_id, '{owner,engineer,client}') then
    raise exception 'only owners, engineers and clients of the project can ask for concepts' using errcode = '42501';
  end if;
  if coalesce(trim(p_direction), '') = '' then
    raise exception 'describe the direction: look, feel, materials, how it is held or mounted';
  end if;
  if p_count is null or p_count not between 1 and 4 then
    raise exception 'ask for 1 to 4 variants';
  end if;
  if p_parent_variant_id is not null and not exists (
       select 1 from public.concept_variants where id = p_parent_variant_id and project_id = p_project_id and status = 'ready') then
    raise exception 'the variant to refine must be a finished concept of this project';
  end if;
  perform pg_advisory_xact_lock(hashtext('concepts:' || p_project_id::text));
  if (select count(*) from public.concept_rounds where project_id = p_project_id and status in ('queued', 'generating')) >= 2 then
    raise exception 'two concept rounds are already in progress; wait for one to finish';
  end if;
  if (select count(*) from public.concept_rounds where project_id = p_project_id and created_at > now() - interval '24 hours') >= 12 then
    raise exception 'this project has had 12 concept rounds in the last 24 hours (image generation is paid); try again later';
  end if;
  select coalesce(max(round_no), 0) + 1 into v_no from public.concept_rounds where project_id = p_project_id;
  insert into public.concept_rounds (project_id, round_no, direction, variant_count, parent_variant_id)
  values (p_project_id, v_no, trim(p_direction), p_count, p_parent_variant_id)
  returning id into v_id;
  perform public.worker_audit(p_project_id, 'concepts.requested', 'concept_round', v_id,
                              jsonb_build_object('count', p_count, 'refines', p_parent_variant_id));
  return v_id;
end;
$$;

create function public.cancel_concepts(p_round_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v public.concept_rounds;
begin
  select * into v from public.concept_rounds where id = p_round_id for update;
  if v.id is null or not public.has_project_role(v.project_id, '{owner,engineer,client}') then
    raise exception 'concept round not found or not permitted' using errcode = '42501';
  end if;
  if v.status <> 'queued' then
    raise exception 'only a round that has not started can be canceled (this one is %)', v.status;
  end if;
  update public.concept_rounds set status = 'canceled', completed_at = now() where id = p_round_id;
end;
$$;

-- Workers.
create function public.claim_concept_round(p_worker_id text, p_stale_seconds integer default 900) returns public.concept_rounds
language plpgsql security definer set search_path = '' as $$
declare
  v public.concept_rounds;
begin
  update public.concept_rounds set status = 'failed', error = 'gave up after 3 attempts', completed_at = now()
   where status = 'generating' and claimed_at < now() - make_interval(secs => p_stale_seconds) and attempts >= 3;
  select * into v from public.concept_rounds
   where status = 'queued' or (status = 'generating' and claimed_at < now() - make_interval(secs => p_stale_seconds))
   order by created_at for update skip locked limit 1;
  if v.id is null then return null; end if;
  update public.concept_rounds set status = 'generating', claimed_by = p_worker_id, claimed_at = now(), attempts = attempts + 1
   where id = v.id returning * into v;
  return v;
end;
$$;

-- p_variants: [{ordinal, name, rationale, prompt, cmf, status, error, image_path, mime_type, sha256, provider, model,
--               seed, revised_prompt, provider_meta}]
create function public.complete_concept_round(p_round_id uuid, p_worker_id text, p_brief jsonb, p_brief_model text,
                                              p_provider text, p_model text, p_variants jsonb, p_error text default null)
returns public.concept_round_status
language plpgsql security definer set search_path = '' as $$
declare
  v public.concept_rounds;
  v_ready integer;
  v_status public.concept_round_status;
begin
  select * into v from public.concept_rounds where id = p_round_id for update;
  if v.status <> 'generating' or v.claimed_by is distinct from p_worker_id then
    raise exception 'round % is not being generated by %', p_round_id, p_worker_id using hint = 'lease_lost';
  end if;
  delete from public.concept_variants where round_id = v.id;   -- a retried attempt replaces a partial earlier one
  insert into public.concept_variants (round_id, project_id, ordinal, name, rationale, prompt, cmf, status, error, image_path,
                                       mime_type, sha256, provider, model, seed, revised_prompt, provider_meta)
  select v.id, v.project_id, (x ->> 'ordinal')::integer, x ->> 'name', x ->> 'rationale', x ->> 'prompt',
         coalesce(x -> 'cmf', '{}'::jsonb), x ->> 'status', x ->> 'error', x ->> 'image_path', x ->> 'mime_type',
         x ->> 'sha256', x ->> 'provider', x ->> 'model', x ->> 'seed', x ->> 'revised_prompt', coalesce(x -> 'provider_meta', '{}'::jsonb)
    from jsonb_array_elements(coalesce(p_variants, '[]'::jsonb)) x;
  if exists (select 1 from public.concept_variants where round_id = v.id and status = 'ready'
              and split_part(image_path, '/', 1) <> v.project_id::text) then
    raise exception 'concept images must be stored in the project''s folder';
  end if;
  select count(*) into v_ready from public.concept_variants where round_id = v.id and status = 'ready';
  v_status := case when v_ready = 0 then 'failed'
                   when v_ready < (select count(*) from public.concept_variants where round_id = v.id) then 'partial'
                   else 'ready' end;
  update public.concept_rounds set status = v_status, brief = coalesce(p_brief, '{}'::jsonb), brief_model = p_brief_model,
         provider = p_provider, model = p_model, error = p_error, claimed_by = null, completed_at = now()
   where id = v.id;
  perform public.worker_audit(v.project_id, 'concepts.generated', 'concept_round', v.id,
                              jsonb_build_object('status', v_status, 'ready', v_ready, 'provider', p_provider, 'model', p_model));
  return v_status;
end;
$$;

-- Sign-off: freeze one variant with its envelope and colour/material/finish. Owners, reviewers and clients.
create function public.freeze_design(p_variant_id uuid, p_envelope jsonb, p_cmf jsonb, p_note text default null,
                                     p_change_reason text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v public.concept_variants;
  v_prev public.design_freezes;
  v_decision uuid;
  v_id uuid;
  v_dims numeric[];
begin
  select * into v from public.concept_variants where id = p_variant_id;
  if v.id is null or not public.has_project_role(v.project_id, '{owner,reviewer,client}') then
    raise exception 'only owners, reviewers and clients of the project can freeze the design' using errcode = '42501';
  end if;
  if v.status <> 'ready' then raise exception 'only a finished concept can be frozen'; end if;
  begin
    v_dims := array[(p_envelope ->> 'length_mm')::numeric, (p_envelope ->> 'width_mm')::numeric, (p_envelope ->> 'height_mm')::numeric];
  exception when others then
    raise exception 'the envelope needs length, width and height in millimetres';
  end;
  if array_position(v_dims, null) is not null or v_dims[1] <= 0 or v_dims[2] <= 0 or v_dims[3] <= 0
     or v_dims[1] > 2000 or v_dims[2] > 2000 or v_dims[3] > 2000 then
    raise exception 'the envelope needs length, width and height in millimetres (0 to 2000)';
  end if;
  perform pg_advisory_xact_lock(hashtext('freeze:' || v.project_id::text));
  select f.* into v_prev from public.current_design_freeze f where f.project_id = v.project_id;
  if v_prev.id is not null and coalesce(trim(p_change_reason), '') = '' then
    raise exception 'a design freeze already exists: give the reason for changing it (change control)';
  end if;
  insert into public.decisions (project_id, decision_class, title, statement, rationale, evidence_category, evidence_refs, supersedes_id)
  values (v.project_id, 'mechanical', format('Design freeze: %s', v.name),
          format('Industrial design frozen on concept "%s"; envelope %s x %s x %s mm (L x W x H)%s.', v.name,
                 v_dims[1], v_dims[2], v_dims[3],
                 case when p_cmf ? 'summary' then '; ' || (p_cmf ->> 'summary') else '' end),
          coalesce(nullif(trim(coalesce(p_change_reason, '')), ''), p_note),
          'unverified_assumption',
          jsonb_build_array(jsonb_build_object('concept_variant', v.id, 'image', v.image_path, 'sha256', v.sha256,
                                               'note', 'concept image, not CAD')),
          (select decision_id from public.design_freezes where id = v_prev.id))
  returning id into v_decision;
  insert into public.design_freezes (project_id, variant_id, decision_id, envelope, cmf, note, change_reason, supersedes_id)
  values (v.project_id, v.id, v_decision,
          jsonb_build_object('length_mm', v_dims[1], 'width_mm', v_dims[2], 'height_mm', v_dims[3],
                             'basis', coalesce(p_envelope ->> 'basis', 'client sign-off')),
          coalesce(p_cmf, '{}'::jsonb), p_note, nullif(trim(coalesce(p_change_reason, '')), ''), v_prev.id)
  returning id into v_id;
  perform public.worker_audit(v.project_id, case when v_prev.id is null then 'design.frozen' else 'design.freeze_changed' end,
                              'design_freeze', v_id, jsonb_build_object('variant', v.id, 'reason', p_change_reason));
  return v_id;
end;
$$;

revoke all on function public.request_concepts, public.cancel_concepts, public.freeze_design from public, anon;
grant execute on function public.request_concepts, public.cancel_concepts, public.freeze_design to authenticated;
revoke all on function public.claim_concept_round, public.complete_concept_round from public, anon, authenticated;
grant execute on function public.claim_concept_round, public.complete_concept_round to service_role;
