-- G6 hardening (security). Each change closes a gap found by the security lint (supabase/tests/security_test.sql):
--
-- 1. The anonymous role gets nothing in the public schema (row level security already blocked it; now the grants do too).
-- 2. Two SECURITY DEFINER helpers answered for any id: rfq_missing() now requires project staff; plan_status_of_task()
--    answers only members (or workers).
-- 3. Storage: clients are project members, so they could list and read every object in the project folder, including
--    RFQ packets and Flux uploads that the pages hide from them. Those folders are now staff-only.
-- 4. Chat: post_message() accepted an "assistant" answer from any member, so a member could post text that looked like
--    the assistant's. Assistant answers must now carry an HMAC from the web server (key in vx_private.secrets, never
--    readable by users), bound to the project, the user, the time and the exact text; each signature works once.
-- 5. Audit log: rows were already append-only; now each project's events form a SHA-256 hash chain, so an edit or a
--    deleted row made outside the application (e.g. by a database superuser) is detectable with verify_audit_chain().

-- 1. Anonymous role --------------------------------------------------------------------------------------------------
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on sequences from anon;
do $$
declare f record;
begin
  -- Functions are executable by PUBLIC unless revoked. Keep whatever signed-in users and workers could call; take it
  -- away from everyone else. Trigger functions need no caller privilege at all.
  for f in select p.oid, p.oid::regprocedure as sig, p.prorettype = 'trigger'::regtype as is_trigger,
                  has_function_privilege('authenticated', p.oid, 'execute') as auth_ok,
                  has_function_privilege('service_role', p.oid, 'execute') as svc_ok
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.prokind = 'f'
  loop
    execute format('revoke all on function %s from public, anon', f.sig);
    if f.is_trigger then
      execute format('revoke all on function %s from authenticated', f.sig);
    elsif f.auth_ok then
      execute format('grant execute on function %s to authenticated', f.sig);
    end if;
    if f.svc_ok then execute format('grant execute on function %s to service_role', f.sig); end if;
  end loop;
end;
$$;

-- 2. Helpers that answered for any id --------------------------------------------------------------------------------
create or replace function public.rfq_missing(p_rfq_id uuid) returns text[]
language plpgsql stable security definer set search_path = '' as $$
declare
  v public.rfqs;
  m jsonb;
  out text[] := '{}';
  n_files integer;
begin
  select * into v from public.rfqs where id = p_rfq_id;
  if v.id is null or (auth.uid() is not null and not public.is_project_staff(v.project_id)) then
    raise exception 'RFQ not found or not permitted' using errcode = '42501';
  end if;
  m := v.manifest;
  select count(*) into n_files from public.rfq_attachments where rfq_id = v.id;
  if coalesce(trim(m ->> 'project_code'), '') = '' then out := out || 'project code'::text; end if;
  if coalesce(trim(m #>> '{buyer,company}'), '') = '' then out := out || 'buyer company'::text; end if;
  if coalesce(trim(m ->> 'classification'), '') = '' then out := out || 'classification'::text; end if;
  if coalesce((m #>> '{quantities,prototype}')::numeric, 0) <= 0 then out := out || 'prototype quantity'::text; end if;
  if coalesce(trim(m ->> 'tooling_ownership'), '') = '' then out := out || 'tooling ownership'::text; end if;
  if coalesce(trim(m ->> 'shipping_terms'), '') = '' then out := out || 'shipping terms'::text; end if;
  if jsonb_array_length(coalesce(m -> 'quote_breakdown', '[]'::jsonb)) = 0 then out := out || 'quote breakdown'::text; end if;
  if v.response_deadline is null or v.response_deadline <= current_date then out := out || 'response deadline (in the future)'::text; end if;
  if v.sharing_scope = 'summary_only' and n_files > 0 then out := out || 'no files (the scope is summary only)'::text; end if;
  if v.sharing_scope <> 'summary_only' and n_files = 0 then out := out || 'at least one design file'::text; end if;
  if n_files > 0 and coalesce(trim(m ->> 'drawing_revision'), '') = '' then out := out || 'drawing revision'::text; end if;
  return out;
end;
$$;

create or replace function public.plan_status_of_task(p_task_id uuid) returns public.plan_status
language sql stable security definer set search_path = '' as $$
  select p.status from public.tasks t
    join public.plans p on p.id = t.plan_id
    join public.projects pr on pr.id = t.project_id
   where t.id = p_task_id and (auth.uid() is null or public.is_project_member(t.project_id));
$$;

-- 3. Staff-only storage folders --------------------------------------------------------------------------------------
create function public.project_file_readable(p_name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select case
    when split_part(p_name, '/', 2) in ('rfq', 'flux') then public.is_project_staff(public.storage_path_project_id(p_name))
    else public.is_project_member(public.storage_path_project_id(p_name))
  end;
$$;
revoke all on function public.project_file_readable(text) from public, anon;
grant execute on function public.project_file_readable(text) to authenticated;
do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    drop policy if exists "members read project files" on storage.objects;
    create policy "members read project files" on storage.objects for select to authenticated
      using (bucket_id = 'project-files' and public.project_file_readable(name));
  end if;
end;
$$;

-- 4. Signed assistant messages ---------------------------------------------------------------------------------------
create schema if not exists vx_private;
revoke all on schema vx_private from public, anon, authenticated;
create table vx_private.secrets (
  name       text primary key,
  value      text not null check (length(value) >= 32),
  created_at timestamptz not null default now()
);
revoke all on vx_private.secrets from public, anon, authenticated;

-- HMAC-SHA256 (RFC 2104) on the built-in sha256(), so no extension is needed.
create function vx_private.hmac_sha256(p_key bytea, p_msg bytea) returns text
language plpgsql immutable set search_path = '' as $$
declare
  k bytea := p_key;
  ipad bytea;
  opad bytea;
begin
  if length(k) > 64 then k := sha256(k); end if;
  k := k || decode(repeat('00', 64 - length(k)), 'hex');
  ipad := k; opad := k;
  for i in 0..63 loop
    ipad := set_byte(ipad, i, get_byte(k, i) # 54);   -- 0x36
    opad := set_byte(opad, i, get_byte(k, i) # 92);   -- 0x5c
  end loop;
  return encode(sha256(opad || sha256(ipad || p_msg)), 'hex');
end;
$$;

-- Operators set the key with the service role (scripts/set-assistant-key.sh); the same key goes in the web server's
-- VX_ASSISTANT_SIGNING_KEY.
create function public.set_assistant_signing_key(p_key text) returns void
language sql security definer set search_path = '' as $$
  insert into vx_private.secrets (name, value) values ('assistant_signing_key', p_key)
  on conflict (name) do update set value = excluded.value, created_at = now();
$$;
revoke all on function public.set_assistant_signing_key(text) from public, anon, authenticated;
grant execute on function public.set_assistant_signing_key(text) to service_role;

alter table public.project_messages add column signature text unique;

drop function public.post_message(uuid, text, text, jsonb);
-- One exchange: the member's question and, when given, the assistant's answer. The answer must be signed by the web
-- server: HMAC-SHA256 over "vx-assistant-v1", the project, the user, the signing time (ms since epoch) and the
-- SHA-256 of the question, the answer and the data JSON, each on its own line.
create function public.post_message(p_project_id uuid, p_question text, p_answer text default null, p_data text default null,
                                    p_signed_at_ms bigint default null, p_signature text default null)
returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  v_id bigint;
  v_key text;
  v_msg text;
  v_data jsonb;
begin
  if not public.is_project_member(p_project_id) then
    raise exception 'not a member of this project' using errcode = '42501';
  end if;
  if coalesce(trim(p_question), '') = '' then raise exception 'empty message'; end if;
  if length(p_question) > 20000 then raise exception 'message too long'; end if;
  if coalesce(trim(p_answer), '') <> '' then
    select value into v_key from vx_private.secrets where name = 'assistant_signing_key';
    if v_key is null then raise exception 'assistant answers are not configured (no signing key)'; end if;
    if p_signature is null or p_signed_at_ms is null then
      raise exception 'assistant answers must be signed by the server' using errcode = '42501';
    end if;
    if abs(extract(epoch from now()) * 1000 - p_signed_at_ms) > 300000 then
      raise exception 'assistant answer signature expired' using errcode = '42501';
    end if;
    v_msg := concat_ws(E'\n', 'vx-assistant-v1', p_project_id::text, auth.uid()::text, p_signed_at_ms::text,
                       encode(sha256(convert_to(p_question, 'UTF8')), 'hex'), encode(sha256(convert_to(p_answer, 'UTF8')), 'hex'),
                       encode(sha256(convert_to(coalesce(p_data, ''), 'UTF8')), 'hex'));
    if vx_private.hmac_sha256(convert_to(v_key, 'UTF8'), convert_to(v_msg, 'UTF8')) <> lower(p_signature) then
      raise exception 'assistant answer signature does not match' using errcode = '42501';
    end if;
    if exists (select 1 from public.project_messages where signature = lower(p_signature)) then
      raise exception 'assistant answer already posted' using errcode = '42501';
    end if;
    begin
      v_data := coalesce(nullif(p_data, '')::jsonb, '{}'::jsonb);
    exception when others then
      raise exception 'assistant data is not JSON';
    end;
  end if;
  insert into public.project_messages (project_id, author_kind, author_id, body)
  values (p_project_id, 'user', auth.uid(), trim(p_question)) returning id into v_id;
  if coalesce(trim(p_answer), '') <> '' then
    insert into public.project_messages (project_id, author_kind, author_id, body, data, signature)
    values (p_project_id, 'assistant', auth.uid(), p_answer, v_data, lower(p_signature));
  end if;
  return v_id;
end;
$$;
revoke all on function public.post_message(uuid, text, text, text, bigint, text) from public, anon;
grant execute on function public.post_message(uuid, text, text, text, bigint, text) to authenticated;

-- 5. Audit hash chain ------------------------------------------------------------------------------------------------
alter table public.audit_events add column seq bigint, add column prev_hash text, add column hash text;

create function public.audit_event_digest(e public.audit_events) returns text
language sql immutable set search_path = '' as $$
  select encode(sha256(convert_to(jsonb_build_array(
    e.seq, e.prev_hash, e.project_id, e.actor_id, e.actor_type, e.event_type, e.entity_type, e.entity_id, e.payload,
    to_char(e.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'))::text, 'UTF8')), 'hex');
$$;

create function public.audit_chain_link() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  last public.audit_events;
begin
  -- One writer per chain at a time, so seq and prev_hash are never shared.
  perform pg_advisory_xact_lock(hashtextextended('audit:' || coalesce(new.project_id::text, '-'), 0));
  select * into last from public.audit_events where project_id is not distinct from new.project_id order by seq desc limit 1;
  new.seq := coalesce(last.seq, 0) + 1;
  new.prev_hash := last.hash;
  new.hash := public.audit_event_digest(new);
  return new;
end;
$$;
revoke all on function public.audit_chain_link() from public, anon, authenticated;

-- Link the events that already exist, in insertion order.
alter table public.audit_events disable trigger audit_events_no_update;
do $$
declare e public.audit_events; prev record;
begin
  for e in select * from public.audit_events order by project_id nulls first, id loop
    select seq, hash into prev from public.audit_events where project_id is not distinct from e.project_id and seq is not null
     order by seq desc limit 1;
    e.seq := coalesce(prev.seq, 0) + 1;
    e.prev_hash := prev.hash;
    e.hash := public.audit_event_digest(e);
    update public.audit_events set seq = e.seq, prev_hash = e.prev_hash, hash = e.hash where id = e.id;
  end loop;
end;
$$;
alter table public.audit_events enable trigger audit_events_no_update;
alter table public.audit_events alter column seq set not null, alter column hash set not null;
create unique index audit_events_chain_idx on public.audit_events (project_id, seq);
create unique index audit_events_global_chain_idx on public.audit_events (seq) where project_id is null;
create trigger audit_events_chain before insert on public.audit_events for each row execute function public.audit_chain_link();

-- Recomputes a project's chain. ok = false names the first event that does not match (edited, inserted out of band,
-- or the one after a deleted event). Staff of the project, or a worker; the global chain (no project) is workers only.
create function public.verify_audit_chain(p_project_id uuid)
returns table (ok boolean, events bigint, first_bad_seq bigint, problem text, head_hash text)
language plpgsql stable security definer set search_path = '' as $$
declare
  e public.audit_events;
  prev_hash text := null;
  expected bigint := 1;
  n bigint := 0;
begin
  if auth.uid() is not null and (p_project_id is null or not public.is_project_staff(p_project_id)) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  for e in select * from public.audit_events where project_id is not distinct from p_project_id order by seq loop
    n := n + 1;
    if e.seq <> expected then
      return query select false, n, expected, format('event %s is missing (found %s next)', expected, e.seq), null::text; return;
    end if;
    if e.prev_hash is distinct from prev_hash then
      return query select false, n, e.seq, 'link to the previous event is broken', null::text; return;
    end if;
    if e.hash <> public.audit_event_digest(e) then
      return query select false, n, e.seq, 'event content does not match its hash (edited)', null::text; return;
    end if;
    prev_hash := e.hash;
    expected := expected + 1;
  end loop;
  return query select true, n, null::bigint, null::text, prev_hash;
end;
$$;
revoke all on function public.verify_audit_chain(uuid) from public, anon;
grant execute on function public.verify_audit_chain(uuid) to authenticated, service_role;
revoke all on function public.audit_event_digest(public.audit_events) from public, anon, authenticated;
