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
- **Design briefs** cover architecture, components, thermal, mechanical and documentation tasks (power tasks
  use the power calculator; enclosure tasks the enclosure generator; both below). They are Claude-drafted and checked against the task's requirements and acceptance tests.
- **Simulation, sourcing and verification tasks** are blocked with a plain reason until their
  executors land. Nothing is simulated. Schematic (G3), PCB layout (G4) and manufacturing
  (G4.5) tasks wait for the KiCad engineering worker.

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
- Gerbers, drill, pick-and-place and panelization are in G4.5 (below).

```bash
docker build -f services/engineering/Dockerfile.worker -t vx-engineering-worker .   # now includes the PCB pipeline
pnpm test:eng                       # placement checks, routed fixture board: DRC + parity clean; unrouted and drifted negative controls
pnpm test:g4                        # schematic -> approve -> layout; worker killed after layout; fresh-KiCad DRC/parity/ERC of the stored project
pnpm test:e2e:g4                    # browser: approve schematic, continue, 3D board, DRC report, models, placement, approve
```

## G4.5: fab package

Manufacturing tasks also run on the KiCad engineering worker. They take the **committed routed board** of an
upstream PCB layout task, so the layout must be approved first. No model is involved: every step is
deterministic.

1. **Release gate.** KiCad DRC with schematic parity must be clean on the board being released.
2. **Board-house files.** KiKit writes the package for the board's fab profile (`jlcpcb` or `oshpark`):
   - Gerbers (X2) plus Excellon drill files, plated and non-plated separate, zipped the way the house expects;
   - for JLCPCB, the assembly BOM and pick-and-place (CPL), with KiKit's rotation corrections.
3. **Independent checks.** gerbonara re-reads the Gerbers and drill files without KiCad and checks:
   - required layers and outline size;
   - copper-to-edge clearance against the fab profile;
   - silkscreen inside the board;
   - hole count (plated, non-plated, vias) and the smallest drill.
   
   The CPL is compared with the board's footprint positions and sides, and the BOM with its components.
4. **Package contents:**
   - assembly drawings and a drill map;
   - `FAB-NOTES.txt`, the settings to enter on the order form (size, layers, thickness, copper, finish, mask,
     minimum track and drill, hole counts, missing LCSC numbers);
   - an optional 2x2 KiKit panel with mousebites, rails, tooling holes and fiducials;
   - one zip with a sha256 `manifest.json`.
5. **Release sign-off.** A fab package always waits for approval. The package page lists the ordering steps,
   shows the fab notes and the panel, and has a check page (Gerbers, CPL, parts, manifest). VX Design never
   places orders.

Limits:
- JLCPCB assembly needs an LCSC part number on every line. Until sourcing (M-SRC) fills them in, the package
  says so and only the bare boards can be ordered.
- KiKit's rotation corrections cover common packages; always check the house's placement preview.
- The G4.5 exit test is physical: order the board, assemble it and test it. That needs a real (not offline)
  design.

```bash
docker build -f services/engineering/Dockerfile.worker -t vx-engineering-worker .   # adds gerbonara
pnpm test:eng                       # fab package + negative controls: wrong outline/drills, fab limits, CPL/BOM tampering, DRC gate
pnpm test:g45                       # schematic -> layout -> fab package via the worker; manifest and package re-checked
pnpm test:e2e:g45                   # browser: order card, fab notes, independent checks, panel, approve
```

## M-SRC: part sourcing

Sourcing tasks take the **committed circuit design** of the upstream schematic task and produce a sourced BOM.
They run on any worker that has at least one distributor configured. A worker without keys leaves them alone,
and the run page names the keys that are missing.

- **Providers** (`packages/integrations/src/sourcing/`), in fallback order:
  - Nexar/Octopart (primary; its offers include LCSC, which gives the JLCPCB part numbers);
  - DigiKey v4 (fallback A);
  - Mouser v1 (fallback B).
  
  Every configured provider is asked; a failing one is recorded and does not stop the line. Request and
  response field names come from the vendors' own Swagger specs and live GraphQL schema. Contract tests use
  documented response shapes (`packages/integrations/test/fixtures/README.md` gives each fixture's
  provenance), and `pnpm --filter @vx/integrations test:live` checks each provider for real once its keys
  are set.
- **Identity.** Each part number is normalized and the manufacturer name is matched against known aliases.
  Every result is labelled an exact match, a packaging variant (e.g. `…TRG1`) or a different part. When
  providers disagree on lifecycle or manufacturer, the line is flagged.
- **Generic passives** (no MPN in the design) are chosen by rules:
  - the same value and package;
  - a capacitor voltage rating at least twice the rail voltage read from the net name (16 V when the
    rail is unknown);
  - LCSC-available first, then stock, then price.
  
  They are labelled "chosen by rules: review", and up to three alternates are kept.
- **Pricing** at 1, 10, 100 and 1000 boards: the cheapest single offer with enough stock, honouring MOQ,
  multiples and price breaks. Shipping, duty and assembly are not included.
- **Flags**: single source at 100 boards, lifecycle (obsolete, NRND, unknown), no LCSC number, no price, and
  provider errors. A line that cannot be sourced fails the task; nothing is invented.
- **Outputs**: `sourced-bom` (JSON, shown as a table with offers), a CSV and an `lcsc-map`.
  - The fab package writes live LCSC numbers into the schematic and board fields, so JLCPCB's assembly BOM
    is filled in.
  - Fixture numbers are never applied.
- **Catalog.** Live results go into the shared `parts` and `offers` tables, with each offer's observation
  time; fixture results never do. `part_models` is the manufacturer 3D model library (see below).
  Provider calls are metered in `cost_events`.

Not done yet in M-SRC: LCSC/JLCPCB's own APIs (both need an application). The 3D model library is below. The power calculator is below. No live distributor call has been made yet, because there are no keys.

```bash
pnpm --filter @vx/integrations test        # identity, pricing, BOM resolution, adapter contracts (fake HTTP)
pnpm --filter @vx/integrations test:live   # real calls; runs each provider whose keys are set
pnpm test:msrc                             # schematic -> sourcing (fixture worker) + layout -> fab package
pnpm test:e2e:msrc                         # browser: waits for keys, fixture BOM, approve
```

## Power calculator

Power tasks (discipline `power`) run on any worker. Claude proposes the power tree and a deterministic
calculator (`packages/power`) checks it. Calculator errors go back to Claude with the computed numbers, up to 3
repair rounds.

- **Tree.** The tree describes:
  - sources: battery (chemistry, cells, capacity, usable fraction), USB or DC, with their voltage range and
    current limit;
  - converters: LDO, buck, boost, buck-boost or load switch, with rated input range, maximum current,
    quiescent current, dropout or efficiency, θJA, Tj(max), soft-start and an `enable_after` for sequencing;
  - rails with their capacitance;
  - loads, with current per operating mode and a peak;
  - modes, with hours per day;
  - sequencing rules.
  
  Every source, converter and load carries a basis: datasheet, requirement, measurement, calculation or
  assumption.
- **Calculation.** Voltages are worked out top-down and currents bottom-up, for every mode at the
  minimum, nominal and maximum source voltage, plus a worst-case peak.
  - LDO: `Iin = Iout + Iq`, `P = (Vin − Vout)·Iout + Vin·Iq`.
  - Switcher: `Pin = Vout·Iout/η + Vin·Iq`.
  - Load switch: `P = I²·Ron`.
  - Junction temperature: `Tj = Ta(max) + P·θJA`.
  - Battery runtime: per mode and over the daily profile.
  - Also efficiency per mode and inrush (`C·V/t_ss`).
- **Checks:**
  - converter current against its rating (error over 100%, warning over 80%);
  - LDO dropout, buck headroom and boost topology;
  - rated input range;
  - junction temperature (error over Tj(max), warning within 25 °C);
  - source and battery limits;
  - inrush;
  - sequencing that nothing enforces;
  - structural errors (unknown rails, two supplies driving one rail, loops).
  
  Missing data is reported, never silently passed: an assumed efficiency, no θJA, no dropout, no source
  limit.
- **Output.** One `power-budget` artifact holds the tree and the full report. The app shows the tree, the
  findings, battery runtime, the converter and rail tables, efficiency, and the basis of every number.

```bash
pnpm --filter @vx/power test        # calculator against hand calculations and every check
pnpm test:e2e:power                 # browser: power task on a plain worker, report page, approve
```

## 3D model library

Manufacturer STEP models for a project's parts, so boards and enclosures use real geometry instead of
KiCad's generic package shapes. Open it from the project page.

1. **Add.** There are three ways in:
   - an engineer uploads a STEP or ZIP (for example an OEM's CAD under NDA);
   - an engineer gives an https link to one;
   - sourcing registers the CAD that Nexar (Octopart's CAD partners) reports for a sourced part.
   
   Models are private to the project unless marked shared (public manufacturer CAD only).
2. **Check** (KiCad worker, `vx_eng model-check`):
   - it tries all 24 axis-aligned orientations;
   - in each, it cuts the model just above its lowest point to find the terminals, and matches them one
     to one to the footprint's pads;
   - each terminal must land inside its pad and cover at least 15% of it, which rejects a model lying on
     its side;
   - it writes an aligned STEP (footprint origin, seating plane at Z = 0, so KiCad needs no transform) and
     a top-view overlay;
   - it measures the body and compares the height with the datasheet value when one is given.
   
   A symmetric terminal pattern is flagged, because pin 1 or polarity then has to be read from the body
   marking. A file that is not a STEP, or a model that does not fit, fails with the reason.
3. **Verify.** A person looks at the overlay and verifies or rejects the model. An inconclusive check, such
   as a QFN whose terminals and body meet at the bottom, needs a note saying what was confirmed by eye.
4. **Use.** Layouts use verified models for parts with a matching MPN, manufacturer and footprint. Each
   model is copied into the KiCad project (`3dmodels/`, referenced with `${KIPRJMOD}`), so the downloaded
   project shows it. It also appears in the board STEP/GLB, and the 3D model check names which parts have
   manufacturer CAD.

The alignment convention is tested end to end: an aligned model is placed on a board in KiCad, the board is
exported to STEP, and every foot is found on its pad.

```bash
pnpm test:eng              # model check: re-oriented vendor model, ZIP, wrong part/footprint/height, pin-1 symmetry, KiCad round trip
pnpm test:models           # upload -> worker check -> verify -> layout ships the model; a non-STEP URL fails cleanly
pnpm test:e2e:models       # browser: upload, overlay, verify
```

## M-ENC: enclosure and fit

Enclosure tasks (discipline `enclosure`) run on the KiCad engineering worker. They take the **committed
routed board** of an upstream PCB layout task. Claude chooses the housing; `vx_eng enclosure` builds and
checks it, and problems go back to Claude, up to 3 repair rounds.

- **Board facts.** KiCad exports the board and every component as separate STEP solids (drill origin), so a
  collision always names the part. Claude sees each part's height above the board, how far it reaches below
  the board, and its distance to the nearest edge.
- **Design.** Claude sets:
  - the process (FDM, SLA, SLS or CNC aluminium) and material;
  - the wall thickness;
  - the board-edge gap and top clearance;
  - the standoff height;
  - the fastening (heat-set insert, thread-forming screw, or tapped hole);
  - the openings: edge openings through the nearest or a named wall for connectors, and top openings
    (windows, round light or button holes) through the lid.
- **Geometry** (CadQuery). The cavity is the board's own outline offset by the edge gap. The base has a floor,
  walls up to a split plane 2.5 mm above the board, and a standoff with a fastener hole under every mounting
  hole. The lid has walls, a top and a locating lip. Both parts are built additively, because OCCT's
  through-cuts failed silently in testing. Every opening cut is verified to have removed material.
- **Checks:**
  - every component and the board against base and lid, where any overlap is an error naming the part;
  - clearance to the housing;
  - edge connectors set too far behind the wall;
  - parts without a 3D model, reported as unchecked;
  - wall thickness against the process minimum;
  - a fastening the process supports, and a standoff deep enough for it;
  - CNC inner corner radius;
  - build volume.
- **Outputs:**
  - base and lid as STEP and STL;
  - an assembly STEP;
  - an exploded GLB (board in the base, lid beside it) shown in the app;
  - top and front drawings (SVG);
  - the fit report with dimensions, Z levels, standoffs, openings, clearances and estimated mass;
  - the design.

The exit test is physical: print the housing and fit the real, assembled board.

```bash
pnpm test:eng                  # enclosure: fits; lid too low and short standoffs collide (named parts); process rules; edge recess; split planes
pnpm test:enclosure            # schematic -> layout -> enclosure with real KiCad 3D models; STEP re-read as one valid solid
pnpm test:e2e:enclosure        # browser: fit report, exploded 3D view, approve
```

## M-UI: client workspace

Clients get their own login and a workspace per project: a running **chat** on the left, the **results** in the
centre, and the live **checklist** on the right that stops at approval points.

- **People.** Owners invite by email on the project page (client, reviewer, engineer or viewer). If the address has no
  account yet the invitation waits, and it becomes a membership when that person signs up. VX Design does not send
  email yet: share the sign-up link yourself.
- **What clients see.** Requirements, the plan's tasks and their status, approval stops, outputs and their checks, the
  model library and the chat. Runs, executions, costs, the audit trail and worker logs are staff-only, enforced by
  row-level security, not just hidden in the UI. Clients opening the project page are sent to the workspace.
- **Checklist.** The approved plan in order: done, working, queued, blocked, and **approval needed**. At a stop the
  reason is shown with Approve / Return (a note is required to return). Clients, owners and reviewers can decide.
  The checklist refreshes while work is running.
- **Centre.** An overview (progress and one result tile per task) or any output, shown in the same viewers as the
  engineering pages (power report, schematic, 3D board, fit report, BOM, fab package).
- **Chat.** Claude answers from the project's requirements, plan, approvals, outputs, checks and recent chat, read with
  the asker's own permissions. It links the outputs it mentions (they open in the centre) and restates requested changes
  as suggested requirement changes for the team; it cannot approve or change anything. Messages are stored per project
  and every member sees the same conversation. With `VX_LLM=offline` it gives a labelled status summary instead (not AI).

```bash
./scripts/test-db.sh           # workspace_test: invitations, client visibility, who can decide, chat writes
pnpm test:e2e:workspace        # browser: invite, client signs up, checklist stop, chat, viewer, client approves
```

Screenshots: `docs/workspace/screens`.

## M-KB: knowledge base

A shared library of standards, regulations, datasheets and application notes, plus each project's own sources.
Every result carries its official link, edition, licence and whether a person has checked it (**Knowledge** in the
top bar).

- **Licensing rules, enforced in the database** (spec §8: a URL is not permission to copy):

  | Licence | Excerpts indexed | File kept |
  |---|---|---|
  | Public domain (e.g. US federal regulations) | yes | yes |
  | Open licence (CC BY, EU legal texts) | yes | yes |
  | Manufacturer document (datasheets, app notes) | yes | no: it stays on the vendor's site |
  | Reference only (IPC, IEC, ISO standards) | no: metadata and official link only | no |
  | Licensed copy | yes, for one project only | yes, in that project's storage |
  | Unknown | treated as reference only | no |

  Moving a source to a licence that allows less deletes the excerpts and stored copy it no longer allows.
- **Standards registry.** Seeded with the spec's starting references (IPC, IEC, UL, UN 38.3, FCC Part 15, EU
  directives, ISO, ASME, Bluetooth, IEEE, USB). Editions are left unconfirmed until a knowledge editor checks
  them with the issuing body. Being in the registry is not proof of applicability.
- **Per-project applicability.** On the project page, engineers propose which standards apply (applies, may apply,
  does not apply) with a reason; an owner or reviewer confirms. Changing an entry needs confirming again.
- **Project sources.** Datasheets, licensed standards and NDA documents added on the project page stay private
  to that project. They are searched only within it, even for someone who belongs to several projects.
- **Search.** Postgres full-text search over the excerpts (any word matches; passages matching every word rank
  higher), plus identifier matching ("ipc 2152" finds IPC-2152). Results show the citation locator
  (section and page), the matched words and the flags. Search runs with the user's own permissions.
- **Curation.** Knowledge editors (granted by the operator: insert the user's id into `knowledge_editors` with
  the service role) add to the shared library, verify sources and review standard editions. Project owners and
  engineers manage project sources; owners and reviewers verify them.
- **Chat.** The workspace assistant searches the knowledge base for each question and cites what it used. It
  gets the project's standards list too, and says when an edition is unconfirmed or only the reference is held.
- **Not yet:** vector (semantic) search, which needs an embedding provider; fetching documents from their URL;
  OCR for scanned PDFs; design tasks citing standards in their outputs.

```bash
./scripts/test-db.sh           # kb_test: licensing rules, write access, project scoping, search, standards review, applicability
pnpm --filter @vx/planning test  # excerpt chunking (section-bounded, page ranges, size limit)
pnpm test:e2e:knowledge        # browser: registry search, add/verify sources, licensed copy isolation, chat citations, licence downgrade
```

Screenshots: `docs/knowledge/screens`. The test documents in `tests/fixtures/kb` are original text.

## M-CON: concepts and design freeze

The first step of a product (S1): pick a look before detailed engineering. On a project's **Concepts** page (also the
first step of the workspace checklist, shown in the workspace centre):

1. **Ask for concepts.** Owners, engineers and clients describe a direction (look and feel, materials, colours,
   how it is held or mounted) and choose 1–4 variants. At most 2 rounds run at a time and 12 a day per project.
2. **Brief.** On the worker, Claude turns the requirements and the direction into distinct variants: a name, design
   language, rationale, colours/materials/finishes and an image prompt, plus a rough envelope with its basis.
3. **Images.** The image provider renders each variant. Every image is labelled **concept, not CAD** and stored in
   the project with its prompt, provider, model, seed and references. A variant the provider's safety system
   declines is shown with the reason.
4. **Refine.** "Refine this" on any variant starts a new round with that image as the reference.
5. **Freeze.** Owners, reviewers and clients freeze one variant with its envelope (L × W × H mm) and CMF. The freeze
   is recorded as a decision citing the image's hash. Changing it later needs a reason, supersedes the old
   decision, and is audited.

Image providers (worker secrets, never in the web app):

| Variable | Effect |
|---|---|
| `GEMINI_API_KEY` | Google Gemini image ("Nano Banana"), default model `gemini-nano-banana-2.1` |
| `OPENAI_API_KEY` | OpenAI GPT image, default model `gpt-image-2.5-sunburst` |
| `VX_IMAGE_PROVIDER` | `gemini` or `openai` when both keys are set (default Gemini) |
| `VX_IMAGE_MODEL` | override the default model |
| `VX_IMAGES=fixture` | labelled offline placeholders instead (development and tests) |

Both adapters follow the providers' published API references (checked 18 Nov 2026) and are tested against those
shapes with mocked responses; neither has made a live call yet.

```bash
./scripts/test-db.sh              # concept_test: who may ask/freeze, limits, worker lease, change control
pnpm --filter @vx/integrations test   # image adapters: request/response shapes, refusals, rate limits
pnpm test:e2e:concepts            # browser: client asks, compares, refines, freezes; owner changes the freeze with a reason
```

Screenshots: `docs/concepts/screens`.

## M-RFQ: manufacturers and RFQ

Getting quotes for custom parts without disclosing more than intended (spec §12).

**Supplier directory** (`/suppliers`, for project owners and engineers; clients and suppliers never see it):

- Suppliers start as **candidates**. The six from the spec's discovery list (JLCPCB, PCBWay, Seeed Fusion, Protolabs,
  Xometry, Hubs) are seeded as candidates with no legal names or contacts filled in. They are not endorsements.
- **Verified** means someone recorded the legal name, country (ISO code) and process matrix and said how they
  checked it. Changing any of these later sends the supplier back to candidate.
- **Approved vendor list**: only a library editor can approve, and only a verified supplier.
- A contact's email shows **"verify contact"** until someone records how the address was confirmed. Changing the
  address clears that. Only confirmed contacts of verified suppliers can receive an RFQ.

**RFQ** (project page → RFQs, owners and engineers):

1. **Manifest:** the §12 fields are project code (suppliers see this, never the project name), buyer, classification,
   quantities, materials, critical-to-quality dimensions, drawing revision, standards, compliance, tests, tooling
   ownership, shipping terms, deadline and quote breakdown. Missing items are listed, and the database refuses to
   build a packet until they are filled.
2. **Disclosure choices:**
   - the sharing scope: summary only, drawings, or full design;
   - which requirements to include (none by default);
   - which **committed** design files to include (scratch work cannot be attached).
3. **Suppliers:** these rows are the internal contact sheet, with each supplier's NDA status. Suppliers never see each
   other. The full-design scope needs a signed NDA, recorded per supplier.
4. **Packet:** a worker builds one supplier-neutral ZIP and checks each file against its recorded sha256. It contains:
   - README and cover letter;
   - the manifest as JSON and readable text;
   - an NDA template marked for legal review;
   - the chosen requirements and files;
   - `SHA256SUMS`.

   The same inputs always give the same bytes.
5. **Owner approval:** the owner approves *this packet* (by its sha256) to *these suppliers*. The audit log records
   every file hash and recipient. Any later change to the manifest, files or suppliers drops the approval.
6. **Release:** this opens each supplier's access window (1–90 days). VX Design does not send email: the page drafts
   each message for the owner to send from their own mailbox.
7. **Supplier portal** (`/supplier`): the supplier signs in with the contact's **confirmed** email address. There
   they can download the packet while the window is open (each download is logged), quote at each quantity with
   tooling, shipping, lead time and validity, revise the quote, or decline. They see only their own invitations,
   never the project name or other suppliers.
8. **Compare and choose:** quotes appear side by side, in the currencies they were quoted in (not converted).
   - Choosing one closes the RFQ, ends every access window, and records a `manufacturing` decision.
   - The purchase order is placed outside VX Design.

Clients do not see RFQs or quotes (an open decision). Every step is audited:
`rfq.created`, `rfq.packaged`, `rfq.disclosure_approved`, `rfq.approval_invalidated`, `rfq.sent`, `rfq.packet_opened`,
`rfq.quote_received`, `rfq.declined`, `rfq.access_revoked`, `rfq.awarded` and `rfq.closed`.

```bash
./scripts/test-db.sh                          # rfq_test: directory rules, completeness, approval bound to the packet, windows, isolation, award
pnpm --filter @vx/orchestrator test           # packet: contents, checksums, reproducibility, tampered files refused
pnpm test:e2e:rfq                             # browser: owner to supplier to quote to award
```

Screenshots: `docs/rfq/screens`.

## Database overview

`projects`, `project_members`, `documents`, `requirements`, `plans`, `tasks`,
`task_dependencies`, `decisions`, `approvals`, `runs`, `executions`, `artifacts`,
`artifact_versions`, `task_artifacts`, `validations`, `tool_capabilities`, `cost_events`,
`audit_events`, `project_invitations`, `project_messages`, `sources`, `source_chunks`, `standards`,
`project_standards`, `knowledge_editors`, `concept_rounds`, `concept_variants`, `design_freezes`, `manufacturers`,
`manufacturer_contacts`, `rfqs`, `rfq_attachments`, `rfq_recipients`, `rfq_quotes`, plus private `project-files` and `knowledge-files` storage buckets.

Built-in guarantees, each covered by `supabase/tests/schema_test.sql`:

- Project data is visible only to project members (row level security); clients never see runs, executions, costs, audit events or logs.
- Task status follows the spec §6 state machine; every change is written to `audit_events`.
- Task dependencies stay within one plan and cannot form cycles.
- Decisions are immutable; changes are recorded as new decisions that supersede old ones.
- Committed artifact versions are frozen.
- `claim_next_task()` hands out only tasks whose upstream work is complete, never twice.
- Worker leases, checkpoint resume, fenced commits, locks, budgets and run controls are covered by
  `supabase/tests/worker_test.sql`.
