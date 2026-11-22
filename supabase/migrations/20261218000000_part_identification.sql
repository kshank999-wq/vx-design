-- Parts from their files: a datasheet is read to find the part number, manufacturer, what the part is, its subsystem
-- and key specifications; 3D models are matched to parts by the part numbers inside them. People only review.
alter table public.project_parts add column specs jsonb not null default '[]'::jsonb check (jsonb_typeof(specs) = 'array');
alter table public.project_parts add column summary text check (summary is null or length(summary) <= 1000);
alter table public.project_references add column identified_at timestamptz;
alter table public.project_references add column identify_note text check (identify_note is null or length(identify_note) <= 1000);

-- A datasheet read: the part is created (or found by its part number) with what was read, and the file attached.
create function public.record_part_identification(p_reference uuid, p_mpn text, p_manufacturer text, p_role text, p_subsystem text,
                                                  p_specs jsonb, p_summary text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare r public.project_references; v_id uuid; v_key text := upper(regexp_replace(coalesce(p_mpn, ''), '[^A-Za-z0-9]', '', 'g'));
begin
  select * into r from public.project_references where id = p_reference for update;
  if r.id is null then raise exception 'file not found'; end if;
  perform public.need_role(r.project_id, '{owner,engineer}', 'identify parts');
  if length(v_key) < 3 then raise exception 'no part number'; end if;
  select id into v_id from public.project_parts where project_id = r.project_id and upper(regexp_replace(mpn, '[^A-Za-z0-9]', '', 'g')) = v_key;
  if v_id is null then
    insert into public.project_parts (project_id, mpn, manufacturer, role, subsystem, status, specs, summary)
    values (r.project_id, trim(p_mpn), nullif(trim(coalesce(p_manufacturer, '')), ''), left(coalesce(nullif(trim(p_role), ''), trim(p_mpn)), 300),
            coalesce(nullif(p_subsystem, ''), 'other'), 'selected', coalesce(p_specs, '[]'::jsonb), nullif(trim(coalesce(p_summary, '')), ''))
    returning id into v_id;
    perform public.worker_audit(r.project_id, 'part.identified', 'project_part', v_id, jsonb_build_object('mpn', p_mpn, 'from', r.filename));
  else   -- already listed: fill in what is missing, keep what people entered
    update public.project_parts set manufacturer = coalesce(manufacturer, nullif(trim(coalesce(p_manufacturer, '')), '')),
           specs = case when jsonb_array_length(specs) = 0 then coalesce(p_specs, '[]'::jsonb) else specs end,
           summary = coalesce(summary, nullif(trim(coalesce(p_summary, '')), ''))
     where id = v_id;
  end if;
  update public.project_references set part_id = v_id, identified_at = now(), identify_note = null where id = p_reference;
  return v_id;
end;
$$;

-- A file read without a result (no part number found, a model that matches no part): noted, left for a person.
create function public.note_part_file(p_reference uuid, p_note text) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.project_references;
begin
  select * into r from public.project_references where id = p_reference;
  if r.id is null then raise exception 'file not found'; end if;
  perform public.need_role(r.project_id, '{owner,engineer}', 'identify parts');
  update public.project_references set identified_at = now(), identify_note = left(p_note, 1000) where id = p_reference;
end;
$$;

revoke all on function public.record_part_identification(uuid, text, text, text, text, jsonb, text), public.note_part_file(uuid, text) from public, anon;
grant execute on function public.record_part_identification(uuid, text, text, text, text, jsonb, text), public.note_part_file(uuid, text) to authenticated;
