-- Raising a running run's budget, so a long run is not stopped (and restarted) only because its first estimate was low.
-- Owners and engineers may raise either limit, never lower it below what has been spent; a run that was stopped by
-- its budget (and nothing else) resumes. Audited.
create function public.raise_run_budget(p_run uuid, p_ai numeric, p_compute numeric) returns text
language plpgsql security definer set search_path = '' as $$
declare
  r public.runs;
  s record;
begin
  select * into r from public.runs where id = p_run for update;
  if r.id is null or not public.has_project_role(r.project_id, '{owner,engineer}') then raise exception 'run not found or not permitted'; end if;
  if p_ai is null or p_compute is null or p_ai < r.max_ai_spend_usd or p_compute < r.max_compute_spend_usd then
    raise exception 'a budget can only be raised (AI at least $%, compute at least $%)', r.max_ai_spend_usd, r.max_compute_spend_usd;
  end if;
  if p_ai > 5000 or p_compute > 5000 then raise exception 'budgets above $5,000 need a new run'; end if;
  s := public.run_spend(r.id);
  update public.runs set max_ai_spend_usd = p_ai, max_compute_spend_usd = p_compute,
         status = case when r.status = 'stopped' and r.stop_reason like '%budget reached%' and s.ai_usd < p_ai and s.compute_usd < p_compute then 'running' else r.status end,
         stop_reason = case when r.status = 'stopped' and r.stop_reason like '%budget reached%' and s.ai_usd < p_ai and s.compute_usd < p_compute then null else r.stop_reason end,
         finished_at = case when r.status = 'stopped' and r.stop_reason like '%budget reached%' and s.ai_usd < p_ai and s.compute_usd < p_compute then null else r.finished_at end
   where id = r.id returning * into r;
  insert into public.audit_events (project_id, actor_id, actor_type, event_type, entity_type, entity_id, payload)
  values (r.project_id, auth.uid(), 'user', 'run.budget_raised', 'run', r.id, jsonb_build_object('ai_usd', p_ai, 'compute_usd', p_compute, 'status', r.status));
  return r.status::text;
end;
$$;
revoke all on function public.raise_run_budget(uuid, numeric, numeric) from public, anon;
grant execute on function public.raise_run_budget(uuid, numeric, numeric) to authenticated;
