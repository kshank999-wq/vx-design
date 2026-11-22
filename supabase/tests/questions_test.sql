-- Questions for the owner: members read them, owners/clients answer (an option, their own words, the recommendation,
-- or dismissed), viewers and outsiders cannot. Fresh users Quinn (owner), Vic (viewer), Oz (outsider).
\set ON_ERROR_STOP on
\o /dev/null
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000009a1', 'quinn@q.test'),
  ('00000000-0000-0000-0000-0000000009a2', 'vic@q.test'),
  ('00000000-0000-0000-0000-0000000009a3', 'oz@q.test');
create function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), false);
  if p_user is null then execute 'reset role'; else execute 'set role authenticated'; end if;
end;
$$;
create function pg_temp.check(p_ok boolean, p_msg text) returns void language plpgsql as $$
begin if not coalesce(p_ok, false) then raise exception 'check failed: %', p_msg; end if; end;
$$;
create function pg_temp.expect_error(p_sql text, p_like text) returns void language plpgsql as $$
declare v_err text;
begin
  begin execute p_sql; exception when others then v_err := sqlerrm; end;
  if v_err is null then raise exception 'statement should have failed but succeeded: %', p_sql;
  elsif v_err not like p_like then raise exception 'expected error like "%", got "%"', p_like, v_err; end if;
end;
$$;
create temp table ids (name text primary key, id uuid);
grant all on ids to authenticated;
create function pg_temp.id(p_name text) returns uuid language sql as $$ select id from ids where name = p_name $$;

select pg_temp.act_as('00000000-0000-0000-0000-0000000009a1');
insert into public.projects (name) values ('Questions') returning id \gset
select pg_temp.act_as(null);
insert into ids values ('project', :'id');
insert into public.project_members (project_id, user_id, role) values (pg_temp.id('project'), '00000000-0000-0000-0000-0000000009a2', 'viewer');
insert into public.project_questions (project_id, question, why, recommendation, options) values
  (pg_temp.id('project'), 'Which markets first?', 'Sets the radio certifications.', 'US only', '{US only,US and EU}'),
  (pg_temp.id('project'), 'What colour?', 'Sets the plastic.', 'Black', '{}'),
  (pg_temp.id('project'), 'Battery door?', null, 'No door', '{}');
insert into ids select case question when 'What colour?' then 'q1' when 'Which markets first?' then 'q2' else 'q3' end, id
  from public.project_questions where project_id = pg_temp.id('project');

-- Members read; outsiders see nothing; nobody writes directly.
select pg_temp.act_as('00000000-0000-0000-0000-0000000009a2');
select pg_temp.check((select count(*) = 3 from public.project_questions), 'viewer reads');
select pg_temp.expect_error($$select public.answer_question(pg_temp.id('q1'), 'White')$$, '%not permitted%');
update public.project_questions set answer = 'x';
select pg_temp.check((select count(*) = 0 from public.project_questions where answer = 'x'), 'no direct writes');
select pg_temp.act_as('00000000-0000-0000-0000-0000000009a3');
select pg_temp.check((select count(*) = 0 from public.project_questions), 'outsider sees nothing');
select pg_temp.expect_error($$select public.answer_question(pg_temp.id('q1'), 'White')$$, '%not permitted%');

-- The owner answers in their own words, takes a recommendation, and dismisses one.
select pg_temp.act_as('00000000-0000-0000-0000-0000000009a1');
select public.answer_question(pg_temp.id('q1'), 'White');
select public.answer_question(pg_temp.id('q2'), null);
select public.answer_question(pg_temp.id('q3'), null, true);
select pg_temp.act_as(null);
select pg_temp.check((select answer = 'White' and status = 'answered' and answered_by = '00000000-0000-0000-0000-0000000009a1' from public.project_questions where id = pg_temp.id('q1')), 'own words');
select pg_temp.check((select answer = 'US only' from public.project_questions where id = pg_temp.id('q2')), 'recommendation taken');
select pg_temp.check((select status = 'dismissed' and answer is null from public.project_questions where id = pg_temp.id('q3')), 'dismissed');
select pg_temp.check((select count(*) = 3 from public.audit_events where project_id = pg_temp.id('project') and event_type like 'question.%'), 'audited');
\o
select 'questions ok';
