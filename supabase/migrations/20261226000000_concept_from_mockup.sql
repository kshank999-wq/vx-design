-- A mock-up the team already has is the concept: no images need generating. concept_from_reference turns a project
-- reference (a mock-up, render, sketch or photo) into a one-variant concept round that points at the uploaded file,
-- marked as taken from the reference, so it can be frozen like any concept (freeze_design records the decision).
create function public.concept_from_reference(p_reference uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  r public.project_references;
  v_round uuid;
  v_no integer;
  v_id uuid;
begin
  select * into r from public.project_references where id = p_reference;
  if r.id is null or not public.has_project_role(r.project_id, '{owner,engineer,reviewer}') then
    raise exception 'reference not found or not permitted' using errcode = '42501';
  end if;
  if r.kind not in ('mockup', 'render', 'sketch', 'photo', 'drawing') then raise exception 'only a mock-up, render, sketch, photo or drawing can be the concept'; end if;
  select v.id into v_id from public.concept_variants v join public.concept_rounds cr on cr.id = v.round_id
   where v.project_id = r.project_id and cr.provider = 'reference' and v.sha256 = r.sha256 limit 1;
  if v_id is not null then return v_id; end if;
  perform pg_advisory_xact_lock(hashtext('concepts:' || r.project_id::text));
  select coalesce(max(round_no), 0) + 1 into v_no from public.concept_rounds where project_id = r.project_id;
  insert into public.concept_rounds (project_id, round_no, direction, variant_count, status, brief, provider, model, completed_at)
  values (r.project_id, v_no, left(format('From the uploaded %s REF-%s: %s', r.kind, r.ref_no, r.title), 4000), 1, 'ready',
          jsonb_build_object('source', 'reference', 'reference_id', r.id), 'reference', null, now())
  returning id into v_round;
  insert into public.concept_variants (round_id, project_id, ordinal, name, rationale, prompt, status, image_path, mime_type, sha256, provider, provider_meta)
  values (v_round, r.project_id, 1, r.title, coalesce(r.note, 'The team''s own mock-up.'),
          format('Not generated: the uploaded %s REF-%s (%s).', r.kind, r.ref_no, r.filename), 'ready', r.storage_path, r.mime_type, r.sha256, 'reference',
          jsonb_build_object('reference_id', r.id, 'filename', r.filename))
  returning id into v_id;
  perform public.worker_audit(r.project_id, 'concept.from_reference', 'concept_variant', v_id, jsonb_build_object('reference', r.id));
  return v_id;
end;
$$;
revoke all on function public.concept_from_reference(uuid) from public, anon;
grant execute on function public.concept_from_reference(uuid) to authenticated;
