-- Optimization proposals (§14): who may ask and decide, worker lease, carried-over decisions, change control.
-- Runs after flux_test.sql (users: a owner, c engineer, d reviewer, e viewer, f client of project bbbb...1).
\set ON_ERROR_STOP on
\o /dev/null

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
create function pg_temp.result() returns jsonb language sql as $$ select '{
  "proposals": [
    {"rank": 1, "fingerprint": "aaaa000000000001", "objective": "cost", "title": "Use TR-10K-C for R1, R2", "subject": "R1, R2",
     "change": {"kind": "swap_part", "from": "TR-10K-L", "to": "TR-10K-C"}, "targets": [], "impact": [{"metric": "BOM cost per board", "before": 1.2, "after": 1.1}],
     "basis": {"method": "offers", "inputs": [], "assumptions": []}, "confidence": "high", "effort": "S",
     "constraints": [{"id": "specs", "status": "met", "detail": "ok"}], "score": 8.3},
    {"rank": 2, "fingerprint": "aaaa000000000002", "objective": "power", "title": "Replace LDO U2 with a buck regulator", "subject": "U2",
     "change": {"kind": "replace_converter", "from": "ldo", "to": "buck"}, "targets": ["REQ-PWR-001"], "impact": [],
     "basis": {"method": "power calculator", "inputs": [], "assumptions": ["efficiency 88%"]}, "confidence": "medium", "effort": "M",
     "constraints": [{"id": "noise", "status": "needs_review", "detail": "TCXO on the rail"}], "score": 12.1}
  ],
  "excluded": [{"title": "Use X for C1", "reason": "specs: package 0402 not stated"}],
  "summary": {"proposals": 2}}'::jsonb $$;

-- 1. Who may ask.
select pg_temp.act_as('00000000-0000-0000-0000-00000000000f');   -- client
select pg_temp.expect_error($$select public.request_optimization('bbbbbbbb-0000-0000-0000-000000000001')$$, '%only owners and engineers%');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000c');   -- engineer
insert into ids select 'r1', public.request_optimization('bbbbbbbb-0000-0000-0000-000000000001', '{"focusBoards": 100}');
select pg_temp.expect_error($$select public.request_optimization('bbbbbbbb-0000-0000-0000-000000000001')$$, '%already running%');

-- 2. Worker: a proposal breaking a hard constraint can never be stored; a normal result is.
select pg_temp.as_worker();
select pg_temp.check((select (public.claim_optimization('w1')).id = pg_temp.id('r1')), 'claimed');
select pg_temp.expect_error($$select public.complete_optimization(pg_temp.id('r1'), 'w1', '{}',
  jsonb_set(pg_temp.result(), '{proposals,0,constraints}', '[{"id": "specs", "status": "violated", "detail": "x"}]'))$$, '%violates a hard constraint%');
select pg_temp.expect_error($$select public.complete_optimization(pg_temp.id('r1'), 'w2', '{}', pg_temp.result())$$, '%not being run by w2%');
select public.complete_optimization(pg_temp.id('r1'), 'w1', '{"bom_version": "v1"}', pg_temp.result());
select pg_temp.check((select status = 'ready' and jsonb_array_length(excluded) = 1 from public.optimization_runs where id = pg_temp.id('r1')), 'ready');
insert into ids select 'cost', id from public.proposals where fingerprint = 'aaaa000000000001';
insert into ids select 'power', id from public.proposals where fingerprint = 'aaaa000000000002';

-- 3. Visibility: staff yes, clients no.
select pg_temp.act_as('00000000-0000-0000-0000-00000000000e');   -- viewer
select pg_temp.check((select count(*) = 2 from public.proposals where run_id = pg_temp.id('r1')), 'staff read proposals');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000f');
select pg_temp.check((select count(*) = 0 from public.proposals), 'clients do not see proposals');

-- 4. Approval control.
select pg_temp.act_as('00000000-0000-0000-0000-00000000000c');   -- engineer cannot decide
select pg_temp.expect_error($$select public.decide_proposal(pg_temp.id('cost'), true)$$, '%only owners and reviewers%');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000d');   -- reviewer
select pg_temp.expect_error($$select public.decide_proposal(pg_temp.id('power'), true, 'go')$$, '%constraints marked for review%');
insert into ids select 'd1', public.decide_proposal(pg_temp.id('power'), true, 'TCXO gets its own post-LDO', true);
select pg_temp.check((select d.decision_class = 'power_architecture' and d.evidence_category = 'unverified_assumption'
                      and d.statement like 'ldo → buck (U2)%' and (d.evidence_refs -> 0 ->> 'constraints_reviewed')::boolean
                      from public.decisions d where d.id = pg_temp.id('d1')), 'accepted proposal recorded as a decision');
select pg_temp.expect_error($$select public.decide_proposal(pg_temp.id('cost'), false, ' ')$$, '%say why%');
select public.decide_proposal(pg_temp.id('cost'), false, 'Customer approved TR-10K-L only');
select pg_temp.expect_error($$select public.decide_proposal(pg_temp.id('cost'), true)$$, '%this proposal is rejected%');

-- 5. A new analysis carries earlier decisions over by fingerprint; earlier open proposals are superseded.
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
insert into ids select 'r2', public.request_optimization('bbbbbbbb-0000-0000-0000-000000000001');
select pg_temp.as_worker();
select (public.claim_optimization('w1')).id;
select public.complete_optimization(pg_temp.id('r2'), 'w1', '{}', jsonb_set(pg_temp.result(), '{proposals}',
  pg_temp.result() -> 'proposals' || '[{"rank": 3, "fingerprint": "bbbb000000000003", "objective": "supply", "title": "Second source for C1", "subject": "C1",
    "change": {"kind": "second_source", "from": "A", "to": "B"}, "confidence": "high", "effort": "S", "score": 7}]'::jsonb));
select pg_temp.check((select array_agg(status::text || ':' || fingerprint order by fingerprint) = array['rejected:aaaa000000000001', 'accepted:aaaa000000000002', 'open:bbbb000000000003']
                      from public.proposals where run_id = pg_temp.id('r2')), 'decisions carried over; only the new idea is open');
select pg_temp.check((select decision_note like 'carried over from analysis 1:%Customer approved%' from public.proposals
                      where run_id = pg_temp.id('r2') and fingerprint = 'aaaa000000000001'), 'carried note');
reset role;
select pg_temp.check((select array_agg(event_type order by id) @> array['optimization.requested', 'optimization.completed', 'proposal.accepted', 'proposal.rejected']
                      from public.audit_events where project_id = 'bbbbbbbb-0000-0000-0000-000000000001'), 'audited');

\echo 'All optimization tests passed.'
