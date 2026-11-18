-- Per-account quotas and fair queueing. Fresh users, so counts from earlier tests do not matter:
--   Quinn: a tiny test plan (2 projects, 1 active run, 1 task slot, $1 AI a month, 1 concept round a month)
--   Rae:   the standard plan (4 task slots)
--   Sam:   the unlimited plan (queue weight 2)
\set ON_ERROR_STOP on
\o /dev/null

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'quinn@quota.test'),
  ('00000000-0000-0000-0000-0000000000a2', 'rae@quota.test'),
  ('00000000-0000-0000-0000-0000000000a3', 'sam@quota.test');

create function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), false);
  if p_user is null then execute 'reset role'; else execute 'set role authenticated'; end if;
end;
$$;
create function pg_temp.as_worker() returns void language plpgsql as $$
begin perform set_config('request.jwt.claim.sub', '', false); execute 'set role service_role'; end;
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

-- A project owned by p_user with an approved plan of p_tasks independent tasks (as that user).
create function pg_temp.project(p_user uuid, p_name text, p_tasks integer) returns uuid language plpgsql as $$
declare v_project uuid := gen_random_uuid(); v_plan uuid;
begin
  perform pg_temp.act_as(p_user);
  insert into public.projects (id, name) values (v_project, p_name);
  v_plan := public.create_plan_version(v_project, jsonb_build_object('summary', p_name, 'tasks',
    (select jsonb_agg(jsonb_build_object('key', 't' || i, 'title', 'Task ' || i, 'discipline', 'documentation'))
       from generate_series(1, p_tasks) i)));
  perform public.submit_plan(v_plan);
  perform public.decide_plan(v_plan, true);
  perform pg_temp.act_as(null);
  insert into ids values (p_name, v_project), (p_name || '/plan', v_plan);
  return v_project;
end;
$$;
create function pg_temp.start_run(p_user uuid, p_name text) returns uuid language plpgsql as $$
declare v_run uuid;
begin
  perform pg_temp.act_as(p_user);
  v_run := public.authorize_run(pg_temp.id(p_name || '/plan'), 'autonomous', 50, 50);
  perform pg_temp.act_as(null);
  insert into ids values (p_name || '/run', v_run);
  return v_run;
end;
$$;

insert into public.account_plans (id, name, max_projects, max_active_runs, max_concurrent_tasks, monthly_ai_usd,
                                  monthly_compute_usd, monthly_concept_rounds)
values ('tiny', 'Tiny', 2, 1, 1, 1, 1, 1);
select public.set_account_plan('00000000-0000-0000-0000-0000000000a1', 'tiny', 'quota test');
select public.set_account_plan('00000000-0000-0000-0000-0000000000a3', 'unlimited');

-- 1. Plans: the standard plan without an account row; users see only their own account.
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a2');
select pg_temp.check((public.my_account() -> 'plan' ->> 'id') = 'standard', 'no account row means the standard plan');
select pg_temp.check((public.my_account() -> 'usage' ->> 'projects')::int = 0, 'usage starts at zero');
select pg_temp.check((select count(*) from public.accounts) = 0, 'Rae cannot see other accounts');
select pg_temp.check((select count(*) from public.account_plans) >= 3, 'plans are readable');
select pg_temp.expect_error($$select public.set_account_plan('00000000-0000-0000-0000-0000000000a2', 'unlimited')$$, 'permission denied%');
select pg_temp.expect_error($$select * from public.account_counts('00000000-0000-0000-0000-0000000000a1')$$, 'permission denied%');
select pg_temp.expect_error($$select public.claim_next_fair('rae-laptop')$$, 'permission denied%');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select pg_temp.check((public.my_account() -> 'plan' ->> 'id') = 'tiny', 'Quinn is on the tiny plan');
select pg_temp.act_as(null);

-- 2. Projects: at most two for Quinn.
select pg_temp.project('00000000-0000-0000-0000-0000000000a1', 'quinn-a', 3);
select pg_temp.project('00000000-0000-0000-0000-0000000000a1', 'quinn-b', 3);
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select pg_temp.expect_error($$insert into public.projects (name) values ('quinn-c')$$, 'Plan limit: the Tiny plan allows 2 projects per account%');
select pg_temp.act_as(null);

-- 3. Active runs: one at a time for Quinn's account, also when an engineer of Quinn's project starts it.
select pg_temp.start_run('00000000-0000-0000-0000-0000000000a1', 'quinn-a');
insert into public.project_members (project_id, user_id, role) values (pg_temp.id('quinn-b'), '00000000-0000-0000-0000-0000000000a2', 'engineer');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a2');
select pg_temp.expect_error(format($$select public.authorize_run(%L, 'autonomous', 5, 5)$$, pg_temp.id('quinn-b/plan')),
  'Plan limit: the Tiny plan allows 1 active runs at once per account%');
select pg_temp.act_as(null);

-- 4. Fair queueing: Rae has two runs, Sam one, Quinn one. Twelve claims in a row.
select pg_temp.project('00000000-0000-0000-0000-0000000000a2', 'rae-a', 4);
select pg_temp.project('00000000-0000-0000-0000-0000000000a2', 'rae-b', 4);
select pg_temp.project('00000000-0000-0000-0000-0000000000a3', 'sam-a', 10);
select pg_temp.start_run('00000000-0000-0000-0000-0000000000a2', 'rae-a');
select pg_temp.start_run('00000000-0000-0000-0000-0000000000a2', 'rae-b');
select pg_temp.start_run('00000000-0000-0000-0000-0000000000a3', 'sam-a');
create temp table claims (n serial, exec_id uuid, run_id uuid, account text);
grant all on claims, claims_n_seq to service_role;
create function pg_temp.claim() returns void language plpgsql as $$
declare e public.executions;
begin
  perform pg_temp.as_worker();
  e := public.claim_next_fair('fair-worker', 60, null);
  perform pg_temp.act_as(null);
  insert into claims (exec_id, run_id, account)
  select e.id, e.run_id, case p.created_by when '00000000-0000-0000-0000-0000000000a1' then 'quinn'
                                           when '00000000-0000-0000-0000-0000000000a2' then 'rae' else 'sam' end
    from public.projects p where p.id = e.project_id;
end;
$$;
-- Each claim is its own statement (its own transaction), as with real workers.
select pg_temp.claim(); select pg_temp.claim(); select pg_temp.claim(); select pg_temp.claim();
select pg_temp.claim(); select pg_temp.claim(); select pg_temp.claim(); select pg_temp.claim();
select pg_temp.claim(); select pg_temp.claim(); select pg_temp.claim(); select pg_temp.claim();
select pg_temp.check((select count(distinct account) from claims where n <= 3) = 3, 'the first three claims go to three different accounts');
select pg_temp.check((select count(*) from claims where account = 'quinn') = 1, 'Quinn never has more than his one task slot');
select pg_temp.check((select count(*) from claims where account = 'rae') = 4, 'Rae gets her four slots and no more');
select pg_temp.check((select count(*) from claims where account = 'sam') = 7, 'Sam (queue weight 2) gets the rest');
select pg_temp.check((select count(*) from claims where run_id = pg_temp.id('rae-a/run'))
                   = (select count(*) from claims where run_id = pg_temp.id('rae-b/run')), 'Rae''s two runs share her slots evenly');

-- A finished task frees the slot: Quinn's next task is claimable again.
select pg_temp.as_worker();
update public.executions set status = 'succeeded', finished_at = now() where id = (select exec_id from claims where account = 'quinn');
update public.tasks set status = 'validating' where id = (select task_id from public.executions where id = (select exec_id from claims where account = 'quinn'));
update public.tasks set status = 'complete' where id = (select task_id from public.executions where id = (select exec_id from claims where account = 'quinn'));
select pg_temp.act_as(null);
select pg_temp.claim();
select pg_temp.check((select account from claims order by n desc limit 1) = 'quinn', 'a freed slot is used for Quinn''s next task');

-- 5. Spend: Quinn's $1 monthly AI allowance. Passing it stops his running run and blocks new runs.
select pg_temp.as_worker();
select public.record_cost((select exec_id from claims where account = 'quinn' order by n desc limit 1), 'ai_tokens', 'anthropic',
                          'claude-opus-5-5', 1000, 'tokens', 1.25);
select pg_temp.act_as(null);
select pg_temp.check((select status = 'stopped' and stop_reason like 'Plan limit: this account has used its monthly AI allowance ($1.25 of $1.00 on the Tiny plan)%'
                        from public.runs where id = pg_temp.id('quinn-a/run')), 'Quinn''s run was stopped at his allowance');
select pg_temp.check(exists (select 1 from public.audit_events where entity_id = pg_temp.id('quinn-a/run') and event_type = 'run.quota_stop'), 'the stop is audited');
select pg_temp.check((select status from public.runs where id = pg_temp.id('rae-a/run')) = 'running', 'other accounts keep running');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select pg_temp.expect_error(format($$select public.authorize_run(%L, 'autonomous', 5, 5)$$, pg_temp.id('quinn-b/plan')),
  'Plan limit: this account has used its monthly AI allowance%');
select pg_temp.check((public.my_account() -> 'usage' ->> 'ai_usd')::numeric = 1.25, 'Quinn sees this month''s AI spend');
select pg_temp.act_as(null);

-- 6. Concept rounds: one a month for Quinn.
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select public.request_concepts(pg_temp.id('quinn-b'), 'brushed aluminium, rounded edges', 2);
select pg_temp.expect_error(format($$select public.request_concepts(%L, 'matte black', 2)$$, pg_temp.id('quinn-a')),
  'Plan limit: the Tiny plan allows 1 concept rounds a month per account%');
select pg_temp.act_as(null);

-- 7. Moving Quinn to the unlimited plan lifts every limit at once.
select public.set_account_plan('00000000-0000-0000-0000-0000000000a1', 'unlimited');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
insert into public.projects (name) values ('quinn-c');
select public.request_concepts(pg_temp.id('quinn-a'), 'matte black', 2);
select pg_temp.act_as(null);

\o
select 'All quota and fair queueing tests passed.' as result;
