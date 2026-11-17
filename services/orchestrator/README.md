# Orchestrator

Long-running worker service (not on Vercel). Responsibilities (spec §3, §5–§7):

- Claim ready tasks with `public.claim_next_task(worker_id, run_id)` — Postgres `SKIP LOCKED`, so
  multiple workers never take the same task, and a task is only claimable once its upstream tasks are `complete`.
- Heartbeat `executions.heartbeat_at`; requeue tasks whose worker stopped heartbeating.
- Enforce run budgets (`runs.max_ai_spend_usd`, `max_compute_spend_usd`) from `cost_events`.
- Take per-artifact write locks (`artifacts.locked_by_execution_id`) before mutating a design file.
- Promote scratch artifact versions to `committed` only after validations pass.
- Write the in-app completion report when a run ends.

Connects with the Supabase service-role key (bypasses RLS). Built in G2.
