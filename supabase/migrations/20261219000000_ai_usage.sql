-- AI usage: every model call recorded with what it was for, its tokens, price and time.
--
-- cost_events gains the detail of an AI call (purpose, input/output/cache tokens, duration, who asked, whether the call
-- failed after the model ran: such calls are billed too). record_ai_call records one: a member records calls made for
-- their project (the web app, under their session); workers record calls made outside a run with the service role,
-- and calls inside a run go through record_cost so the run's budget is still enforced.
alter table public.cost_events
  add column purpose            text,
  add column input_tokens       bigint,
  add column output_tokens      bigint,
  add column cache_read_tokens  bigint,
  add column cache_write_tokens bigint,
  add column duration_ms        integer,
  add column user_id            uuid references auth.users (id) on delete set null,
  add column failed             boolean not null default false;

create index if not exists cost_events_project_purpose_idx on public.cost_events (project_id, purpose) where kind = 'ai_tokens';

create function public.record_ai_call(p_project uuid, p_execution uuid, p_purpose text, p_model text,
                                      p_input bigint, p_output bigint, p_cache_read bigint, p_cache_write bigint,
                                      p_cost_usd numeric, p_duration_ms integer, p_failed boolean default false)
returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_result text := 'ok';
  v_id uuid;
  v_tokens numeric := coalesce(p_input, 0) + coalesce(p_output, 0) + coalesce(p_cache_read, 0) + coalesce(p_cache_write, 0);
begin
  if p_execution is not null then
    -- Inside a run: the worker (service role) charges the run, which enforces its AI budget.
    if auth.uid() is not null then raise exception 'only workers record run costs'; end if;
    v_result := public.record_cost(p_execution, 'ai_tokens', 'anthropic', p_model, v_tokens, 'tokens', p_cost_usd);
    select id into v_id from public.cost_events where execution_id = p_execution order by created_at desc, id desc limit 1;
  else
    if auth.uid() is not null and not public.is_project_member(p_project) then raise exception 'not a member of this project'; end if;
    insert into public.cost_events (project_id, kind, provider, resource, quantity, unit, cost_usd, user_id)
    values (p_project, 'ai_tokens', 'anthropic', p_model, v_tokens, 'tokens', greatest(coalesce(p_cost_usd, 0), 0), auth.uid())
    returning id into v_id;
  end if;
  update public.cost_events set purpose = left(p_purpose, 80), input_tokens = p_input, output_tokens = p_output,
         cache_read_tokens = p_cache_read, cache_write_tokens = p_cache_write, duration_ms = p_duration_ms, failed = coalesce(p_failed, false)
   where id = v_id;
  return v_result;
end;
$$;
revoke all on function public.record_ai_call(uuid, uuid, text, text, bigint, bigint, bigint, bigint, numeric, integer, boolean) from public, anon;
grant execute on function public.record_ai_call(uuid, uuid, text, text, bigint, bigint, bigint, bigint, numeric, integer, boolean) to authenticated, service_role;

-- Calls recorded before this (worker plan builds) carried their tokens but no price: price them from the plans' own
-- usage records, at the November 2026 Opus 5.5 rates they ran at, so the history is complete.
insert into public.cost_events (project_id, kind, provider, resource, quantity, unit, cost_usd, purpose, input_tokens, output_tokens,
                                cache_read_tokens, cache_write_tokens, duration_ms, created_at)
select p.project_id, 'ai_tokens', 'anthropic', u->>'model',
       (u->>'inputTokens')::bigint + (u->>'outputTokens')::bigint + coalesce((u->>'cacheReadTokens')::bigint, 0) + coalesce((u->>'cacheWriteTokens')::bigint, 0), 'tokens',
       ((u->>'inputTokens')::numeric * 4 + (u->>'outputTokens')::numeric * 20 + coalesce((u->>'cacheReadTokens')::numeric, 0) * 0.2
        + coalesce((u->>'cacheWriteTokens')::numeric, 0) * 5) / 1e6,
       case when n = 1 then case when p.generator->>'prompt_version' like 'plan-revise%' then 'revise_plan' else 'generate_plan' end
            else case when p.generator->>'prompt_version' like 'plan-revise%' then 'repair_revise_plan' else 'repair_plan' end end,
       (u->>'inputTokens')::bigint, (u->>'outputTokens')::bigint, coalesce((u->>'cacheReadTokens')::bigint, 0), coalesce((u->>'cacheWriteTokens')::bigint, 0),
       case when r.claimed_at is not null and r.completed_at is not null
            then (extract(epoch from (r.completed_at - r.claimed_at)) * 1000 / jsonb_array_length(p.generator->'usage'))::integer end,
       p.created_at
  from public.plans p
  join public.plan_requests r on r.plan_id = p.id
  cross join lateral jsonb_array_elements(p.generator->'usage') with ordinality as x(u, n)
 where jsonb_typeof(p.generator->'usage') = 'array' and (u->>'model') like 'claude-%';
-- The unpriced token-count rows those builds left are replaced by the priced ones above.
delete from public.cost_events c
 where c.kind = 'ai_tokens' and c.cost_usd = 0 and c.purpose is null and c.execution_id is null and c.resource like 'claude-%'
   and exists (select 1 from public.plan_requests r where r.project_id = c.project_id and r.plan_id is not null
                 and c.created_at between r.claimed_at and r.completed_at + interval '10 seconds');
