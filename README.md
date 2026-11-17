# VX Design

Spec-driven electronics and hardware engineering platform: specification → plan →
sourced parts → power budget → KiCad board → manufacturing files → enclosure, with every
decision traced to evidence.

See [docs/ASSESSMENT.md](docs/ASSESSMENT.md) for the feasibility assessment and phase plan.

## Layout

| Path | Purpose |
|---|---|
| `apps/web/` | Next.js interface and Vercel endpoints |
| `services/orchestrator/` | Worker lifecycle, planning, approvals, queue |
| `services/engineering/` | KiCad / CAD / simulation adapter workers |
| `packages/contracts/` | Typed task, artifact, evidence and decision schemas |
| `packages/integrations/` | Provider connectors and capability registry |
| `packages/planning/` | Spec ingestion (DOCX/PDF/Markdown), cited requirement extraction, plan generation and validation |
| `supabase/migrations/` | Postgres schema, RLS and policies |
| `supabase/seed.sql` | G0 capability matrix starting rows |
| `tests/fixtures/` | Small circuits, STEP models and golden outputs |
| `docs/` | Assessment, architecture decision records, runbooks |

## Getting started

Requires Node 22+ and pnpm.

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm test:db   # applies migrations to a throwaway local Postgres and runs schema tests
pnpm dev       # web app on http://localhost:3000
```

G0 capability audit (needs Docker): `./scripts/g0-run.sh` builds the engineering worker image,
runs every tool spike and writes [docs/g0/capability-matrix.md](docs/g0/capability-matrix.md).

To connect a Supabase project, copy `.env.example` to `apps/web/.env.local` and fill in the
project URL and anon key, then apply `supabase/migrations/` (Supabase CLI: `supabase db push`).

## G1: specification to approved plan

1. **Upload** a DOCX, PDF, Markdown or text spec. It is parsed into sections and blocks with stable ids (`S2.1.p3`).
2. **Extract requirements.** Claude returns each requirement with a block id and a verbatim excerpt. Every
   excerpt is checked against the document; unverifiable ones get one correction round, then are dropped
   and reported. Codes (`REQ-PWR-002`) are assigned deterministically in document order.
3. **Review**: confirm or reject requirements; ambiguities and open questions are listed.
4. **Generate a plan.** Claude proposes a task graph; deterministic checks require valid keys, known
   dependencies, no cycles, an acceptance test per task, and every requirement covered or explicitly
   deferred (up to 2 repair rounds). High/critical-risk tasks always get an approval gate.
5. **Edit** tasks while the plan is a draft, **submit**, then an owner/reviewer **approves** (or returns it
   with a note). Approval freezes the baseline, supersedes the previous one and makes tasks runnable.
   Changes after that go through **Revise**, which creates a new draft version.

The database enforces the workflow (status changes only through `submit_plan` / `decide_plan` /
`revise_plan`; frozen task definitions; dependency order), covered by `supabase/tests/planning_test.sql`.

Run locally (needs Docker):

```bash
npx supabase start                 # local Postgres/Auth/Storage, applies migrations + seed
cp .env.example apps/web/.env.local   # fill in the local URL/anon key printed above
pnpm --filter @vx/web build && pnpm --filter @vx/web start
pnpm test:e2e                      # browser flow; run the app with VX_LLM=offline to avoid model calls
```

## Database overview

`projects`, `project_members`, `documents`, `requirements`, `plans`, `tasks`,
`task_dependencies`, `decisions`, `approvals`, `runs`, `executions`, `artifacts`,
`artifact_versions`, `task_artifacts`, `validations`, `tool_capabilities`, `cost_events`,
`audit_events`, plus a private `project-files` storage bucket.

Built-in guarantees, each covered by `supabase/tests/schema_test.sql`:

- Project data is visible only to project members (row level security).
- Task status follows the spec §6 state machine; every change is written to `audit_events`.
- Task dependencies stay within one plan and cannot form cycles.
- Decisions are immutable; changes are recorded as new decisions that supersede old ones.
- Committed artifact versions are frozen.
- `claim_next_task()` hands out only tasks whose upstream work is complete, never twice.
