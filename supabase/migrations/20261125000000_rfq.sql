-- Manufacturers and RFQ (M-RFQ, spec §12).
--
-- Manufacturer directory: a shared list of suppliers with their categories, processes, NDA method, certifications and
-- contacts. A supplier starts as a *candidate*; someone confirms its legal identity and process matrix (*verified*);
-- a library editor puts it on the approved vendor list (*approved*). A contact's email is used only after someone
-- records how it was confirmed; until then the contact shows "verify contact" and cannot receive an RFQ. Nothing is
-- guessed.
--
-- RFQs belong to a project. Owners and engineers write the manifest (§12 RFQ manifest), choose which committed design
-- files and requirements to disclose, and add recipients. A worker builds one supplier-neutral packet (cover letter,
-- manifest, NDA template, selected requirements, files, checksums). The owner then approves the disclosure: the
-- approval is bound to the packet's sha256 and lists every file and recipient in the audit log. Any later change to
-- what would be disclosed drops the approval. Sending opens a time-limited access window for each recipient in the
-- supplier portal (VX Design does not send email: the owner sends the drafted emails). Suppliers sign in with the
-- confirmed email of their contact, download the packet while their window is open, and quote or decline. Choosing a
-- supplier is recorded as a decision; placing the order happens outside VX Design.

create type public.manufacturing_category as enum (
  'bare_pcb', 'pcba', 'sheet_metal', 'cnc', 'printing_casting', 'injection_molding', 'silicone_overmolding',
  'displays', 'battery_packs', 'harnesses', 'finishing_assembly', 'compliance_labs');
create type public.manufacturer_status as enum ('candidate', 'verified', 'approved', 'inactive');
create type public.nda_method as enum ('our_template', 'their_template', 'mutual', 'none_required', 'unknown');
create type public.rfq_status as enum ('draft', 'packaging', 'ready', 'approved', 'sent', 'closed', 'canceled');
create type public.rfq_sharing_scope as enum ('summary_only', 'drawings', 'full_design');
create type public.rfq_recipient_status as enum ('pending', 'invited', 'viewed', 'quoted', 'declined', 'revoked');
create type public.rfq_nda_status as enum ('not_required', 'pending', 'signed');

-- Who works with the directory: library editors and anyone who is an owner or engineer on some project.
-- Clients and suppliers never see it.
create function public.is_directory_user() returns boolean
language sql stable security definer set search_path = '' as $$
  select public.is_knowledge_editor() or exists (
    select 1 from public.project_members where user_id = auth.uid() and role in ('owner', 'engineer'));
$$;

-- The caller's email, only once confirmed (a supplier proves it owns the contact's mailbox by confirming it).
create function public.confirmed_email() returns text
language sql stable security definer set search_path = '' as $$
  select lower(email) from auth.users where id = auth.uid() and email_confirmed_at is not null;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Directory
-- ---------------------------------------------------------------------------------------------------------------

create table public.manufacturers (
  id                 uuid primary key default gen_random_uuid(),
  display_name       text not null check (length(trim(display_name)) between 1 and 200),
  legal_name         text,
  country            text check (country is null or country ~ '^[A-Z]{2}$'),   -- ISO 3166-1 alpha-2
  website            text check (website is null or website ~ '^https://'),
  categories         public.manufacturing_category[] not null default '{}',
  processes          text[] not null default '{}',          -- process matrix, in our words: "6-layer FR-4", "CNC 6061"
  certifications     jsonb not null default '[]'::jsonb,    -- [{name, evidence}] e.g. ISO 9001 with where it was seen
  nda_method         public.nda_method not null default 'unknown',
  file_formats       text[] not null default '{}',          -- what they accept: Gerber X2, ODB++, STEP, DXF
  lead_time_note     text,
  notes              text,
  status             public.manufacturer_status not null default 'candidate',
  verified_at        timestamptz,
  verified_by        uuid references auth.users(id) on delete set null,
  verification_note  text,
  approved_at        timestamptz,
  approved_by        uuid references auth.users(id) on delete set null,
  created_by         uuid references auth.users(id) on delete set null default auth.uid(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  check (status not in ('verified', 'approved') or (verified_at is not null and legal_name is not null and country is not null
                                                   and cardinality(processes) > 0 and verification_note is not null)),
  check (status <> 'approved' or approved_at is not null)
);
create unique index manufacturers_name_idx on public.manufacturers (lower(display_name));
create trigger manufacturers_updated_at before update on public.manufacturers for each row execute function public.set_updated_at();

-- Changing the legal identity or the process matrix of a verified supplier sends it back to candidate.
create function public.manufacturer_identity_changed() returns trigger
language plpgsql as $$
begin
  if old.status in ('verified', 'approved')
     and (new.legal_name, new.country, new.processes) is distinct from (old.legal_name, old.country, old.processes)
     and new.status = old.status then
    new.status := 'candidate';
    new.verified_at := null; new.verified_by := null; new.verification_note := null;
    new.approved_at := null; new.approved_by := null;
  end if;
  return new;
end;
$$;
create trigger manufacturers_identity before update on public.manufacturers
  for each row execute function public.manufacturer_identity_changed();

create table public.manufacturer_contacts (
  id                  uuid primary key default gen_random_uuid(),
  manufacturer_id     uuid not null references public.manufacturers(id) on delete cascade,
  name                text not null check (length(trim(name)) between 1 and 200),
  role                text,                                   -- "sales", "engineering", "quotes desk"
  email               text check (email is null or email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  phone               text,
  email_status        text not null default 'unverified' check (email_status in ('unverified', 'verified')),
  verification_source text,                                   -- how it was confirmed: "reply from the address, 12 Nov"
  verified_at         timestamptz,
  verified_by         uuid references auth.users(id) on delete set null,
  created_by          uuid references auth.users(id) on delete set null default auth.uid(),
  created_at          timestamptz not null default now(),
  check (email_status <> 'verified' or (email is not null and verified_at is not null and verification_source is not null))
);
create index manufacturer_contacts_mfr_idx on public.manufacturer_contacts (manufacturer_id);
create index manufacturer_contacts_email_idx on public.manufacturer_contacts (lower(email));

-- A changed email is a new, unconfirmed address.
create function public.contact_email_changed() returns trigger
language plpgsql as $$
begin
  if new.email is distinct from old.email and new.email_status = old.email_status then
    new.email := lower(new.email);
    new.email_status := 'unverified'; new.verification_source := null; new.verified_at := null; new.verified_by := null;
  end if;
  return new;
end;
$$;
create trigger manufacturer_contacts_email before update on public.manufacturer_contacts
  for each row execute function public.contact_email_changed();

alter table public.manufacturers enable row level security;
alter table public.manufacturer_contacts enable row level security;
create policy "directory users read manufacturers" on public.manufacturers for select to authenticated using (public.is_directory_user());
create policy "directory users add manufacturers" on public.manufacturers for insert to authenticated with check (public.is_directory_user());
create policy "directory users edit manufacturers" on public.manufacturers for update to authenticated
  using (public.is_directory_user()) with check (public.is_directory_user());
create policy "directory users read contacts" on public.manufacturer_contacts for select to authenticated using (public.is_directory_user());
create policy "directory users add contacts" on public.manufacturer_contacts for insert to authenticated with check (public.is_directory_user());
create policy "directory users edit contacts" on public.manufacturer_contacts for update to authenticated
  using (public.is_directory_user()) with check (public.is_directory_user());
create policy "directory users remove contacts" on public.manufacturer_contacts for delete to authenticated using (public.is_directory_user());
-- Status and verification columns change only through the RPCs below (Supabase grants whole tables by default).
revoke all on public.manufacturers, public.manufacturer_contacts from anon, authenticated;
grant select on public.manufacturers, public.manufacturer_contacts to authenticated;
grant insert (display_name, legal_name, country, website, categories, processes, certifications, nda_method, file_formats,
              lead_time_note, notes),
      update (display_name, legal_name, country, website, categories, processes, certifications, nda_method, file_formats,
              lead_time_note, notes) on public.manufacturers to authenticated;
grant insert (manufacturer_id, name, role, email, phone), update (name, role, email, phone), delete
  on public.manufacturer_contacts to authenticated;
grant all on public.manufacturers, public.manufacturer_contacts to service_role;

create function public.directory_audit(p_event text, p_entity text, p_id uuid, p_payload jsonb) returns void
language sql security definer set search_path = '' as $$
  select public.worker_audit(null, p_event, p_entity, p_id, p_payload);
$$;

-- Verified: legal identity, country and process matrix confirmed, with a note of the evidence.
create function public.verify_manufacturer(p_id uuid, p_note text) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.manufacturers;
begin
  if not public.is_directory_user() then raise exception 'not permitted' using errcode = '42501'; end if;
  select * into v from public.manufacturers where id = p_id for update;
  if v.id is null then raise exception 'manufacturer not found'; end if;
  if v.legal_name is null or v.country is null or cardinality(v.processes) = 0 then
    raise exception 'record the legal name, country and at least one process before verifying';
  end if;
  if coalesce(trim(p_note), '') = '' then raise exception 'say how the identity and processes were confirmed'; end if;
  update public.manufacturers set status = case when status = 'approved' then 'approved'::public.manufacturer_status else 'verified' end,
         verified_at = now(), verified_by = auth.uid(), verification_note = trim(p_note)
   where id = p_id;
  perform public.directory_audit('manufacturer.verified', 'manufacturer', p_id, jsonb_build_object('note', p_note));
end;
$$;

-- Approved vendor list: library editors only, and only for verified suppliers.
create function public.set_manufacturer_status(p_id uuid, p_status public.manufacturer_status, p_note text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.manufacturers;
begin
  select * into v from public.manufacturers where id = p_id for update;
  if v.id is null or not public.is_directory_user() then raise exception 'manufacturer not found or not permitted' using errcode = '42501'; end if;
  if p_status = 'approved' then
    if not public.is_knowledge_editor() then
      raise exception 'only library editors put suppliers on the approved vendor list' using errcode = '42501';
    end if;
    if v.status not in ('verified', 'approved') then raise exception 'verify the supplier before approving it'; end if;
    update public.manufacturers set status = 'approved', approved_at = now(), approved_by = auth.uid() where id = p_id;
  elsif p_status = 'inactive' then
    update public.manufacturers set status = 'inactive' where id = p_id;
  elsif p_status = 'candidate' then
    update public.manufacturers set status = 'candidate', verified_at = null, verified_by = null, verification_note = null,
           approved_at = null, approved_by = null where id = p_id;
  else
    raise exception 'use verify_manufacturer to verify';
  end if;
  perform public.directory_audit('manufacturer.status', 'manufacturer', p_id, jsonb_build_object('status', p_status, 'note', p_note));
end;
$$;

create function public.verify_contact(p_id uuid, p_source text) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.manufacturer_contacts;
begin
  if not public.is_directory_user() then raise exception 'not permitted' using errcode = '42501'; end if;
  select * into v from public.manufacturer_contacts where id = p_id for update;
  if v.id is null then raise exception 'contact not found'; end if;
  if v.email is null then raise exception 'this contact has no email address to verify'; end if;
  if coalesce(trim(p_source), '') = '' then raise exception 'say how the email address was confirmed (never guessed)'; end if;
  update public.manufacturer_contacts set email_status = 'verified', verification_source = trim(p_source),
         verified_at = now(), verified_by = auth.uid() where id = p_id;
  perform public.directory_audit('contact.verified', 'manufacturer_contact', p_id,
                                 jsonb_build_object('manufacturer', v.manufacturer_id, 'source', p_source));
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- RFQs
-- ---------------------------------------------------------------------------------------------------------------

create table public.rfqs (
  id                     uuid primary key default gen_random_uuid(),
  project_id             uuid not null references public.projects(id) on delete cascade,
  rfq_no                 integer not null,
  title                  text not null check (length(trim(title)) between 1 and 200),
  category               public.manufacturing_category not null,
  status                 public.rfq_status not null default 'draft',
  manifest               jsonb not null default '{}'::jsonb,   -- §12 RFQ manifest (schema in @vx/contracts RfqManifest)
  sharing_scope          public.rfq_sharing_scope not null default 'drawings',
  response_deadline      date,
  packet_path            text,
  packet_sha256          text check (packet_sha256 is null or packet_sha256 ~ '^[0-9a-f]{64}$'),
  packet_files           jsonb not null default '[]'::jsonb,   -- [{name, sha256, size, source}]
  packet_error           text,
  packaged_at            timestamptz,
  attempts               integer not null default 0,
  claimed_by             text,
  claimed_at             timestamptz,
  approved_by            uuid references auth.users(id) on delete set null,
  approved_at            timestamptz,
  approval_note          text,
  approved_packet_sha256 text,
  sent_at                timestamptz,
  closed_at              timestamptz,
  close_note             text,
  awarded_quote_id       uuid,
  award_decision_id      uuid references public.decisions(id),
  created_by             uuid references auth.users(id) on delete set null default auth.uid(),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (project_id, rfq_no),
  check (status not in ('approved', 'sent') or (approved_packet_sha256 is not null and approved_packet_sha256 = packet_sha256)),
  check (status not in ('ready', 'approved', 'sent') or packet_path is not null)
);
create index rfqs_queue_idx on public.rfqs (status, updated_at) where status = 'packaging';
create trigger rfqs_updated_at before update on public.rfqs for each row execute function public.set_updated_at();

create table public.rfq_attachments (
  rfq_id              uuid not null references public.rfqs(id) on delete cascade,
  artifact_version_id uuid not null references public.artifact_versions(id),
  primary key (rfq_id, artifact_version_id)
);

create table public.rfq_recipients (
  id                 uuid primary key default gen_random_uuid(),
  rfq_id             uuid not null references public.rfqs(id) on delete cascade,
  project_id         uuid not null references public.projects(id) on delete cascade,
  manufacturer_id    uuid not null references public.manufacturers(id),
  contact_id         uuid not null references public.manufacturer_contacts(id),
  email              text not null,                         -- the verified address at the time of approval
  status             public.rfq_recipient_status not null default 'pending',
  nda_status         public.rfq_nda_status not null default 'pending',
  nda_note           text,
  access_opens_at    timestamptz,
  access_expires_at  timestamptz,
  first_viewed_at    timestamptz,
  decline_reason     text,
  created_at         timestamptz not null default now(),
  unique (rfq_id, manufacturer_id)
);
create index rfq_recipients_email_idx on public.rfq_recipients (lower(email));

create table public.rfq_quotes (
  id              uuid primary key default gen_random_uuid(),
  rfq_id          uuid not null references public.rfqs(id) on delete cascade,
  recipient_id    uuid not null references public.rfq_recipients(id) on delete cascade,
  project_id      uuid not null references public.projects(id) on delete cascade,
  revision        integer not null,
  currency        text not null check (currency ~ '^[A-Z]{3}$'),
  lines           jsonb not null,           -- [{quantity, unit_price}] at each quantity break
  tooling_cost    numeric(14, 2) check (tooling_cost >= 0),
  shipping_cost   numeric(14, 2) check (shipping_cost >= 0),
  lead_time_days  integer check (lead_time_days between 0 and 3650),
  valid_until     date,
  notes           text check (length(notes) <= 4000),
  submitted_by    uuid references auth.users(id) on delete set null default auth.uid(),
  submitted_at    timestamptz not null default now(),
  unique (recipient_id, revision)
);
create trigger rfq_quotes_immutable before update on public.rfq_quotes for each row execute function public.forbid_modification();
alter table public.rfqs add constraint rfqs_awarded_quote_fk foreign key (awarded_quote_id) references public.rfq_quotes(id);

-- Staff of the project read RFQs; clients do not (open decision: whether clients see quotes). Suppliers see only
-- their own invitation, through supplier_rfqs().
alter table public.rfqs enable row level security;
alter table public.rfq_attachments enable row level security;
alter table public.rfq_recipients enable row level security;
alter table public.rfq_quotes enable row level security;
create policy "staff read rfqs" on public.rfqs for select to authenticated using (public.is_project_staff(project_id));
create policy "staff read rfq attachments" on public.rfq_attachments for select to authenticated
  using (exists (select 1 from public.rfqs q where q.id = rfq_id and public.is_project_staff(q.project_id)));
create policy "staff read rfq recipients" on public.rfq_recipients for select to authenticated using (public.is_project_staff(project_id));
create policy "staff read rfq quotes" on public.rfq_quotes for select to authenticated using (public.is_project_staff(project_id));
grant select on public.rfqs, public.rfq_attachments, public.rfq_recipients, public.rfq_quotes to authenticated;
grant all on public.rfqs, public.rfq_attachments, public.rfq_recipients, public.rfq_quotes to service_role;

-- What is still missing before a packet can be built (shown on the RFQ page; enforced here).
create function public.rfq_missing(p_rfq_id uuid) returns text[]
language plpgsql stable security definer set search_path = '' as $$
declare
  v public.rfqs;
  m jsonb;
  out text[] := '{}';
  n_files integer;
begin
  select * into v from public.rfqs where id = p_rfq_id;
  if v.id is null then return array['RFQ not found']; end if;
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

-- Any change to what would be disclosed drops the packet and the owner's approval.
create function public.rfq_reset(p_rfq public.rfqs, p_why text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_rfq.status in ('sent', 'closed', 'canceled') then
    raise exception 'this RFQ is %: it can no longer be changed (start a new RFQ)', p_rfq.status;
  end if;
  if p_rfq.status = 'packaging' then
    raise exception 'the packet is being built; wait for it to finish before changing the RFQ';
  end if;
  update public.rfqs set status = 'draft', packet_path = null, packet_sha256 = null, packet_files = '[]'::jsonb, packet_error = null,
         packaged_at = null, approved_by = null, approved_at = null, approval_note = null, approved_packet_sha256 = null
   where id = p_rfq.id;
  if p_rfq.status = 'approved' then
    perform public.worker_audit(p_rfq.project_id, 'rfq.approval_invalidated', 'rfq', p_rfq.id, jsonb_build_object('because', p_why));
  end if;
end;
$$;

create function public.rfq_for_staff(p_rfq_id uuid, p_roles public.project_role[] default '{owner,engineer}') returns public.rfqs
language plpgsql security definer set search_path = '' as $$
declare v public.rfqs;
begin
  select * into v from public.rfqs where id = p_rfq_id for update;
  if v.id is null or not public.has_project_role(v.project_id, p_roles) then
    raise exception 'RFQ not found or not permitted' using errcode = '42501';
  end if;
  return v;
end;
$$;

create function public.create_rfq(p_project_id uuid, p_title text, p_category public.manufacturing_category) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_no integer;
begin
  if not public.has_project_role(p_project_id, '{owner,engineer}') then
    raise exception 'only owners and engineers of the project can prepare RFQs' using errcode = '42501';
  end if;
  if coalesce(trim(p_title), '') = '' then raise exception 'give the RFQ a title'; end if;
  perform pg_advisory_xact_lock(hashtext('rfq:' || p_project_id::text));
  select coalesce(max(rfq_no), 0) + 1 into v_no from public.rfqs where project_id = p_project_id;
  insert into public.rfqs (project_id, rfq_no, title, category, manifest)
  values (p_project_id, v_no, trim(p_title), p_category,
          jsonb_build_object('quote_breakdown', jsonb_build_array('unit price at each quantity', 'tooling / NRE', 'shipping', 'lead time'),
                             'tooling_ownership', 'buyer', 'quantities', jsonb_build_object('prototype', 5)))
  returning id into v_id;
  perform public.worker_audit(p_project_id, 'rfq.created', 'rfq', v_id, jsonb_build_object('rfq_no', v_no, 'category', p_category));
  return v_id;
end;
$$;

create function public.update_rfq(p_rfq_id uuid, p_title text, p_manifest jsonb, p_sharing_scope public.rfq_sharing_scope,
                                  p_response_deadline date) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.rfqs;
begin
  v := public.rfq_for_staff(p_rfq_id);
  if jsonb_typeof(p_manifest) <> 'object' then raise exception 'the manifest must be an object'; end if;
  perform public.rfq_reset(v, 'manifest changed');
  update public.rfqs set title = coalesce(nullif(trim(p_title), ''), title), manifest = p_manifest, sharing_scope = p_sharing_scope,
         response_deadline = p_response_deadline where id = v.id;
end;
$$;

-- Files: committed versions of this project's artifacts only (never scratch work).
create function public.set_rfq_attachments(p_rfq_id uuid, p_version_ids uuid[]) returns integer
language plpgsql security definer set search_path = '' as $$
declare v public.rfqs; n integer;
begin
  v := public.rfq_for_staff(p_rfq_id);
  if exists (select 1 from unnest(coalesce(p_version_ids, '{}')) x
              where not exists (select 1 from public.artifact_versions av
                                 where av.id = x and av.project_id = v.project_id and av.status = 'committed')) then
    raise exception 'only approved (committed) files of this project can be attached';
  end if;
  perform public.rfq_reset(v, 'attachments changed');
  delete from public.rfq_attachments where rfq_id = v.id;
  insert into public.rfq_attachments (rfq_id, artifact_version_id) select v.id, x from unnest(coalesce(p_version_ids, '{}')) x;
  get diagnostics n = row_count;
  return n;
end;
$$;

create function public.add_rfq_recipient(p_rfq_id uuid, p_contact_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v public.rfqs; c public.manufacturer_contacts; m public.manufacturers; v_id uuid;
begin
  v := public.rfq_for_staff(p_rfq_id);
  select * into c from public.manufacturer_contacts where id = p_contact_id;
  select * into m from public.manufacturers where id = c.manufacturer_id;
  if c.id is null then raise exception 'contact not found'; end if;
  if m.status not in ('verified', 'approved') then
    raise exception '% is a % supplier: verify its legal identity and processes first', m.display_name, m.status;
  end if;
  if c.email_status <> 'verified' then
    raise exception 'verify contact: % has no confirmed email address', c.name;
  end if;
  perform public.rfq_reset(v, 'recipient added');
  insert into public.rfq_recipients (rfq_id, project_id, manufacturer_id, contact_id, email, nda_status)
  values (v.id, v.project_id, m.id, c.id, lower(c.email),
          case when v.sharing_scope = 'summary_only' or m.nda_method = 'none_required' then 'not_required' else 'pending' end::public.rfq_nda_status)
  on conflict (rfq_id, manufacturer_id) do update set contact_id = excluded.contact_id, email = excluded.email
  returning id into v_id;
  return v_id;
end;
$$;

create function public.remove_rfq_recipient(p_recipient_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.rfq_recipients; v public.rfqs;
begin
  select * into r from public.rfq_recipients where id = p_recipient_id;
  v := public.rfq_for_staff(r.rfq_id);
  perform public.rfq_reset(v, 'recipient removed');
  delete from public.rfq_recipients where id = p_recipient_id;
end;
$$;

-- NDA status per supplier (the NDA itself is signed outside VX Design; record what and when).
create function public.set_rfq_nda(p_recipient_id uuid, p_status public.rfq_nda_status, p_note text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.rfq_recipients; v public.rfqs;
begin
  select * into r from public.rfq_recipients where id = p_recipient_id;
  v := public.rfq_for_staff(r.rfq_id, '{owner}');
  if p_status = 'signed' and coalesce(trim(p_note), '') = '' then
    raise exception 'record which NDA was signed and when';
  end if;
  update public.rfq_recipients set nda_status = p_status, nda_note = nullif(trim(coalesce(p_note, '')), '') where id = r.id;
  perform public.worker_audit(v.project_id, 'rfq.nda_recorded', 'rfq_recipient', r.id, jsonb_build_object('status', p_status, 'note', p_note));
end;
$$;

create function public.request_rfq_packet(p_rfq_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.rfqs; v_missing text[];
begin
  v := public.rfq_for_staff(p_rfq_id);
  if v.status not in ('draft', 'ready') then raise exception 'the packet can be built from a draft (this RFQ is %)', v.status; end if;
  v_missing := public.rfq_missing(v.id);
  if cardinality(v_missing) > 0 then raise exception 'the RFQ is incomplete: %', array_to_string(v_missing, ', '); end if;
  update public.rfqs set status = 'packaging', packet_error = null, attempts = 0, claimed_by = null where id = v.id;
end;
$$;

create function public.cancel_rfq(p_rfq_id uuid, p_note text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.rfqs;
begin
  v := public.rfq_for_staff(p_rfq_id);
  if v.status in ('sent', 'closed', 'canceled') then raise exception 'a % RFQ cannot be canceled (close it instead)', v.status; end if;
  update public.rfqs set status = 'canceled', close_note = p_note, closed_at = now(), approved_packet_sha256 = null where id = v.id;
  perform public.worker_audit(v.project_id, 'rfq.canceled', 'rfq', v.id, jsonb_build_object('note', p_note));
end;
$$;

-- Workers build the packet.
create function public.claim_rfq_packet(p_worker_id text, p_stale_seconds integer default 600) returns public.rfqs
language plpgsql security definer set search_path = '' as $$
declare v public.rfqs;
begin
  update public.rfqs set status = 'draft', packet_error = 'the packet could not be built after 3 attempts', claimed_by = null
   where status = 'packaging' and claimed_by is not null and claimed_at < now() - make_interval(secs => p_stale_seconds) and attempts >= 3;
  select * into v from public.rfqs
   where status = 'packaging' and (claimed_by is null or claimed_at < now() - make_interval(secs => p_stale_seconds))
   order by updated_at for update skip locked limit 1;
  if v.id is null then return null; end if;
  update public.rfqs set claimed_by = p_worker_id, claimed_at = now(), attempts = attempts + 1 where id = v.id returning * into v;
  return v;
end;
$$;

-- p_files: [{name, sha256, size, source}]; p_error set: back to draft with the reason.
create function public.complete_rfq_packet(p_rfq_id uuid, p_worker_id text, p_path text, p_sha256 text, p_files jsonb,
                                           p_error text default null) returns public.rfq_status
language plpgsql security definer set search_path = '' as $$
declare v public.rfqs;
begin
  select * into v from public.rfqs where id = p_rfq_id for update;
  if v.status <> 'packaging' or v.claimed_by is distinct from p_worker_id then
    raise exception 'RFQ % is not being packaged by %', p_rfq_id, p_worker_id using hint = 'lease_lost';
  end if;
  if p_error is not null then
    update public.rfqs set status = 'draft', packet_error = p_error, claimed_by = null where id = v.id;
    return 'draft';
  end if;
  if split_part(p_path, '/', 1) <> v.project_id::text then raise exception 'the packet must be stored in the project''s folder'; end if;
  update public.rfqs set status = 'ready', packet_path = p_path, packet_sha256 = p_sha256, packet_files = coalesce(p_files, '[]'::jsonb),
         packet_error = null, packaged_at = now(), claimed_by = null where id = v.id;
  perform public.worker_audit(v.project_id, 'rfq.packaged', 'rfq', v.id, jsonb_build_object('sha256', p_sha256, 'files', p_files));
  return 'ready';
end;
$$;

-- The owner's explicit approval of the disclosure: exactly this packet, to exactly these suppliers.
create function public.approve_rfq_disclosure(p_rfq_id uuid, p_note text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.rfqs; v_bad text; v_recipients jsonb;
begin
  v := public.rfq_for_staff(p_rfq_id, '{owner}');
  if v.status <> 'ready' then raise exception 'only a built packet can be approved (this RFQ is %)', v.status; end if;
  if not exists (select 1 from public.rfq_recipients where rfq_id = v.id) then raise exception 'add at least one supplier'; end if;
  select string_agg(m.display_name || ': ' ||
           case when m.status not in ('verified', 'approved') then 'supplier no longer verified'
                when c.email_status <> 'verified' or lower(c.email) <> r.email then 'verify contact'
                else 'NDA not signed (the scope is the full design)' end, '; ')
    into v_bad
    from public.rfq_recipients r join public.manufacturers m on m.id = r.manufacturer_id join public.manufacturer_contacts c on c.id = r.contact_id
   where r.rfq_id = v.id
     and (m.status not in ('verified', 'approved') or c.email_status <> 'verified' or lower(c.email) <> r.email
          or (v.sharing_scope = 'full_design' and r.nda_status <> 'signed'));
  if v_bad is not null then raise exception 'cannot approve: %', v_bad; end if;
  select jsonb_agg(jsonb_build_object('manufacturer', m.display_name, 'email', r.email, 'nda', r.nda_status) order by m.display_name)
    into v_recipients
    from public.rfq_recipients r join public.manufacturers m on m.id = r.manufacturer_id where r.rfq_id = v.id;
  update public.rfqs set status = 'approved', approved_by = auth.uid(), approved_at = now(), approval_note = p_note,
         approved_packet_sha256 = packet_sha256 where id = v.id;
  perform public.worker_audit(v.project_id, 'rfq.disclosure_approved', 'rfq', v.id, jsonb_build_object(
    'packet_sha256', v.packet_sha256, 'files', v.packet_files, 'recipients', v_recipients, 'sharing_scope', v.sharing_scope,
    'note', p_note));
end;
$$;

-- Opens each supplier's access window. Email is sent by the owner (drafts on the RFQ page).
create function public.send_rfq(p_rfq_id uuid, p_window_days integer default 21) returns integer
language plpgsql security definer set search_path = '' as $$
declare v public.rfqs; n integer;
begin
  v := public.rfq_for_staff(p_rfq_id, '{owner}');
  if v.status <> 'approved' or v.approved_packet_sha256 is distinct from v.packet_sha256 then
    raise exception 'the owner must approve this exact packet before it is released';
  end if;
  if p_window_days is null or p_window_days not between 1 and 90 then raise exception 'the access window is 1 to 90 days'; end if;
  update public.rfq_recipients set status = 'invited', access_opens_at = now(), access_expires_at = now() + make_interval(days => p_window_days)
   where rfq_id = v.id;
  get diagnostics n = row_count;
  update public.rfqs set status = 'sent', sent_at = now() where id = v.id;
  perform public.worker_audit(v.project_id, 'rfq.sent', 'rfq', v.id, jsonb_build_object(
    'packet_sha256', v.packet_sha256, 'window_days', p_window_days,
    'recipients', (select jsonb_agg(email order by email) from public.rfq_recipients where rfq_id = v.id)));
  return n;
end;
$$;

create function public.revoke_rfq_access(p_recipient_id uuid, p_note text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.rfq_recipients; v public.rfqs;
begin
  select * into r from public.rfq_recipients where id = p_recipient_id;
  v := public.rfq_for_staff(r.rfq_id, '{owner}');
  update public.rfq_recipients set status = 'revoked', access_expires_at = least(coalesce(access_expires_at, now()), now()) where id = r.id;
  perform public.worker_audit(v.project_id, 'rfq.access_revoked', 'rfq_recipient', r.id, jsonb_build_object('email', r.email, 'note', p_note));
end;
$$;

-- Close; optionally choose a quote. The choice is recorded as a manufacturing decision; the order is placed outside.
create function public.close_rfq(p_rfq_id uuid, p_quote_id uuid default null, p_note text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.rfqs; q public.rfq_quotes; m public.manufacturers; v_decision uuid;
begin
  v := public.rfq_for_staff(p_rfq_id, '{owner}');
  if v.status <> 'sent' then raise exception 'only a sent RFQ can be closed (this one is %)', v.status; end if;
  if p_quote_id is not null then
    select * into q from public.rfq_quotes where id = p_quote_id and rfq_id = v.id;
    if q.id is null then raise exception 'that quote is not part of this RFQ'; end if;
    select m2.* into m from public.rfq_recipients r join public.manufacturers m2 on m2.id = r.manufacturer_id where r.id = q.recipient_id;
    insert into public.decisions (project_id, decision_class, title, statement, rationale, evidence_category, evidence_refs)
    values (v.project_id, 'manufacturing', format('Supplier selected for RFQ-%s: %s', lpad(v.rfq_no::text, 3, '0'), m.display_name),
            format('%s quoted %s (revision %s) for "%s". The purchase order is placed outside VX Design and needs the owner.',
                   m.display_name, q.currency, q.revision, v.title),
            p_note, 'unverified_assumption',
            jsonb_build_array(jsonb_build_object('rfq', v.id, 'quote', q.id, 'packet_sha256', v.packet_sha256)))
    returning id into v_decision;
  end if;
  update public.rfq_recipients set access_expires_at = least(access_expires_at, now())
   where rfq_id = v.id and access_expires_at > now();
  update public.rfqs set status = 'closed', closed_at = now(), close_note = p_note, awarded_quote_id = p_quote_id,
         award_decision_id = v_decision where id = v.id;
  perform public.worker_audit(v.project_id, case when p_quote_id is null then 'rfq.closed' else 'rfq.awarded' end, 'rfq', v.id,
                              jsonb_build_object('quote', p_quote_id, 'manufacturer', m.display_name, 'note', p_note));
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Supplier portal
-- ---------------------------------------------------------------------------------------------------------------

create function public.rfq_recipient_for_supplier(p_recipient_id uuid) returns public.rfq_recipients
language plpgsql stable security definer set search_path = '' as $$
declare r public.rfq_recipients;
begin
  select * into r from public.rfq_recipients where id = p_recipient_id and email = public.confirmed_email();
  if r.id is null then raise exception 'invitation not found' using errcode = '42501'; end if;
  return r;
end;
$$;

create function public.rfq_window_open(r public.rfq_recipients) returns boolean
language sql stable set search_path = '' as $$
  select r.status not in ('pending', 'revoked') and now() >= r.access_opens_at and now() < r.access_expires_at
     and exists (select 1 from public.rfqs q where q.id = r.rfq_id and q.status = 'sent');
$$;

-- The supplier's view: their own invitations only. No project name, no other suppliers, no other quotes.
create function public.supplier_rfqs() returns table (
  recipient_id uuid, rfq_ref text, title text, category public.manufacturing_category, manifest jsonb,
  sharing_scope public.rfq_sharing_scope, response_deadline date, status public.rfq_recipient_status, rfq_status public.rfq_status,
  access_expires_at timestamptz, window_open boolean, packet_sha256 text, packet_files jsonb, manufacturer text,
  my_quotes jsonb)
language sql stable security definer set search_path = '' as $$
  select r.id, coalesce(q.manifest ->> 'project_code', 'VX') || '-RFQ-' || lpad(q.rfq_no::text, 3, '0'), q.title, q.category,
         q.manifest - 'requirement_refs', q.sharing_scope, q.response_deadline, r.status, q.status, r.access_expires_at,
         public.rfq_window_open(r), q.packet_sha256, q.packet_files, m.display_name,
         coalesce((select jsonb_agg(to_jsonb(x) - 'project_id' - 'submitted_by' order by x.revision desc)
                     from public.rfq_quotes x where x.recipient_id = r.id), '[]'::jsonb)
    from public.rfq_recipients r join public.rfqs q on q.id = r.rfq_id join public.manufacturers m on m.id = r.manufacturer_id
   where public.confirmed_email() is not null and r.email = public.confirmed_email() and r.status <> 'pending'
   order by r.access_opens_at desc;
$$;

-- Returns the packet path (the storage policy below lets the supplier read it while the window is open).
create function public.supplier_open_rfq(p_recipient_id uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare r public.rfq_recipients; v public.rfqs;
begin
  r := public.rfq_recipient_for_supplier(p_recipient_id);
  if not public.rfq_window_open(r) then raise exception 'the access window for this RFQ is closed'; end if;
  select * into v from public.rfqs where id = r.rfq_id;
  update public.rfq_recipients set status = case when status = 'invited' then 'viewed'::public.rfq_recipient_status else status end,
         first_viewed_at = coalesce(first_viewed_at, now()) where id = r.id;
  perform public.worker_audit(v.project_id, 'rfq.packet_opened', 'rfq_recipient', r.id,
                              jsonb_build_object('email', r.email, 'packet_sha256', v.packet_sha256));
  return v.packet_path;
end;
$$;

create function public.rfq_packet_readable(p_name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.rfqs q join public.rfq_recipients r on r.rfq_id = q.id
                  where q.packet_path = p_name and r.email = public.confirmed_email() and public.rfq_window_open(r));
$$;

-- p_quote: {currency, lines: [{quantity, unit_price}], tooling_cost, shipping_cost, lead_time_days, valid_until, notes}
create function public.submit_quote(p_recipient_id uuid, p_quote jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare r public.rfq_recipients; v public.rfqs; v_id uuid; v_rev integer; v_lines jsonb;
begin
  r := public.rfq_recipient_for_supplier(p_recipient_id);
  if not public.rfq_window_open(r) then raise exception 'the access window for this RFQ is closed'; end if;
  select * into v from public.rfqs where id = r.rfq_id;
  begin
    select jsonb_agg(jsonb_build_object('quantity', (l ->> 'quantity')::integer, 'unit_price', (l ->> 'unit_price')::numeric)
                     order by (l ->> 'quantity')::integer)
      into v_lines from jsonb_array_elements(p_quote -> 'lines') l;
  exception when others then
    raise exception 'each quote line needs a quantity and a unit price';
  end;
  if v_lines is null or exists (select 1 from jsonb_array_elements(v_lines) l
                                 where (l ->> 'quantity') is null or (l ->> 'quantity')::integer <= 0
                                    or (l ->> 'unit_price') is null or (l ->> 'unit_price')::numeric < 0) then
    raise exception 'each quote line needs a quantity above zero and a unit price';
  end if;
  select coalesce(max(revision), 0) + 1 into v_rev from public.rfq_quotes where recipient_id = r.id;
  insert into public.rfq_quotes (rfq_id, recipient_id, project_id, revision, currency, lines, tooling_cost, shipping_cost,
                                 lead_time_days, valid_until, notes)
  values (r.rfq_id, r.id, r.project_id, v_rev, upper(p_quote ->> 'currency'), v_lines, (p_quote ->> 'tooling_cost')::numeric,
          (p_quote ->> 'shipping_cost')::numeric, (p_quote ->> 'lead_time_days')::integer, (p_quote ->> 'valid_until')::date,
          nullif(trim(coalesce(p_quote ->> 'notes', '')), ''))
  returning id into v_id;
  update public.rfq_recipients set status = 'quoted', decline_reason = null where id = r.id;
  perform public.worker_audit(v.project_id, 'rfq.quote_received', 'rfq_quote', v_id,
                              jsonb_build_object('email', r.email, 'revision', v_rev));
  return v_id;
end;
$$;

create function public.decline_rfq(p_recipient_id uuid, p_reason text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.rfq_recipients;
begin
  r := public.rfq_recipient_for_supplier(p_recipient_id);
  if not public.rfq_window_open(r) then raise exception 'the access window for this RFQ is closed'; end if;
  update public.rfq_recipients set status = 'declined', decline_reason = nullif(trim(coalesce(p_reason, '')), '') where id = r.id;
  perform public.worker_audit(r.project_id, 'rfq.declined', 'rfq_recipient', r.id, jsonb_build_object('email', r.email, 'reason', p_reason));
end;
$$;

do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    create policy "suppliers read their rfq packet" on storage.objects for select to authenticated
      using (bucket_id = 'project-files' and split_part(name, '/', 2) = 'rfq' and public.rfq_packet_readable(name));
  end if;
end;
$$;

revoke all on function public.verify_manufacturer, public.set_manufacturer_status, public.verify_contact, public.rfq_missing,
  public.create_rfq, public.update_rfq, public.set_rfq_attachments, public.add_rfq_recipient, public.remove_rfq_recipient,
  public.set_rfq_nda, public.request_rfq_packet, public.cancel_rfq, public.approve_rfq_disclosure, public.send_rfq,
  public.revoke_rfq_access, public.close_rfq, public.supplier_rfqs, public.supplier_open_rfq, public.submit_quote,
  public.decline_rfq from public, anon;
grant execute on function public.verify_manufacturer, public.set_manufacturer_status, public.verify_contact, public.rfq_missing,
  public.create_rfq, public.update_rfq, public.set_rfq_attachments, public.add_rfq_recipient, public.remove_rfq_recipient,
  public.set_rfq_nda, public.request_rfq_packet, public.cancel_rfq, public.approve_rfq_disclosure, public.send_rfq,
  public.revoke_rfq_access, public.close_rfq, public.supplier_rfqs, public.supplier_open_rfq, public.submit_quote,
  public.decline_rfq to authenticated;
revoke all on function public.rfq_reset, public.rfq_for_staff, public.rfq_recipient_for_supplier, public.directory_audit
  from public, anon, authenticated;
revoke all on function public.claim_rfq_packet, public.complete_rfq_packet from public, anon, authenticated;
grant execute on function public.claim_rfq_packet, public.complete_rfq_packet to service_role;

-- Discovery list from the spec (§12): candidates only, not endorsements. No legal names, countries or contacts are
-- filled in: those are confirmed before a supplier is verified.
insert into public.manufacturers (display_name, website, categories, notes, created_by) values
  ('JLCPCB', 'https://jlcpcb.com', '{bare_pcb,pcba,cnc,printing_casting}', 'Discovery list (spec §12). Not verified.', null),
  ('PCBWay', 'https://www.pcbway.com', '{bare_pcb,pcba,cnc,printing_casting,sheet_metal,injection_molding}', 'Discovery list (spec §12). Not verified.', null),
  ('Seeed Fusion', 'https://www.seeedstudio.com', '{bare_pcb,pcba}', 'Discovery list (spec §12). Not verified.', null),
  ('Protolabs', 'https://www.protolabs.com', '{cnc,injection_molding,printing_casting,sheet_metal}', 'Discovery list (spec §12). Not verified.', null),
  ('Xometry', 'https://www.xometry.com', '{cnc,sheet_metal,printing_casting,injection_molding}', 'Discovery list (spec §12). Not verified.', null),
  ('Hubs', 'https://www.hubs.com', '{cnc,printing_casting,sheet_metal,injection_molding}', 'Discovery list (spec §12). Not verified.', null);
