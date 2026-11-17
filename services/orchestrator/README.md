# Orchestrator (worker)

This is a long-running worker service that executes authorized runs. It is not for Vercel: the web app
only authorizes runs and displays their status, so runs continue with the browser closed (spec §3).

```bash
SUPABASE_URL=https://<project>.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=<service role key> \
ANTHROPIC_API_KEY=<key> \
node services/orchestrator/src/main.ts
```

Run as many workers as you like; the database arbitrates between them. `SIGTERM` makes a worker finish
its current step and hand its tasks back to the queue at their latest checkpoint.

| Variable | Default | Meaning |
| --- | --- | --- |
| `WORKER_ID` | hostname-pid | Name shown in logs and on the run page |
| `WORKER_CONCURRENCY` | 2 | Executions at once |
| `WORKER_LEASE_SECONDS` | 60 | Lease length; heartbeats every third of it |
| `WORKER_POLL_MS` | 3000 | Idle poll interval |
| `VX_LLM` | — | `offline` uses the labelled non-AI stand-in |
| `VX_PLANNING_MODEL` | claude-opus-5-5 | Claude model id |
| `VX_COMPUTE_USD_PER_HOUR` | 0.10 | Worker time charged against compute budgets |
| `VX_STEP_DELAY_MS` | 0 | Test hook: pause after each step |
| `VX_ENGINEERING` | auto | `off` disables KiCad executors even when `vx_eng` and KiCad are present |
| `VX_ENG_DIR` | /opt/vx | Directory containing the `vx_eng` package |
| `VX_UNCOVERED_GRACE_MS` | 30000 | How long to wait for a capable worker before ending a run |

## How an execution works

1. `claim_next_task` leases the next ready task of a running run, in plan order. If the task's latest
   attempt was interrupted, the claim resumes it with the saved checkpoint.
2. The executor runs in steps (`ctx.step(name, fn)`). Before each step the worker confirms its lease.
   After each step the result is saved in the checkpoint. A resumed attempt returns saved results
   instead of re-running them.
3. Outputs are uploaded content-addressed. They are registered as scratch versions under a per-artifact
   write lock.
4. `begin_validation` and then `complete_execution` record the checks. The function either commits the
   outputs or holds them for sign-off. A failure goes to `fail_execution` with one of three outcomes:
   retry, fail or block.
5. Each of these calls is fenced: it succeeds only for the worker that still holds the execution.

Each run's report is written by `finish_run` once nothing more can run.

## Executors (`src/executors/`)

| Executor | Disciplines | Evidence |
| --- | --- | --- |
| `design-brief` | architecture, components, power, thermal, mechanical, enclosure, documentation | unverified AI reasoning, checked for requirement and acceptance-test coverage |
| `kicad-schematic` | schematic (engineering worker only) | KiCad ERC, netlist match, library and pad checks (CAD check); datasheet text match per component |
| `not-yet-available` | pcb_layout, simulation, verification, manufacturing, sourcing | blocks the task with the reason and the gate that adds it |

A worker claims only the disciplines its executors declare, and it records them in `workers` (`worker_checkin`).
When the only remaining work needs a discipline that no online worker offers (for example schematic with no
KiCad worker running), the run ends after `VX_UNCOVERED_GRACE_MS` (default 30 s). Its report says what it is
waiting for.

## Tests

- `pnpm test:worker` runs against local Supabase. It kills a worker mid-task, freezes one past its lease,
  and exercises pause, resume and cancel. It asserts exactly one model call and one committed version
  per task.
- SQL-level guarantees are covered in `supabase/tests/worker_test.sql`.
