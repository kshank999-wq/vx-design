# VX Design

Spec-driven electronics and hardware engineering platform: specification → plan →
sourced parts → power budget → KiCad board → manufacturing files → enclosure, with every
decision traced to evidence.

The master specification is [docs/SPEC.md](docs/SPEC.md) (v1.1). It merges the v0.1 platform spec and the
v1.0 product spec, and marks what is built. The source documents are in [docs/specs/](docs/specs/), and
[docs/ASSESSMENT.md](docs/ASSESSMENT.md) holds the feasibility assessment.

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

## G2: worker backbone

Approved plans are executed by workers (`services/orchestrator`), separate long-running processes
that are never on Vercel. The web app only authorizes runs and shows their status. Once a run is
authorized, the browser can be closed.

- **Authorize a run** on the approved plan: supervision mode, AI and compute budgets (USD), allowed risk
  levels, retries per task, and optionally stop at the first failure. Pause, resume or cancel it from the
  run page.
- **Durable queue.** Workers claim ready tasks in plan order (`claim_next_task`, `SKIP LOCKED`). Each claim
  is a lease that the worker renews with heartbeats. If a worker stops heartbeating, any other worker
  reclaims its task (`reap_stale_executions`). A task that keeps crashing workers is blocked after three
  interruptions.
- **Checkpoints.** Each executor step's result is saved in the execution's checkpoint. A resumed attempt
  skips finished steps, so model calls are not repeated, and it does not count as a retry.
- **Fenced commits.** Every write names the execution, and the database accepts it only from the worker
  that still holds the lease. A worker that was frozen or partitioned cannot commit after another worker
  has taken over. A unique index also allows at most one committed version per artifact per task.
- **Locks.** A worker must hold the per-artifact write lock (`acquire_artifact_lock`) to register outputs.
- **Budgets.** Model tokens (priced in `services/orchestrator/src/pricing.ts`) and worker time are recorded
  in `cost_events`. Reaching a budget stops the run, and in-flight work yields at its next checkpoint.
- **Sign-off.** Outputs commit when checks pass, unless the plan's approval policy requires sign-off, a test
  needs human review, or a Guided run reaches a design task. Those outputs wait on the run page for
  approve or return-with-note.
- **Report.** When nothing more can run, the worker writes an in-app completion report. It covers outputs,
  checks, recoveries, open approvals, spend, and recommended next steps.

Executors so far:
- **Design briefs** cover architecture, components, power, thermal, mechanical, enclosure and documentation
  tasks. They are Claude-drafted and checked against the task's requirements and acceptance tests.
- **Simulation, sourcing, verification and fabrication tasks** are blocked with a plain reason until their
  executors land. Nothing is simulated. Schematic (G3) and PCB layout (G4) tasks wait for the KiCad
  engineering worker.

```bash
pnpm worker                        # SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY (or VX_LLM=offline)
pnpm test:worker                   # kills and freezes real worker processes against local Supabase
pnpm test:e2e:g2                   # browser: authorize, close, kill worker, resume, approve, continue, report
```

## G3: first circuit

Schematic tasks run on the **KiCad engineering worker** (`services/engineering/Dockerfile.worker`: KiCad 10 +
the orchestrator + `vx_eng`). Workers advertise the disciplines they can execute, so a worker without KiCad
never claims a schematic task. The run page says when no online worker can run a task. If nothing else can
progress, the run ends with a report saying what it is waiting for.

1. **Design.** Claude proposes a circuit: KiCad library symbols and footprints, nets written as `REF.PIN`, and
   for each part its MPN, manufacturer, datasheet URL and the ratings the design relies on.
2. **Check and repair** (up to 3 repair rounds). `vx_eng` checks the design against the installed KiCad
   libraries:
   - symbols and footprints exist, with close matches suggested when they don't;
   - every pin referenced exists, with the symbol's real pin list in the error;
   - every symbol pin has a pad on its footprint;
   - every pin is connected or explicitly marked unconnected.
   
   It then generates the native schematic and runs KiCad ERC. It also checks that KiCad's own netlist matches
   the design. Every problem goes back to Claude with those library facts.
3. **Component evidence.** Each datasheet is downloaded, and the part number and every claimed rating are
   looked for in its text, with excerpts kept. This is a text match, and the UI says so.
4. **Outputs** (all deterministic, so a resumed task re-uploads identical files):
   - an editable KiCad 10 project (zip);
   - schematic SVG and PDF;
   - the ERC report (JSON);
   - the netlist;
   - a BOM (CSV);
   - the component evidence;
   - the design (JSON).
   
   The web app shows the drawing, the ERC table and the evidence table.

```bash
./services/engineering/build.sh                                        # KiCad engineering image (G0)
docker build -f services/engineering/Dockerfile.worker -t vx-engineering-worker .
pnpm test:eng                       # vx_eng: library checks, deterministic build, ERC negative controls
pnpm test:g3                        # worker routing, schematic build, the stored project re-checked in a fresh KiCad
pnpm test:e2e:g3                    # browser: waits for a KiCad worker, drawing, ERC report, evidence, approve
```

## G4: first board

PCB layout tasks also run on the KiCad engineering worker. They take the **committed circuit design** of their
upstream schematic task, so the schematic must be approved first.

1. **Placement.** Claude proposes:
   - the outline, corner radius and mounting holes (M2, M2.5 or M3);
   - a fab design-rule profile (`jlcpcb-2layer-standard` or `oshpark-2layer`);
   - a ground pour net;
   - a position, rotation and side for every component.
   
   It is given each footprint's courtyard extents from the KiCad library.
2. **Check and repair** (up to 3 repair rounds). Each problem goes back to Claude with exact geometry:
   - `vx_eng` checks the placement with KiCad's own footprints: courtyards must be inside the outline and must
     not overlap on the same side. Through-hole parts and holes block both sides. Problems give the allowed
     position range or the overlap size.
   - It builds a native `.kicad_pcb` linked to the schematic: footprints carry the symbol UUIDs and fields, and
     pads carry KiCad's net names.
   - **Freerouting** routes it. Supply nets get the wider "Power" net class. A ground pour is added on both
     layers.
   - **KiCad DRC** runs with `--schematic-parity` and zone refill. Pads whose thermal spokes can't all reach
     the pour get a solid connection, and DRC runs again.
   - Unrouted connections, DRC errors and parity differences go back to Claude.
3. **3D.** The KiCad library model of each footprint comes from
   [kicad-packages3D](https://gitlab.com/kicad/libraries/kicad-packages3D) at the KiCad version's tag. Models
   are fetched once and cached (`VX_3DMODEL_CACHE`). These are generic package shapes, not manufacturer CAD,
   and the model report says so.
4. **Outputs** (12 per task):
   - the KiCad 10 project (schematic + routed board);
   - 3D renders (iso, top, bottom);
   - copper/silk drawings (SVG, PDF);
   - board STEP and GLB;
   - the DRC report;
   - the 3D model report;
   - the placement.
   
   Routing is not bit-for-bit reproducible, so the files that passed DRC are stashed in storage in the same
   checkpointed step. A resumed task registers those exact files instead of routing again.

The web app shows:
- the 3D render in the approval panel;
- an interactive 3D board (the GLB in `<model-viewer>`);
- the DRC table, split into rule violations, unrouted connections and differences from the schematic;
- the 3D model report and the placement.

Excluded DRC items count as waivers and are reported separately; generated boards have none.

Limits:
- Two-layer, low-speed boards only. Freerouting has no impedance control and no length matching.
- Placement quality depends on the model. The checks guarantee a clean, routed, schematic-matched board, not a
  good one, so review it in KiCad.
- Gerbers, drill, pick-and-place and panelization are G4.5.

```bash
docker build -f services/engineering/Dockerfile.worker -t vx-engineering-worker .   # now includes the PCB pipeline
pnpm test:eng                       # placement checks, routed fixture board: DRC + parity clean; unrouted and drifted negative controls
pnpm test:g4                        # schematic -> approve -> layout; worker killed after layout; fresh-KiCad DRC/parity/ERC of the stored project
pnpm test:e2e:g4                    # browser: approve schematic, continue, 3D board, DRC report, models, placement, approve
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
- Worker leases, checkpoint resume, fenced commits, locks, budgets and run controls are covered by
  `supabase/tests/worker_test.sql`.
