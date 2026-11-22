-- Reuse of unchanged work across plan versions. Fresh user Rex (owner).
--   v1: arch -> sch -> pcb, and docs (independent). All four finish with committed outputs.
--   v2: only docs changes        -> arch, sch, pcb reused; docs runs again.
--   v3: arch's requirement text changes -> arch and everything downstream run again; docs (unchanged since v2) reused.
--   redo_task on a reused task resets it and its reused descendants.
\set ON_ERROR_STOP on
\o /dev/null

insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000008a1', 'rex@reuse.test');

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

-- A plan version as the owner, submitted and approved.
create function pg_temp.plan(p_name text, p_docs text) returns uuid language plpgsql as $$
declare v uuid;
begin
  perform pg_temp.act_as('00000000-0000-0000-0000-0000000008a1');
  v := public.create_plan_version(pg_temp.id('project'), jsonb_build_object('summary', p_name, 'tasks', jsonb_build_array(
    jsonb_build_object('key', 'arch', 'title', 'Architecture', 'discipline', 'architecture', 'requirement_refs', jsonb_build_array('REQ-1')),
    jsonb_build_object('key', 'sch', 'title', 'Schematic', 'discipline', 'schematic', 'board', 'main', 'upstream_keys', jsonb_build_array('arch')),
    jsonb_build_object('key', 'pcb', 'title', 'Layout', 'discipline', 'pcb_layout', 'board', 'main', 'upstream_keys', jsonb_build_array('sch')),
    jsonb_build_object('key', 'docs', 'title', 'Docs', 'discipline', 'documentation', 'description', p_docs))));
  perform public.submit_plan(v);
  perform public.decide_plan(v, true);
  perform pg_temp.act_as(null);
  insert into ids values (p_name, v);
  return v;
end;
$$;
-- Finish a task as a worker would: a committed output and a check.
create function pg_temp.finish(p_plan uuid, p_key text) returns void language plpgsql as $$
declare v_task public.tasks; v_art uuid; v_ver uuid;
begin
  select * into v_task from public.tasks where plan_id = p_plan and key = p_key;
  insert into public.artifacts (project_id, kind, name) values (v_task.project_id, 'report', p_key || '/' || p_plan::text) returning id into v_art;
  insert into public.artifact_versions (artifact_id, project_id, version, status, storage_path, sha256, produced_by_task_id)
  values (v_art, v_task.project_id, 1, 'committed', 'x/' || p_key, repeat('a', 64), v_task.id) returning id into v_ver;
  insert into public.task_artifacts (task_id, artifact_version_id, role) values (v_task.id, v_ver, 'output');
  insert into public.validations (project_id, task_id, kind, result, evidence_category, summary)
  values (v_task.project_id, v_task.id, 'other', 'pass', 'cad_check', p_key || ' checked');
  update public.tasks set status = 'running' where id = v_task.id;
  update public.tasks set status = 'validating' where id = v_task.id;
  update public.tasks set status = 'complete' where id = v_task.id;
end;
$$;
create function pg_temp.state(p_plan uuid) returns text language sql as $$
  select string_agg(key || '=' || status || case when reused_from_task_id is not null then '(reused)' else '' end, ' ' order by position)
    from public.tasks where plan_id = p_plan $$;

select pg_temp.act_as('00000000-0000-0000-0000-0000000008a1');
insert into public.projects (name) values ('Reuse') returning id \gset
select pg_temp.act_as(null);
insert into ids values ('project', :'id');
insert into public.requirements (project_id, ref_code, kind, text, priority, status) values (pg_temp.id('project'), 'REQ-1', 'power', 'Run 8 hours.', 'must', 'confirmed');

-- v1 runs everything.
select pg_temp.plan('v1', 'Write the docs.');
select pg_temp.check(pg_temp.state(pg_temp.id('v1')) = 'arch=ready sch=ready pcb=ready docs=ready', pg_temp.state(pg_temp.id('v1')));
select pg_temp.check((select count(distinct fingerprint) = 4 from public.tasks where plan_id = pg_temp.id('v1')), 'fingerprints set at approval');
select pg_temp.finish(pg_temp.id('v1'), k) from unnest(array['arch', 'sch', 'pcb', 'docs']) k;

-- v2: only docs changed.
select pg_temp.plan('v2', 'Write the docs, with a service manual.');
select pg_temp.check(pg_temp.state(pg_temp.id('v2')) = 'arch=complete(reused) sch=complete(reused) pcb=complete(reused) docs=ready', pg_temp.state(pg_temp.id('v2')));
select pg_temp.check((select count(*) = 3 from public.task_artifacts ta join public.tasks t on t.id = ta.task_id where t.plan_id = pg_temp.id('v2')), 'outputs linked');
select pg_temp.check((select summary = 'Reused from v1 (sch, unchanged): sch checked' from public.validations v join public.tasks t on t.id = v.task_id
                       where t.plan_id = pg_temp.id('v2') and t.key = 'sch'), 'check copied and labelled');
select pg_temp.finish(pg_temp.id('v2'), 'docs');

-- v3: the architecture's requirement changed: arch and its descendants run again; docs is reused from v2.
update public.requirements set text = 'Run 10 hours.' where ref_code = 'REQ-1' and project_id = pg_temp.id('project');
select pg_temp.plan('v3', 'Write the docs, with a service manual.');
select pg_temp.check(pg_temp.state(pg_temp.id('v3')) = 'arch=ready sch=ready pcb=ready docs=complete(reused)', pg_temp.state(pg_temp.id('v3')));
select pg_temp.check((select v.summary like 'Reused from v2 (docs, unchanged)%' from public.validations v join public.tasks t on t.id = v.task_id
                       where t.plan_id = pg_temp.id('v3') and t.key = 'docs'), 'reused from the latest finished version');

-- v4 (same as v3 after arch..pcb finish in v3): all reused; redo a reused task resets it and its reused descendants.
select pg_temp.finish(pg_temp.id('v3'), k) from unnest(array['arch', 'sch', 'pcb']) k;
select pg_temp.plan('v4', 'Write the docs, with a service manual.');
select pg_temp.check(pg_temp.state(pg_temp.id('v4')) = 'arch=complete(reused) sch=complete(reused) pcb=complete(reused) docs=complete(reused)', pg_temp.state(pg_temp.id('v4')));
select pg_temp.act_as('00000000-0000-0000-0000-0000000008a1');
select pg_temp.check(public.redo_task((select id from public.tasks where plan_id = pg_temp.id('v4') and key = 'sch')) = 2, 'sch and pcb reset');
select pg_temp.expect_error($$select public.redo_task((select id from public.tasks where plan_id = pg_temp.id('v4') and key = 'sch'))$$, '%only reused tasks%');
select pg_temp.act_as(null);
select pg_temp.check(pg_temp.state(pg_temp.id('v4')) = 'arch=complete(reused) sch=ready pcb=ready docs=complete(reused)', pg_temp.state(pg_temp.id('v4')));
select pg_temp.check((select count(*) = 0 from public.task_artifacts ta join public.tasks t on t.id = ta.task_id where t.plan_id = pg_temp.id('v4') and t.key in ('sch', 'pcb')), 'links removed');

\o
select 'reuse ok';
