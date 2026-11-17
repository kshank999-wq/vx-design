-- Client workspace tests: client role visibility, invitations, approvals, project chat.
-- Runs after worker_test.sql (reuses its users and project).
\set ON_ERROR_STOP on
\o /dev/null

create function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), false);
  if p_user is null then execute 'reset role'; else execute 'set role authenticated'; end if;
end;
$$;
create function pg_temp.as_worker() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', '', false);
  execute 'set role service_role';
end;
$$;
create function pg_temp.expect_error(p_sql text, p_like text) returns void language plpgsql as $$
declare v_err text;
begin
  begin execute p_sql; exception when others then v_err := sqlerrm; end;
  if v_err is null then raise exception 'statement should have failed but succeeded: %', p_sql;
  elsif v_err not like p_like then raise exception 'expected error like "%", got "%"', p_like, v_err; end if;
end;
$$;
create function pg_temp.check(p_ok boolean, p_msg text) returns void language plpgsql as $$
begin if not coalesce(p_ok, false) then raise exception 'check failed: %', p_msg; end if; end;
$$;

create temp table ids (name text primary key, id uuid);
grant all on ids to authenticated, service_role;
create function pg_temp.id(p_name text) returns uuid language sql as $$ select id from ids where name = p_name $$;
create function pg_temp.task(p_key text) returns uuid language sql as
  $$ select id from public.tasks where plan_id = (select id from ids where name = 'plan') and key = p_key $$;

insert into ids select 'plan', id from public.plans where project_id = 'bbbbbbbb-0000-0000-0000-000000000001'
  and status = 'approved' order by version desc limit 1;

-- 1. Owner invites a client who has no account yet; the invitation waits until they sign in.
select pg_temp.act_as('00000000-0000-0000-0000-00000000000c');   -- engineer
select pg_temp.expect_error($$select public.invite_member('bbbbbbbb-0000-0000-0000-000000000001', 'fran@client.test', 'client')$$,
  '%only project owners%');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');   -- owner
insert into public.requirements (project_id, ref_code, kind, text, priority)
values ('bbbbbbbb-0000-0000-0000-000000000001', 'REQ-WS-001', 'functional', 'The slate shall show timecode.', 'must');
select pg_temp.check((select public.invite_member('bbbbbbbb-0000-0000-0000-000000000001', ' Fran@Client.test ', 'client') = 'invited'),
  'invitation stored for an email without an account');
select pg_temp.expect_error($$select public.invite_member('bbbbbbbb-0000-0000-0000-000000000001', 'not-an-email', 'client')$$, '%email%');
select pg_temp.expect_error($$select public.invite_member('bbbbbbbb-0000-0000-0000-000000000001', 'x@y.test', 'owner')$$, '%ownership%');
select pg_temp.act_as(null);
insert into auth.users (id, email) values ('00000000-0000-0000-0000-00000000000f', 'fran@client.test');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000f');
select pg_temp.check((select count(*) = 0 from public.projects where id = 'bbbbbbbb-0000-0000-0000-000000000001'), 'not a member before accepting');
select pg_temp.check((select public.accept_invitations() = 1), 'invitation accepted on sign-in');
select pg_temp.check((select public.accept_invitations() = 0), 'accepting again does nothing');

-- 2. What a client sees.
select pg_temp.check((select count(*) = 1 from public.projects where id = 'bbbbbbbb-0000-0000-0000-000000000001'), 'client sees the project');
select pg_temp.check((select count(*) > 0 from public.tasks where project_id = 'bbbbbbbb-0000-0000-0000-000000000001'), 'client sees the plan');
select pg_temp.check((select count(*) > 0 from public.requirements where project_id = 'bbbbbbbb-0000-0000-0000-000000000001'), 'client sees requirements');
select pg_temp.check((select count(*) = 0 from public.runs), 'client sees no runs');
select pg_temp.check((select count(*) = 0 from public.executions), 'client sees no executions');
select pg_temp.check((select count(*) = 0 from public.cost_events), 'client sees no costs');
select pg_temp.check((select count(*) = 0 from public.execution_logs), 'client sees no worker logs');
select pg_temp.check((select count(*) = 0 from public.audit_events), 'client sees no audit trail');
select pg_temp.check((select count(*) = 0 from public.project_invitations), 'client sees no invitations');
select pg_temp.expect_error($$select public.invite_member('bbbbbbbb-0000-0000-0000-000000000001', 'z@z.test', 'client')$$, '%only project owners%');

-- 3. Clients may decide approval stops; viewers may not.
select pg_temp.expect_error($$select public.decide_task(pg_temp.task('arch'), true, 'ok')$$, '%not awaiting approval%');   -- permitted, wrong state
select pg_temp.act_as('00000000-0000-0000-0000-00000000000e');   -- viewer
select pg_temp.expect_error($$select public.decide_task(pg_temp.task('arch'), true, 'ok')$$, '%not permitted%');

-- 4. Project chat.
select pg_temp.act_as('00000000-0000-0000-0000-00000000000f');
select public.post_message('bbbbbbbb-0000-0000-0000-000000000001', 'What is waiting for me?', 'Nothing right now.', '{"offline": true}');
select pg_temp.check((select array_agg(author_kind::text order by id) = '{user,assistant}' and bool_and(author_id = '00000000-0000-0000-0000-00000000000f')
                      from public.project_messages where project_id = 'bbbbbbbb-0000-0000-0000-000000000001'),
  'question and answer stored, both attributed to the client who asked');
select pg_temp.expect_error($$insert into public.project_messages (project_id, author_kind, body)
                              values ('bbbbbbbb-0000-0000-0000-000000000001', 'assistant', 'forged')$$, '%row-level security%');
select pg_temp.expect_error($$select public.post_message('bbbbbbbb-0000-0000-0000-000000000001', '  ', null)$$, '%empty message%');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
select pg_temp.check((select count(*) = 2 from public.project_messages), 'the owner sees the conversation');
select pg_temp.check((select count(*) = 1 from public.audit_events where event_type = 'member.joined'), 'the owner sees who joined');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000b');   -- outsider
select pg_temp.check((select count(*) = 0 from public.project_messages), 'outsiders see no messages');
select pg_temp.expect_error($$select public.post_message('bbbbbbbb-0000-0000-0000-000000000001', 'hi', null)$$, '%not a member%');
select pg_temp.act_as(null);

\echo 'All workspace tests passed.'
