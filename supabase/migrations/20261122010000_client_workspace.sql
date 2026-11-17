-- Client workspace (M-UI): clients see their project's requirements, plan, approvals, outputs and checks,
-- approve or return work at the approval stops, and talk to the project in a chat. They never see runs,
-- executions, worker logs, costs or the audit trail.

create function public.is_project_staff(p_project_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.has_project_role(p_project_id, '{owner,engineer,reviewer,viewer}');
$$;

-- Internal data: staff only.
drop policy "members read runs" on public.runs;
create policy "staff read runs" on public.runs for select to authenticated using (public.is_project_staff(project_id));
drop policy "members read executions" on public.executions;
create policy "staff read executions" on public.executions for select to authenticated using (public.is_project_staff(project_id));
drop policy "members read cost events" on public.cost_events;
create policy "staff read cost events" on public.cost_events for select to authenticated using (public.is_project_staff(project_id));
drop policy "members read audit events" on public.audit_events;
create policy "staff read audit events" on public.audit_events for select to authenticated using (public.is_project_staff(project_id));
drop policy "members read execution logs" on public.execution_logs;
create policy "staff read execution logs" on public.execution_logs for select to authenticated using (public.is_project_staff(project_id));

-- Clients may approve or return work at approval stops, like reviewers.
create or replace function public.decide_task(p_task_id uuid, p_approve boolean, p_note text default null) returns public.task_status
language plpgsql security definer set search_path = '' as $$
declare
  v_task public.tasks;
  v_committed integer;
begin
  select * into v_task from public.tasks where id = p_task_id for update;
  if not found or not public.has_project_role(v_task.project_id, '{owner,reviewer,client}') then
    raise exception 'task not found or not permitted';
  end if;
  if v_task.status <> 'awaiting_approval' then
    raise exception 'task is %, not awaiting approval', v_task.status;
  end if;
  if not p_approve and coalesce(btrim(p_note), '') = '' then
    raise exception 'say what needs to change when returning a task';
  end if;

  update public.approvals
     set status = case when p_approve then 'approved' else 'rejected' end::public.approval_status,
         responded_by = auth.uid(), responded_at = now(), response_note = p_note
   where task_id = p_task_id and status = 'pending';

  if p_approve then
    v_committed := public.commit_task_outputs(p_task_id, v_task.attempts);
    update public.tasks set status = 'complete' where id = p_task_id;
  else
    -- Rework: the reviewer's note is passed to the next attempt; it gets a fresh retry allowance.
    update public.tasks set status = 'ready', retry_base = attempts, interruptions = 0 where id = p_task_id;
  end if;
  perform public.worker_audit(v_task.project_id, case when p_approve then 'task.approved' else 'task.returned' end,
                              'task', p_task_id, jsonb_build_object('note', p_note, 'committed_versions', v_committed));
  return case when p_approve then 'complete' else 'ready' end::public.task_status;
end;
$$;

-- Invitations: owners invite by email; an invitation for someone without an account waits until they sign in.
create table public.project_invitations (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references public.projects(id) on delete cascade,
  email        text not null,
  role         public.project_role not null,
  invited_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  accepted_at  timestamptz,
  accepted_by  uuid references auth.users(id) on delete set null,
  unique (project_id, email)
);
alter table public.project_invitations enable row level security;
create policy "owners read invitations" on public.project_invitations for select to authenticated
  using (public.has_project_role(project_id, '{owner}'));
grant select on public.project_invitations to authenticated;
grant all on public.project_invitations to service_role;

create function public.invite_member(p_project_id uuid, p_email text, p_role public.project_role) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_email text := lower(trim(p_email));
  v_user uuid;
begin
  if not public.has_project_role(p_project_id, '{owner}') then
    raise exception 'only project owners can invite people' using errcode = '42501';
  end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'that does not look like an email address';
  end if;
  if p_role = 'owner' then
    raise exception 'invite owners as engineers; ownership is transferred separately';
  end if;
  select id into v_user from auth.users where lower(email) = v_email;
  if v_user is not null then
    insert into public.project_members (project_id, user_id, role) values (p_project_id, v_user, p_role)
    on conflict (project_id, user_id) do update set role = excluded.role;
    perform public.worker_audit(p_project_id, 'member.added', 'user', v_user, jsonb_build_object('role', p_role));
    return 'added';
  end if;
  insert into public.project_invitations (project_id, email, role, invited_by) values (p_project_id, v_email, p_role, auth.uid())
  on conflict (project_id, email) do update set role = excluded.role, accepted_at = null;
  perform public.worker_audit(p_project_id, 'member.invited', 'invitation', null, jsonb_build_object('email', v_email, 'role', p_role));
  return 'invited';
end;
$$;
revoke all on function public.invite_member(uuid, text, public.project_role) from public, anon;
grant execute on function public.invite_member(uuid, text, public.project_role) to authenticated;

-- Called after sign-in: turns pending invitations for the signed-in email into memberships.
create function public.accept_invitations() returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_email text;
  v_n integer := 0;
  v record;
begin
  select lower(email) into v_email from auth.users where id = auth.uid();
  if v_email is null then return 0; end if;
  for v in select * from public.project_invitations where email = v_email and accepted_at is null for update loop
    insert into public.project_members (project_id, user_id, role) values (v.project_id, auth.uid(), v.role)
    on conflict (project_id, user_id) do nothing;
    update public.project_invitations set accepted_at = now(), accepted_by = auth.uid() where id = v.id;
    perform public.worker_audit(v.project_id, 'member.joined', 'user', auth.uid(), jsonb_build_object('role', v.role));
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;
revoke all on function public.accept_invitations() from public, anon;
grant execute on function public.accept_invitations() to authenticated;

-- Project chat: every member (clients included) reads it; messages are written through post_message.
create type public.message_author as enum ('user', 'assistant');
create table public.project_messages (
  id           bigint generated always as identity primary key,
  project_id   uuid not null references public.projects(id) on delete cascade,
  author_kind  public.message_author not null,
  author_id    uuid references auth.users(id) on delete set null,   -- user messages: the author; assistant: who asked
  body         text not null check (length(body) between 1 and 20000),
  data         jsonb not null default '{}'::jsonb,                  -- assistant: model label, offline flag, references
  created_at   timestamptz not null default now()
);
create index project_messages_project_idx on public.project_messages (project_id, id);
alter table public.project_messages enable row level security;
create policy "members read messages" on public.project_messages for select to authenticated
  using (public.is_project_member(project_id));
grant select on public.project_messages to authenticated;
grant all on public.project_messages to service_role;

-- One exchange: the member's question and the assistant's answer, both attributed to the member who asked.
create function public.post_message(p_project_id uuid, p_question text, p_answer text, p_data jsonb default '{}'::jsonb)
returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  v_id bigint;
begin
  if not public.is_project_member(p_project_id) then
    raise exception 'not a member of this project' using errcode = '42501';
  end if;
  if coalesce(trim(p_question), '') = '' then
    raise exception 'empty message';
  end if;
  insert into public.project_messages (project_id, author_kind, author_id, body)
  values (p_project_id, 'user', auth.uid(), trim(p_question)) returning id into v_id;
  if coalesce(trim(p_answer), '') <> '' then
    insert into public.project_messages (project_id, author_kind, author_id, body, data)
    values (p_project_id, 'assistant', auth.uid(), p_answer, coalesce(p_data, '{}'::jsonb));
  end if;
  return v_id;
end;
$$;
revoke all on function public.post_message(uuid, text, text, jsonb) from public, anon;
grant execute on function public.post_message(uuid, text, text, jsonb) to authenticated;
