# VX Design

Spec-driven electronics and hardware engineering platform: specification → plan →
sourced parts → power budget → KiCad board → manufacturing files → enclosure, with every
decision traced to evidence.

The master specification is [docs/SPEC.md](docs/SPEC.md) (v1.1). It merges the v0.1 platform spec and the
v1.0 product spec, and marks what is built. The source documents are in [docs/specs/](docs/specs/), and
[docs/ASSESSMENT.md](docs/ASSESSMENT.md) holds the feasibility assessment. Deployment (Vercel, Supabase, worker host):
[docs/DEPLOY.md](docs/DEPLOY.md).

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

### Guided setup and the look of the app

**Guided setup** (`/projects/<id>/setup`, "Guided setup" on the project page) takes a new project through five steps,
one at a time:
1. **Project:** name, code and description, and the product class chosen from chips.
2. **Mock-up:** reference images, and a link to the concept rounds.
3. **Intake:** markets, power, radios and standards as chips, size as three boxes, and the feasibility check.
4. **Inputs:** specifications uploaded here; parts and prior work are counted.
5. **Review and plan:** what is still missing, then "Generate the plan".

A readiness ring shows how much of what the planner needs is filled in. A manifest and the project's recent activity
sit beside the steps.

**Screens, not long pages:**
- **Project page tabs:** Overview, Documents, Requirements, Plans and runs, Standards and Team (`?tab=`).
  - **Overview:** summary tiles, the Project inputs button and the grouped sections.
  - **Requirements:** 50 per page, with search and status and document filters.
  - **Documents:** the first 8 are shown, with a button for the rest.
- **Project inputs:** five screens (Specifications, Mock-ups, Parts chosen, Prior work, Plan) with the step list on the
  left, Back and Continue, and a summary of what the plan builds on (`?step=`). Forms return to the step they were sent
  from.
- **Long lists:** the earlier-work register's subsystem groups start closed when there are more than 30 items.
- **Plan page:** tasks are grouped by stage (S0–S8). A stage index at the top shows the task count and how many are
  done. Each stage is a collapsible section with its task count, hours, approval gates, high-risk tasks and, once
  approved, a progress bar.
- **Project menu:** on every project page (staff), under the header. It holds Overview, Inputs and Workspace, then
  Define, Design, Make and Prove as drop-downs, with the current page and its group highlighted.
- **Busy pages in tabs** (`SectionTabs`): one section at a time. The open tab comes from `?tab=`, else the last tab opened
  on that page in this browser session (so saving a form returns to it), else where the work is.
  - **Run:** report, tasks, activity. Approvals waiting stay above the tabs.
  - **RFQ:** manifest, files, suppliers, packet, emails, quotes. It opens at the current step.
  - **Flux report:** summary and findings, migration plan, current design, revisions, earlier decisions, files.
  - **Validation:** verification, units, test plan, faults, test runs.
  - **Manufacturing routes:** parts to make, add a part, export for 3D printing.
  - **Release:** readiness, files, issue (draft) or files, changes from the last revision, production lots (issued).
  - **Compliance:** items grouped as failed, open, passed and not applicable; suggestions from the intake; certified modules.
  - **Lifecycle:** watch, cases, cost history. A case is impact, substitutes, resolution, opening at its current step.
  - **Production lot:** units, inspections, disposition.
  - **Intake and risks:** intake, risk register (forms return to their tab).
  - If a tab empties after a form (its last suggestion added), the page shows where the work is.
- **Stages:** one line per stage with its task count and status; the current stage (and any reopened or signed off past
  open items) is expanded.
- **Folder uploads:** every upload box takes files, a whole folder (the "Choose a folder" button) or anything dragged onto
  it, sub-folders included. System clutter (.DS_Store, Thumbs.db, __MACOSX) is left out, and each box keeps only the
  file types it takes, saying how many it left out. Flux imports take whole export folders. When two files share a
  name, the sub-folder becomes part of the name.
- **Updating the plan:** the planner reads every input, including the parts chosen from their datasheets (PT-n, with
  their specifications and model files; every one must be used by a task or its replacement argued). When anything is
  added or changed after a plan is made, the project, Project inputs and plan pages list what is new. "Update plan vN
  with these changes" sends the current plan's tasks and only the new or changed inputs; the planner returns just the
  tasks to add, change or remove, which are merged and checked like a full plan (every requirement covered or deferred,
  every part addressed). The new version says what it changed. "Rebuild from scratch" plans everything again.
- **Plan being built:** a large card at the top of the project, Project inputs and plan pages shows what is happening
  (updating vN or building from scratch), a live clock and the steps, and warns when no worker has picked the request
  up after three minutes. The update buttons are hidden meanwhile.
- **AI usage:** every AI call (website and workers) is priced from one token price table (`packages/planning/src/llm/pricing.ts`)
  and recorded with its purpose, tokens, cache use, time and who asked (`record_ai_call`); calls that fail after the
  model ran are billed and marked. Each project has an **AI usage** page (menu): this month, all time, cost per minute
  of AI time, by activity, and every call. The Account page totals AI spend by month, project and activity.
- **Billing (groundwork):** Account → **Billing** shows the prepaid balance, the plan, card top-ups (Stripe Checkout)
  and a statement per month (page and CSV) listing every charge with the AI call behind it: project, activity, model,
  tokens, our cost and the amount charged. Plans on offer (placeholder prices in `account_plans`): **Pay as you go**
  (no fee, cost + 25%), **Studio** ($50/month, AI at exact cost), **Team** ($150/month including $100 of AI at cost).
  Every cost event in a billed account's projects is charged as it is recorded (`billing_ledger`); the plan fee once a
  calendar month. When the balance reaches zero, AI work pauses (running runs stop at their next checkpoint, plan
  builds and AI actions are refused before any call is made) until credit is added. The internal plans (`standard`,
  `unlimited`) are not billed and keep their monthly allowances. Estimates on billed plans include the markup.
- **Build vs buy** (Define → Build vs buy, and a link on the plan's selection tasks): describe a subsystem (kind,
  interfaces, radios, the supply rail, the space, the markets it must be certified for). Code checks every module in
  the modules catalog against it and says why each one does not fit, or which facts the catalog lacks (unknown, never
  assumed). **Find more modules with AI** asks the model for candidates; only part numbers a distributor (or the parts
  catalog) confirms are added, as draft catalog entries that say where they came from (the model's certification
  claims are kept as a note, not as certifications). **Compare** creates a trade study of up to four fitting modules
  against a custom (chip-down) design on the module-vs-custom criteria: catalog facts where known, stated rules of
  thumb (integration and design hours at $120/h, certification costs, weeks to prototype) where not, all editable;
  **Fill from catalog** adds current prices. A decided study is a decision the next plan update builds on (TS-n).
- **Where things stand, everywhere.** Under the project menu, every project page shows the design run live: what it
  is working on (with a running clock and its latest step), how many results wait for you, the AI spend, and a link
  back to the run; the menu has **Runs** (every run). The run page has a large live panel and **Raise budget** (a run
  stopped only by its budget continues). The Workspace opens with a step-by-step line (inputs, concept, plan, design
  run, your approvals, manufacturer package: done, working, or your turn) and its activity panel with the results
  waiting for approval, what is working now and the recent activity log. With stage gates off, the stage bar follows
  the work.
- **Overnight runs and continuing a run.** "Run straight through (overnight)" (when authorizing, on the run page, or
  when continuing) approves every result whose VX Design checks pass instead of stopping for it; each automatic
  approval is recorded with the reason it would have stopped, on the authority of whoever turned it on. Failed checks
  still stop that task while the rest carries on; releases are never issued automatically. A run that stopped for
  input continues as the same run (**Continue the run**), with a new budget, approving what passed when overnight is on.
- **Approvals for non-engineers.** Each result waiting for approval says in plain language what VX Design checked
  and whether it passed ("Passed: all 4 checks passed"), with the engineering details folded away. **Approve everything
  that passed** approves every waiting result whose checks all passed; anything with a failed check is held.
- **A mock-up is the concept.** On Concepts, a project mock-up (or render, sketch, photo, drawing) can be frozen as the
  industrial design directly, with its envelope, instead of generating concepts (`concept_from_reference`).
- **Cost before you click:** each button that starts AI work shows its likely cost and where the figure comes from:
  plan update and rebuild, plan from requirements, reading specifications (only the blocks rules cannot read are
  counted; "no AI cost" when rules read it all), reading datasheets, chat questions and model comparisons. Figures come
  from this project's recorded calls, else the account's other projects, else typical figures (`apps/web/lib/cost-estimate.ts`).
- **Reading model:** each project chooses the model that reads its specifications and part datasheets (Opus 5.5 by
  default, Sonnet 5.5 or Haiku 5.5): AI usage → "Choose or compare", or the link on the Specifications step. **Compare
  models** reads one specification again with the chosen models, saves nothing as requirements, and matches each
  result against the requirements already read from it (same source paragraph, same meaning): found, missed, extra,
  kind and priority differences, cost and time, with the lists to check. Comparison calls show as "Model comparison".
- **Requirements with less AI:** a block identical to one already read in another specification of the project (a
  new revision) reuses those requirements; a clear sentence with one shall/must/should is read by rules (kind from its
  words, an acceptance criterion from its figures, vague words and TBD marked ambiguous); every other block goes to the
  model, and only those blocks are sent. Nothing is skipped by guesswork: only sections about the document itself
  (revision history, glossary, references, overview). Each specification shows how many requirements came by rules,
  reused, or by AI.
- **Parts from data before AI:** each datasheet's part number is found without AI (a "Part number" or "Ordering code"
  label, or a code in the file or package name that the datasheet itself contains) and looked up in the saved parts
  catalog, then at the distributors configured on the web server (Nexar, DigiKey, Mouser). An exact match supplies the
  maker, description, specifications, package and lifecycle; only datasheets nothing matches are read by AI. The result
  says how many came from data and how many from AI, and each part notes where its specifications came from.
- **Part packages (ZIP):** a manufacturer's ZIP can be dropped on Parts chosen as it is: it is opened, and its datasheets
  and 3D models become part files, noted with the package they came from. A model with no part number inside goes with
  the part its own package describes. ZIPs added on another step are listed on Parts chosen with "Read them as parts".
- **Workspace activity panel:** the plan's tasks are grouped by stage, with done/total. Stages with open work start
  expanded.

**Look:** the clean light design is the template: a blue-grey background with a faint blueprint grid, white cards,
navy panel headers in the workspace, and the S0–S8 stage strip on the project page and the workspace. Dark mode follows
the system until someone picks one with the switch in the header. The logo and favicon come from
`VX Design Chrome Orbit Logo.png`. The setup's chips, readiness ring and cyan accents come from the dark-tech concept.

### Project inputs

**Project inputs** (`/projects/<id>/inputs`, linked first on the project page) is where everything a plan is built
from comes together, and where the plan is generated:

1. **Specifications.**
   - **Upload:** any number at once, one per board, for the enclosure, for the software. Each file goes from the
     browser to a staging folder and is then checked and parsed as before.
   - **Extract:** "Extract requirements from N documents" reads them at the same time, then stores the results one
     document after another, so requirement codes continue across documents.
   - **Duplicates:** requirements that say nearly the same thing in two documents (word overlap ≥ 75%) are listed for
     a person to merge or keep.
2. **Mock-ups and references (`REF-n`).**
   - **What they are:** how the product should look: sketches, renders, photos, dimensioned drawings.
   - **Each one has:** a kind, a title, a note on what it shows and what to keep, and a "use in the plan" switch.
   - **Files accepted:** PNG, JPEG, WebP, GIF and PDF, checked on their bytes. SVG is refused because it can carry
     script.
   - **Concepts:** image references can be given to a concept round. The image model gets them as reference images,
     and their notes go into the brief.
3. **Parts already chosen.** Upload the manufacturer datasheets (PDF, or Word/text) and 3D or CAD files (STEP, STL,
   IGES); nothing has to be typed (`@vx/planning` part-identify.ts).
   - **Datasheets:** each is read for the orderable part number, which is kept only if it appears in the datasheet (a
     listed variant that does is used instead). Also read: the manufacturer, what the part is, its subsystem and up to
     12 key specifications. The part is created, or filled in if already listed, with the file attached. Up to 8 are
     read per press.
   - **Models:** each is attached to the part whose number (or variant) is in its STEP header or product names, or in
     its file name. The longest match wins.
   - **Unplaced files:** a file that cannot be read or matched is listed with the reason, and a person picks the part
     or types the number.
   - **By hand:** a part can still be typed in, from a collapsed form.

   Parts someone has already picked (`public.project_parts`), grouped by subsystem:
   - **Each one has:** part number, manufacturer, what it is for, subsystem, how far it got (candidate, selected,
     designed in, laid out, verified, rejected) and a note. A part number is listed once, ignoring case and punctuation.
   - **Files:** datasheets, 3D models (STEP) and drawings are attached to the part. The kind is worked out from the
     file: STEP is a 3D model, PDF a datasheet.
4. **Prior work.**
   - **Flux audits (`PW-n`).** Finished Flux audits marked for the plan. The planner gets, for each: board size, layers
     and whether it is routed; parts grouped by part number and role; rails and connectors; earlier decisions and
     claimed validations, all marked unverified; open problems and suggested next steps.
   - **Files from other tools or engineers (`REF-n`, kind "Prior design").** A KiCad project, a schematic PDF, a BOM
     spreadsheet, design notes, with a note on where each came from.
   - **What was already done: the earlier-work register (`PR-n`).** "Build the list of earlier work" asks a worker to read
     every earlier design document in full: the documents inside the Flux imports, the prior-design files and the
     parts' datasheets. It lists each part and design decision by subsystem with how far it got (considered, selected,
     designed, laid out, verified, rejected, open), quoting the document it came from. Items not quoted word for word
     are dropped. Parts entered by the owner override what the documents say.
   - **Corrections:** people can correct an item's status, add a note or leave it out. Corrections are kept by item
     across rebuilds.
5. **Other inputs.** The intake, the design freeze, confirmed standards and knowledge sources are shown with links,
   and also go to the planner.
6. **The plan.** "What the planner reads" shows the exact context. "Generate plan from these inputs" builds the plan.
   - **Each task** states its basis: it **reuses** earlier work, **adapts** it, **replaces** it, or **starts fresh**,
     citing the inputs it builds on and saying what remains.
   - **Earlier work must be addressed:** every register item that is selected, designed, laid out or verified must be
     cited by some task. A plan that ignores one is sent back for repair.
   - **Replacing:** a task that replaces earlier work must give its concerns and suggest alternatives.
   - **Validation:** a task citing an input that does not exist, or reusing work without citing any, is sent back for
     repair. Imported work is never treated as verified, so reused work still gets acceptance tests that
     re-establish it.
   - **Display:** the plan page shows each task's basis (with the earlier-work items named, and concerns and
     alternatives for replacements) and the inputs the plan was built on.
   - **Kept through changes:** the basis and the input list are stored with the plan and survive revisions and changes
     made from the workspace chat.

**Large plans go to a worker.** Planning hundreds of requirements takes longer than the hosted web server's 5-minute
request limit. Above 80 active requirements (`VX_WEB_PLAN_MAX_REQUIREMENTS`), "Generate plan" records a plan request
(`public.request_plan`) holding everything the planner reads. A worker then generates the plan with no time limit
and stores it as a draft version, with the same checks as a plan made on the web. Project inputs and the project
page show the request's progress (they refresh themselves), then a link to the plan, or the reason it failed. Only
one plan request runs per project at a time. `services/orchestrator/test/plan-request.test.ts` covers this path.

`supabase/tests/inputs_test.sql` covers the database rules: who may add references, the folder they must be stored
in, duplicates, image-only concept references, and the plan's inputs and basis through revision.
`pnpm test:e2e:inputs` covers the browser flow.

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
- **Simulation tasks** (engineering worker): the model writes the analysis as named quantities (each input with
  its source: requirement, datasheet, upstream task or stated assumption), checks against the requirements, and,
  when a circuit matters, a self-contained ngspice deck with `.meas` statements. Every number is computed by the
  built-in calculator and ngspice, not taken from the model; an analysis that does not compute goes back to the
  model, and a check that computes but fails fails the task with the numbers, for a person to decide. Decks are
  refused if they try anything outside the simulator (`.control`, shell, `.include`).
- **Verification tasks**, two kinds. Before manufacturing: a design review that gathers every upstream task's
  tool checks (ERC, DRC, parity, fit, sourcing, power, simulation; any failure fails the review), then has the
  model read each board's circuit against the requirements and list must-fix / should-fix findings; a person
  signs off every review, in every run mode. After manufacturing (a fab task upstream): a hardware test. Draft
  test procedures for its requirements are added to the Validation page and the task waits for built units; it
  passes once approved procedures have passing runs for all of them (Continue on the run page to check again).
- **Boards.** Schematic, layout and board-power tasks name their circuit board (`tasks.board`; plan fixes infer it
  from upstream work or the key, e.g. `tc-sch-io` → `tc`). A board's tasks build on each other: each schematic task
  starts from the board's design so far and must keep its parts, a board's power tree feeds its schematic, and a
  later layout task takes over the earlier board when the circuit has not changed since (no second layout). One
  manufacturing task packages every board (`fab.<board>/…`) and one sourcing task buys for all of them (refs
  `board/R1`).
- **Manufacturing tasks** by what they produce: fab outputs (Gerbers, pick-and-place, panels) make the fab packages
  (engineering worker); documents (bring-up checklists, factory tests, fixtures) are design briefs; the **RFQ package**
  gathers every committed manufacturing output upstream (each board's fab package, BOMs, CPL, drawings, board and
  enclosure models, test plans, service and compliance documents, reviews) into a **draft release**, with a brief for
  the quote request. A person checks its readiness, issues it on Releases and sends RFQs from the RFQ page.
- **Enclosure before the boards:** an enclosure task with no routed board upstream writes the envelope as a design
  record (sizes, stack-up, bays) for the board tasks to work to; plan fixes make a later enclosure task wait for each
  board's last layout, so the housing is built around the real boards.
- Schematic (G3), simulation, PCB layout (G4) and manufacturing (G4.5) tasks wait for the KiCad engineering worker.
- **No paying for loops.** Every repair loop (plans, briefs, circuits, layouts, power trees, enclosures,
  simulations, assembly instructions) stops early when a round reports exactly the same problems as the round
  before, or returns an output it already returned with the same problems; the reason is recorded. Each task also
  has its own AI spend cap per run (by discipline, e.g. $15 schematic, $20 layout, $6 simulation; a task's
  `cost_budget_usd` overrides it): at the cap the task fails, not retried, for a person to decide.
- **Unchanged work is reused across plan versions.** At approval every task gets a fingerprint over its definition,
  the exact text of its requirements, its board and basis, and its upstream tasks' fingerprints. A task identical to
  one finished in an earlier plan takes over its committed outputs and checks (labelled "Reused from vN … unchanged")
  instead of running; a change anywhere upstream reruns everything below it. Sourcing is reused for 7 days only.
  The plan page marks reused tasks; **Do again** runs a reused task, and the reused work after it, afresh.

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

### Exchange formats (S5)

Every fab package also carries `formats/`:
- **Files.**
  - IPC-2581 revision C (XML).
  - ODB++ (zip).
  - The IPC-D-356 netlist, for bare-board electrical test.
  - A DXF of the board outline in mm, for mechanical and enclosure suppliers.
- **Checks.** KiCad writes them; `vx_eng/exports.py` reads each one back with its own parser and compares it with the
  board as pcbnew reports it:
  - copper and signal layers;
  - every component;
  - every net with two or more pads;
  - the outline size, within 0.15 mm.

  A mismatch fails the package, like a Gerber error does.
- **Reproducible.** The dates KiCad stamps inside IPC-2581 and ODB++ are fixed, and the ODB++ archive is rewritten with
  sorted entries, so the same board gives byte-identical files (checked by the KiCad regression tier).
- **Fab notes.** They say which set to send to whom: Gerber X2 + Excellon as the primary set, IPC-2581 or ODB++ where
  a house prefers one, IPC-D-356 for electrical test, DXF for mechanical work.
- **Storage.** Each file is stored as its own artifact and covered by an "Exchange formats" check on the task.

### Inspection plans (S5)

**Inspection plans** (`/projects/<id>/inspection`) say what to check on bare boards, assembled boards and enclosures.
Each item gives the characteristic, the method, the stage (incoming, in-process or final), the sample
(100%, sample or first article), the acceptance criterion, a reference, and whether it is critical.
- **Drafting.** `packages/planning/src/inspection.ts` builds drafts deterministically:
  - **Board plans** come from the latest committed fab check. They cover outline, thickness (from the fab profile),
    layers, holes and smallest drill, IPC-A-600 workmanship, and electrical test against the IPC-D-356 netlist.
    PCBA plans add:
    - placement;
    - polarity of the polarized parts it names;
    - IPC-A-610 joints;
    - bridges on parts of 0.5 mm pitch or finer;
    - X-ray for QFN, DFN, BGA and other bottom-terminated parts;
    - through-hole fill;
    - bottom-side parts;
    - the approved production test;
    - serial labels.

    DNP parts, mounting holes, fiducials and test points are not counted as components.
  - **Enclosure plans** come from the fit report: overall size, wall, each boss and each opening, material, finish and fit.
    Their tolerance is the loosest one recorded in any supplier's rules for the enclosure's process, with that supplier
    named. Otherwise it is a typical figure, marked as assumed.
  - **Typical figures** that do not come from a supplier say "confirm with the fab".
- **Editing and approval.** Owners and engineers edit drafts: change any field, remove items, add items. The database
  rejects unknown stages and samples, duplicate keys, and empty methods or acceptance criteria. Owners or reviewers
  approve, which freezes the version; a trigger refuses later edits.
- **Revisions.** Revising makes v2 as a new draft. Approving it supersedes the previously approved plan of the same kind.
- **CSV.** Each plan downloads as CSV for the supplier (`…/inspection/<plan>/csv`).
- **Production lots.** A lot names the approved plan it is inspected against, and the lot page lists the plan's checks
  next to the inspection record.

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

## Manufacturing routes and the 3D-printing export

**Manufacturing routes** (`/projects/<id>/manufacturing`, staff only) record, for each physical part, how it is made
now and how it will be made in production (`public.part_routes`).
- **Parts:** the newest enclosure base and lid from each enclosure task, 3D models uploaded on this page (STL or STEP,
  stored as references of kind "3D model"), and parts without a model yet.
- **Each route has:** what the part must survive (outdoors or sun, drops, snap fits, client-facing finish, tight fits,
  rubber-like, clear, hottest temperature), the production process, material and yearly volume, the prototype
  material and quantity, colour and finish, and notes. The needs are pre-filled from the requirements.
- **Suggestions** (`suggestPrototypes` in `@vx/dfm`): prototype options across FDM, SLA, SLS/MJF, urethane casting and
  CNC. Options that cannot meet a need are left out: too little heat resistance, rigid for a rubber part, opaque for a
  window. The rest are ranked on the part's needs, on how well they stand in for the production material, and on
  cost and speed for the quantity. Each suggestion gives its reasons and what to watch out for. Ratings are
  qualitative and heat figures approximate.
- **Per part:** size and volume read from the STL, a material estimate in grams, a warning when it is too big for a
  typical machine, starting print or order settings, and a warning when the prototype material differs from production
  (fit and form only, no strength or drop sign-off).
- **Export for 3D printing:** a ZIP with one folder per part (STL and STEP), `PRINT-SHEET.md` (material, settings,
  quantity, finish, size, estimate, what the print stands in for) and `parts.csv` for a print service's order form.
- **Planning:** the routes go into the planner's context, which is told to design each part for its production process
  and plan the prototype builds and production tooling. The enclosure designer prototypes with the route's process and
  material, and keeps walls uniform when production is injection molding.

## Injection molding package

For a part whose production route is injection molding, **Manufacturing routes** adds a molding section
(`@vx/dfm` molding.ts, `part_routes.molding`).
- **Rules per material** (PC/ABS, ABS, PC, ASA, glass-filled PA66, PP, POM, TPE, acrylic): wall range, minimum draft,
  shrinkage, rib ratio and a clamp pressure factor. Textured mold finishes add draft (e.g. MT-11010 adds 1.5°). These
  are typical design-guide values; the grade's datasheet and the mold maker's DFM review decide.
- **Design check of the STL:**
  - **Draft:** surface nearly parallel to the pull with less than the required draft, and with none.
  - **Undercuts:** surface a straight pull cannot release (a ray in the pull direction hits the part).
  - **Walls:** rays from the surface inward, area-weighted, giving the nominal wall, thin and thick shares and how
    much the walls vary.
  - **Size:** projected area, a clamp force estimate (20% margin) and the shot weight.
  - Large meshes are sampled. Rays from the ends of walls run along the wall, so a few percent of thick readings are
    normal; thick areas are flagged above 5%.
- **Spec:** pull direction, mold finish, material grade, flammability, cosmetic surfaces, tolerances, critical
  dimensions, gate and ejector-mark notes, inserts, cavities and notes.
- **Tool suggestion:** an SPI class and a cavity count from the yearly volume over three years.
- **"Download the mold maker's package":** a ZIP with the part's STEP and STL, `MOLDING-SPEC.md` (the spec, the design
  check, the suggested tool and what to quote: tool, part price at three volumes, DFM report before steel is cut, T1
  samples with a dimensional report, tool ownership), `design-check.csv` and `critical-dimensions.txt`.

**Draft in the generated enclosure.** When the enclosure base or lid has an injection molding route (by the part it
points at, or named "Enclosure base" / "Enclosure lid"), the enclosure task builds it with draft. The worker sets at
least the material's minimum plus what the mold finish needs, whatever the model chose, and records it in the design.
- **Walls:** they flare toward the split, so the base and the lid each release from their mold. The inside is never
  narrower than the straight cavity, so the fit checks still hold.
- **Bosses:** they taper toward their open end. The insert holes stay straight.
- **Lid joint:** the lid locates with the standard molded joint. Its lip is the inner part of the lid wall continued
  below the split, and the base wall is stepped to take it. An inward lip would trap the core. This joint needs a wall
  of at least 1.8 mm.
- **Prints:** printed enclosures keep straight walls and the inward lip, now joined to the lid by a ledge (before, the
  lip was a separate piece).
- **Geometry check:** every join is checked for lost or unjoined geometry, and the lid and base must reach their full
  height.

## Assembly instructions

**Assembly instructions** (`/projects/<id>/assembly`) are the work instructions for building the finished product
(`public.assembly_instructions`, `@vx/planning` assembly.ts).
- **Drafting:** Claude drafts them from the bought parts (Project inputs), the made parts (manufacturing routes), the
  boards (committed layouts, or the Flux imports used for the plan), the enclosure design, and the relevant
  requirements. The engineer can add guidance.
- **Each step has:** parts, fasteners with a torque in N·m (or the reason there is none, e.g. heat-set inserts or
  clips), tools, one action per line, cautions (ESD, battery, cable routing, cosmetic surfaces), a check, an optional
  figure (a project image by its REF code) and a time estimate.
- **Checks:** every made part, bought part and board must be fitted in some step; figures must exist; every fastener
  needs a torque or a reason. Failing drafts go back for repair (2 rounds). Anything still failing is shown, and "Check
  again" re-runs the checks after edits.
- **Versions:** each draft is a numbered version. Engineers edit a draft step by step (move, add, delete). The owner
  or a reviewer approves it, which locks it and supersedes the earlier approved version. "Start a revision" copies a
  version into a new draft.
- **Exports:** "Printable instructions" opens a standalone document to print or save as PDF; drafts are marked as not
  approved. "Download for the assembler" gives a ZIP with that document, its figures, `steps.csv` and `bom.csv`
  (parts and fasteners per unit).

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
- **Streaming.**
  - Replies appear as they are written: the reply text is read from the model's structured output while it is still
    arriving.
  - The page then shows the stored, signed exchange, so the streamed copy is never the record.
  - Without JavaScript the form posts as before.
- **Plan changes from chat.**
  - **Proposing.** When asked to add, change or remove a task, the assistant proposes that one change; the offline
    stand-in understands "add a task: … after <key>" and "remove task <key>".
  - **Drafting.** Owners and engineers press **Draft this plan change**. That makes a new draft plan version: a copy
    of the newest plan with the change applied, keeping dependency order. Added tasks require approval of their result.
  - **Approval.** The draft is reviewed and approved like any plan; the running plan is not touched. Clients see the
    proposal but cannot draft it.

```bash
./scripts/test-db.sh           # workspace_test: invitations, client visibility, who can decide, chat writes
pnpm test:e2e:workspace        # browser: invite, client signs up, checklist stop, streamed chat, viewer, client approves, plan change from chat
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

**Fetching from the official link.**
- **When it applies.** A source's **Fetch from the official link** (or "Fetch the document now" when adding it) reads
  the document at its link, only when the licence allows excerpts.
- **Safety.** The fetch is guarded against reaching inside the network: https only, every resolved address checked at
  connect time (private, loopback, link-local and metadata ranges refused), redirects re-checked, 20 MB and 20 s
  limits.
- **Web pages.** HTML is read for its main content (headings, paragraphs, lists, tables; no scripts, navigation or
  footers) and never stored. PDFs and documents get the upload check, and a copy is kept only where the licence
  allows.
- **Change checks.** **Check the official link for changes** compares the content's sha256. Unchanged content only
  records the check; changed content is re-indexed, and a verified source returns to draft with a note to check the
  edition.

**OCR.**
- **Queueing.** A PDF with no text layer (a scan) is no longer refused: it is stored in the source's folder and queued
  for the worker.
- **Reading.** The worker renders each page at 300 dpi (`pdftoppm`) and reads it with Tesseract. Excerpts are located
  "p. N (OCR)", the source is marked OCR text, and the mean word confidence is shown.
- **Checks and copies.** Files are checked against their upload sha256 and, where required, a clean virus scan. A copy
  the licence does not allow is deleted afterwards.
- **Image.** The worker image now includes poppler and Tesseract; a worker without them skips OCR jobs.

**Modules catalog.**
- **What it holds.** Knowledge base → **Modules catalog**: radio modules, systems on module, development boards and
  other modules, with:
  - interfaces and radios;
  - supply range and currents;
  - size and lifecycle;
  - performance as the datasheet states it;
  - CAD links;
  - certifications.
- **Sources.** Each certification needs a regime, an identifier, and an https link to the grant or a note of where it
  was read. Directory users (owners and engineers of any project, and library editors) add and edit entries. Library
  editors verify, and an edit clears the verification.
- **Uses.** A module can be added to a trade study as an option, with its certifications in the description. The
  compliance page lists certified modules found in the project's loaded BOM, with a reminder that a grant covers the
  transmitter only under its integration conditions.

```bash
./scripts/test-db.sh              # kb_polish_test: fetch records and change detection, OCR jobs, modules
pnpm --filter @vx/security test   # the fetch address filter
pnpm --filter @vx/orchestrator test   # OCR: TSV parsing, excerpts, a real scanned page read back
pnpm test:e2e:kb-polish           # browser: fetch + change check, OCR by the worker, modules, trade option, compliance note
```

The browser test serves its "official site" locally: the app must run with
`VX_TEST_FETCH_REWRITE=https://docs.example.test=http://127.0.0.1:4599`. That is a test-only setting, ignored on
Vercel. Screenshots: `docs/kb-polish/screens`.

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

## G5: Flux import and audit

Bringing existing work from Flux into VX Design (spec §16). Project page → **Flux import** (owners and engineers;
staff can read; clients cannot).

1. **Upload** everything Flux exports, tagged by revision (with a date so they sort oldest first). The browser
   uploads straight to the project's storage, so large ZIPs and STEP files never pass through the web server. Useful
   exports:
   - Export → Flux project data (JSON and asset files);
   - Electronics → Netlists (EDIF and IPC-D-356), Manufacturing files, Bill of materials, Pick & place;
   - 3D (STEP);
   - chat, notes or report exports, and screenshots.

   ZIPs are unpacked (nested once) with size and count limits.
2. **Audit** (worker, `@vx/flux`, deterministic: the same files give the same report):
   - **Inventory:** every file is hashed and classified, and missing exports are listed. Assets that `project.json`
     refers to but that are not in the upload are flagged.
   - **Consistency:**
     - each designator is checked across the project JSON, the EDIF netlist, the BOM and the placement file;
     - conflicting part numbers and parts with no part number are flagged;
     - lifecycle is taken from the VX parts catalog where the part is known.
   - **Schematic against layout:** EDIF (or the JSON nets) is compared with IPC-D-356 by which pins are joined, not by
     net names. A split net, a merged net, a missing pin or an extra pin is a **blocker**.
   - **Board:** layer count and outline from the JSON stackup and the Gerber X2 attributes and outline, cross-checked.
   - **Current-state map:**
     - parts, with which exports each appears in and why it is uncertain;
     - connectors with their nets and edge positions;
     - power rails by net name;
     - outline, mounting holes and edge connectors as enclosure constraints.
   - **Revisions:** parts and nets added, removed or changed between consecutive revisions. Changes that were made and
     then undone (A → B → A) are flagged as decisions taken twice, and parts that keep changing are listed.
   - **History:** Claude lists earlier decisions and claimed validations from the text and PDF exports. Each item
     must quote its file; items whose quote is not found word for word are dropped. Decisions and claims are always
     *unverifiable*. A claim with a related file in the export (for example a DRC report) is "evidence file present,
     not re-run".
   - **Migration plan:** bounded tasks, each with a discipline, an effort, a scope, inputs, a "done when" and the
     findings it resolves.
3. **Report:** shown on the page, and stored as JSON and Markdown (with sha256) in the project's folder.

Nothing imported is ever marked verified. The best a part can be is *consistent across the exports*.

Checked against a real Flux export (November 2026). What real exports do that the documentation does not say:
- **Eight BOMs.** One BOM per board house is written. The audit reads Flux's own (`…-Flux.csv`), which has every
  column, and keeps each part's design notes (Role, Role Details, Design Note, Functional Group) and distributor part
  numbers. Those notes are shown next to each part, so the reasoning behind a part is not lost.
- **Pin names in IPC-D-356.** Pin *names* are written there, cut to four characters (`VTREF` → `VTre`), and a
  repeated name (`GND`, `GND_2`) arrives twice. Layout pins are matched to schematic pins by name ignoring punctuation,
  then by prefix on the same part. A part numbered in one export and named in the other is matched by net, and listed
  so its pin numbering is checked by hand.
- **ODB++ archive names.** The ODB++ ZIP is named after the project, not "odb", so it is recognised by its
  `matrix/matrix`. It gives the copper layers and the outline, and its copper records tell whether the board is routed.
  A placed but unrouted board is flagged, and "connectivity matches" then says that nothing is connected yet.
- **IDF (`.emn`).** This gives the outline, the thickness and the drilled holes.

Limits:
- **`project.json`.** This reader follows Flux's published description of `project.json`; the real export checked
  did not include one. It reports any section it cannot find.
- **No KiCad export.** Flux has none, so the plan's "Rebuild in KiCad" task recreates the design from the netlist,
  BOM and placement.
- **IPC-2581 and GenCAD** are inventoried but not parsed. ODB++, IDF and Gerbers cover the same board facts.
- Screenshots are listed for a person to read.

```bash
pnpm --filter @vx/flux test       # parsers and audit on a synthetic three-revision export with planted problems
./scripts/test-db.sh              # flux_test: who may import, file rules, worker lease, staff-only
pnpm test:e2e:flux                # browser: upload three revisions, run, read the report
```

Screenshot: `docs/flux/screens`.

## G6: hardening

Security, recovery and a regression suite. The full description is in [`docs/SECURITY.md`](docs/SECURITY.md).

- **Security lint** (`supabase/tests/security_test.sql`): fails if any table lacks RLS, anon has any privilege, a
  `SECURITY DEFINER` function is unpinned or does not check its caller, or a worker-only function is open to users.
  Running it found and fixed these:
  - anon grants;
  - two ID-based leaks (`rfq_missing`, `plan_status_of_task`);
  - clients able to list and read RFQ and Flux storage folders;
  - members able to post chat messages as the assistant (answers now need the web server's HMAC signature).
- **Tamper-evident audit log**: a per-project SHA-256 hash chain, checked with `verify_audit_chain(project)`.
- **Uploads**: content inspection at every upload form and in the Flux worker (`@vx/security`), and ClamAV
  scanning by any worker with `CLAMD_HOST`. Infected files are unreadable at the storage layer and audited.
  Optionally, uploads can be required to be scanned clean before anyone can read them.
- **Web**: CSP and security headers.
- **Repository**: a secret scan, and CI in `.github/workflows` (`ci.yml` on every push; `e2e.yml` nightly or on demand).
- **Recovery**:
  - lease takeover and fencing for every job type (`recovery_test.sql`);
  - `pnpm check:integrity`, which re-hashes every stored file and verifies every audit chain;
  - `pnpm drill:backup`, which backs up, restores and proves the copy.
- **Regression**: `pnpm test:regression` (plus `:engineering` for KiCad) runs each pipeline twice and compares
  against committed snapshots that record input hashes and versions.

  On its first run it found that KiCad boards were not repeatable (random item UUIDs). vx_eng now seeds them from
  the inputs, so the same design gives the same board and Gerbers.

```bash
./scripts/test-db.sh                  # + security_test, recovery_test
pnpm test:regression                  # repeatable, unchanged deterministic pipelines
pnpm test:regression:engineering      # KiCad schematic/layout/fab, twice, in fresh containers
pnpm test:e2e:security                # headers, upload refusal, ClamAV (EICAR), forged assistant, staff folders, audit chain
pnpm check:integrity                  # stored files and audit chains
pnpm drill:backup                     # backup, restore, verify
./scripts/check-secrets.sh            # credentials in tracked files
```

Setup for a deployment:
- `./scripts/set-assistant-key.sh` stores the chat signing key and prints `VX_ASSISTANT_SIGNING_KEY` for the web
  server (the local stack uses a labelled dev key from `seed.sql`).
- Give workers `CLAMD_HOST`.

## Optimization proposals (§14)

Project page → **Optimize**: ranked changes to the design. Owners and engineers run the analysis; owners and
reviewers decide; staff can read; clients cannot.

The worker reads the project's latest **approved** sourced BOM and power budget, then looks up the alternates and
passive parts at the configured distributors to get current offers and specs. `@vx/optimize` then produces proposals.
No model is involved: every before/after is computed.

| Objective | How the before/after is computed |
|---|---|
| Cost | Alternate parts priced at 1/10/100/1000 boards with the sourced BOM's own rules (MOQ, multiples, price breaks, stock) |
| Availability, lifecycle, second source | Distributor stock and lifecycle; parts with no qualified alternate become "replace: engineer to choose" (low confidence) |
| Fewer parts | Passives with the same value and package merged onto one part that meets every line (optional assembly fee per unique part) |
| Power (LDO → switcher), standby (low-Iq), thermal (θJA) | The power tree is changed and the power calculator re-run: input power per mode, energy per day or battery runtime, dissipation, junction temperature |

Each proposal carries:
- the change and the requirements it touches;
- the before/after table;
- the basis and any assumptions, by name (for example "switcher efficiency 88%");
- confidence and the reason for it;
- effort, and a cost/NRE note;
- affected interfaces, manufacturing effects and standards (e.g. EMC for a switcher);
- constraint checks.

**Hard constraints are never traded.** Before anything is offered, a replacement part is re-checked against the
line's value, package and voltage rating. A requirement that names the current part, or that forbids the change
(e.g. "shall use a linear regulator"), excludes the proposal. Excluded ideas are listed with the reason.
Constraints that need judgment (e.g. noise-sensitive loads on a rail that would get a switcher) are marked
*needs review*, and must be confirmed before accepting.

Ranking: benefit × confidence ÷ effort. Benefit is the share of BOM cost saved at the chosen quantity, the gain in
energy per day or battery runtime, or a fixed weight for lifecycle and supply risk. **Accepting** records a project
decision (change control) for the next design revision. **Rejecting** needs a reason. A later analysis carries both
over by fingerprint, so a rejected idea is not offered again.

```bash
pnpm --filter @vx/optimize test      # analyzers, constraint exclusions, power recomputation, ranking
./scripts/test-db.sh                 # optimization_test: who may run/decide, lease, carried-over decisions, change control
pnpm test:e2e:optimize               # browser: run, review, accept with confirmation, reject, re-run
```

Screenshots: `docs/optimize/screens`.

## S6: build and validation evidence

Project page → **Validation**: prototype units, test procedures, recorded results with their evidence, and faults
through to a verified fix. Members (clients included) can read everything. Owners and engineers register units,
write procedures, attach evidence and handle faults. Owners and reviewers approve procedures. Reviewers may also
record tests. **Test evidence is not certification** (§15).

- **Units**: serial, board revision, the committed fab package or board they were built from, lot, assembler.
  Status follows the results (built → in test → passed/failed → reworked).
- **Procedures** (`TP-NNN`, versioned): stage, setup, steps, and measurements with limits (min/max, expected
  value or yes/no), each tied to a requirement with a stated basis. **Draft from requirements** writes one draft
  per untested requirement, with limits read from the requirement text ("between 3.2 V and 3.4 V", "at most 50 uA",
  "3.3 ± 0.1 V") and cited; with no number, a yes/no check of the acceptance criteria. Approved versions are frozen; a
  change is a new version.
- **Runs**: a unit, an approved procedure, conditions (temperature, supply, firmware), equipment with calibration
  dates and values (typed or pasted as `key,value` lines). **Pass/fail is computed in the database from the
  approved limits**, never typed. Runs, measurements and evidence are immutable, even to the service role. A
  mistake is fixed by a new run that supersedes the old one.
- **Evidence**: scope captures, photos, logs, attached to a run under `{project}/evidence/{run}/`, with SHA-256,
  scanned like other uploads.
- **Faults**: a failing run opens one automatically. Root cause and correction (rework, design change, firmware,
  component, procedure) move it to *corrected*. *Verified* needs a later passing run of the same procedure on the
  same unit. *Won't fix* is owner-only, with a note.
- **Verification matrix**: per requirement, the procedures and the units passing, failing or incomplete on their
  latest run. Status: verified by test, failing, incomplete, not tested, or no approved procedure. The workspace
  checklist shows a *Build and validation* step from it.

Every step is written to the audit trail.

```bash
pnpm --filter @vx/planning test       # limits read from requirement text, procedure drafts
./scripts/test-db.sh                  # validation_test: roles, frozen procedures, computed verdicts, immutability, faults, matrix
pnpm test:e2e:validation              # browser: units, draft/approve, pass + evidence, fail → fault → rework → retest → verified
```

Screenshots: `docs/validation/screens`.

## Accounts, quotas and fair queueing

**Account** (top bar) shows the signed-in person's plan, its limits and this month's use. An account is whoever
created a project: its plan covers all of that person's projects, whoever on the project starts the work.

| Limit | Enforced |
|---|---|
| Projects per account | when a project is created |
| Active runs (pending, running, paused) | when a run is authorized |
| Tasks running at once | when a worker claims work: tasks beyond it wait in the queue |
| Monthly AI and compute allowances (UTC calendar month, from `cost_events`) | reaching one stops the account's running runs at their next checkpoint and refuses new runs |
| Concept rounds per month | when a round is requested |

Limits are enforced by database triggers, so every path is covered. Refusals start with "Plan limit:" and say why.
Plans live in `account_plans` (null = no limit). Accounts without a row are on **standard**, whose numbers are
placeholders until pricing is decided. **unlimited** is for staff. Billing is not built: in the Supabase SQL editor,
`select public.set_account_plan('<user id>', 'unlimited');` moves an account, and changing a plan's numbers applies
to every account on it at once.

**Fair queueing.** Workers claim with `claim_next_fair`, not oldest-run-first. Each claim goes to the account with
the fewest tasks running, divided by its plan's `queue_weight` (unlimited counts double). Ties go to the account
served least recently. Within an account, the run with the fewest tasks running goes first. A per-account lock keeps
the limit exact when several workers claim at once.

```bash
./scripts/test-db.sh            # quotas_test: limits, refusals, spend stop, plan changes, claim order across accounts
pnpm test:e2e:quotas            # browser: account page, a project limit as the user meets it, a plan change
```

Screenshot: `docs/quotas/screens`.

## Stage gates and the risk register (S0)

Project page → **Stages** and **Intake and risks**.

**Stages.** Every task belongs to one of the nine product stages, S0 to S8. The stage defaults from the task's
discipline (architecture → S2, schematic → S3, sourcing → S4, …) and can be changed while the plan is a draft. The
plan page shows each task's stage.

With **stage gates on** (the default for new projects; the owner can switch them off), a task starts only once every
earlier stage is signed off. A run that reaches a gate ends with "Waiting for S2 sign-off" and the next step in its
report. Owners and reviewers sign a stage off when nothing blocks it:

| Stage | Blocked by |
|---|---|
| S0 | feasibility check not run; intended use, markets, quantity, target cost or power source missing; requirements not yet confirmed or rejected |
| S1 | no design freeze |
| S2–S8 | the stage's tasks in the approved plan not done (S6 also: faults not verified) |
| any | high or critical risks of that stage still open or being mitigated |

The owner can sign off past blockers with a written reason; the blockers are kept with the sign-off. Reopening a
stage (owner, with a reason) stops later stages' tasks from starting until it is signed off again. The workspace
checklist shows the current stage. Every step is audited.

**Intake and risks.** The intake records what the product is for:
- intended use and target markets;
- first quantity and target unit cost;
- size, power source, radios and target standards.

The **feasibility check** applies fixed rules (no model, the same answer every time) to the intake and the
requirements. Every finding cites the passage that triggered it:
- lithium batteries and mains voltage (safety);
- radios (certification);
- regulated domains (medical, automotive, aerospace, hazardous areas);
- sealed enclosures and wide temperature ranges;
- displays (single-source parts) and battery-life targets;
- wireless video and high-speed interfaces (beyond what VX Design automates);
- ambiguous or unmeasurable requirements, and missing markets or cost targets.

Findings become numbered risks (RISK-001…), scored likelihood × impact (5 × 5) into low, medium, high or critical,
each with a suggested mitigation. Rerunning the check keeps people's scoring and decisions, closes findings no longer
detected, and reopens ones that return. Risks can also be added by hand. Accepting or closing a risk needs a note,
and accepting a high or critical risk is the owner's call.

```bash
pnpm --filter @vx/planning test   # feasibility rules: what fires, citations, intake gaps
./scripts/test-db.sh              # stages_test: stage defaults, gating claims, blockers, waivers, reopen, risk register
pnpm test:e2e:stages              # browser: intake, feasibility, S0/S1 sign-off, S2 risks, plan and workspace
```

Screenshots: `docs/stages/screens`.

### Requirement wizard (S0)

Project page → **Requirement wizard**. Clients can also reach it from the workspace's S0 checklist step.

**The questions.** Six steps of plain questions, for when there is no written specification yet or to fill its gaps:
1. Product and use: purpose, users, setting, quantity, target cost, lifetime.
2. Markets.
3. Power: source, battery life and daily use, standby, USB-C charging.
4. Connectivity and controls: wireless, range, phone app, wired connections, display, buttons, sound.
5. Size and environment: maximum size and weight, temperature range, IP rating, drop, mounting, finish.
6. Anything else: named standards, and other needs, one per line.

**Who answers.** Answers are saved at each step. Owners, engineers and clients can answer; reviewers can only read.

**What it produces.** The review lists the requirements the answers give. `wizardRequirements` in `@vx/planning`
writes them deterministically:
- **Each requirement:** text, acceptance criteria and the answer it came from.
- **Blanks:** a blank answer gives nothing, except a stated gap where one matters, such as a battery with no life
  target, or outdoor use with no IP rating.
- **Typical targets:** where the acceptance criteria add a typical target (USB 4.5–5.5 V, universal mains input, an
  IEC 60068 method), they say so, for the team to confirm.

**Applying.** Owners and engineers press **Create and update requirements**:
- **The intake.** It is saved, so the feasibility check and compliance suggestions follow.
- **New requirements.** Added as drafts ("extracted", origin `wizard`), numbered per kind after existing ones.
- **Repeat runs.** Each requirement has a stable wizard key, so applying again updates changed requirements (back to
  draft) instead of duplicating them. Requirements a plan task already uses are left alone and listed, as are wizard
  requirements whose answer was removed.

```bash
pnpm --filter @vx/planning test   # wizard: requirements from answers, gaps, intake feeding compliance and feasibility
./scripts/test-db.sh              # wizard_test: who answers and applies, numbering, updates, in-use protection
pnpm test:e2e:wizard              # browser: a client answers all steps; the owner applies; a changed answer updates one
```

Screenshots: `docs/wizard/screens`.

## Trade studies (S2) and manufacturer process rules (S4/S5)

**Trade studies.** Project page → **Trade studies**: module or custom design, which part, which approach. A study
holds a question and its options. Each criterion is one of:
- lower is better;
- higher is better;
- a 1–5 rating;
- a must-have (yes/no).

Criteria are weighted 0–10. Each option's score for a criterion keeps its basis (where the number came from).
Templates exist for *module vs custom* and *component choice*. **Fill from parts catalog** fills unit cost at the
intake's quantity, stock and lifecycle for options with a part number, from the latest distributor offers; fixture
data is labelled.

The ranking is calculated in `@vx/planning`, with no model:
- numeric criteria are scaled across the options, best = 1 and worst = 0;
- ratings map 1–5 onto 0–1;
- an option that fails a must-have is ruled out.

A sensitivity note says whether halving or doubling any one weight would change the winner. Owners and reviewers
decide with a rationale, and may choose against the ranking. The choice becomes a project decision under change
control. Its alternatives, scores and ranking are kept as evidence, and it is marked an assumption if any hand-entered
score has no basis. Decided studies are frozen.

**Process rules.** On a supplier's page in the directory: what the supplier says it can make, per process. Each set
of rules records its source (a capability page or a note) and the date it was read. Templates are offered for
JLCPCB, OSH Park, and typical FDM, SLA and CNC services. A change clears the verification, and a library editor
verifies against the source.

| Process | Rules |
|---|---|
| Bare PCB fabrication | layer counts, track, clearance, drill, board size, thicknesses, finishes |
| PCB assembly | smallest passive, finest pitch, BGA, parts on both sides, through-hole, board size |
| FDM, SLA, SLS, CNC, sheet metal, molding | minimum wall, largest part, tolerance, materials |

**Manufacturing fit.** Project page → **Manufacturing fit** (staff): the committed board and enclosure, measured,
against every supplier's rules (`@vx/dfm`).
- Board facts come from the fab package's check file and the fab profile it was built with: size, layers, track,
  clearance, drill, thickness, finish, smallest passive, parts on both sides, through-hole, BGA.
- Enclosure facts come from the fit report.
- Each check shows the design's value against the limit. A result is *incomplete*, never a pass, when a value isn't
  measured or a limit isn't stated.

```bash
pnpm --filter @vx/dfm test        # rules parsing, board/assembly/enclosure checks, unknown vs pass
pnpm --filter @vx/planning test   # trade-study ranking, must-haves, sensitivity
./scripts/test-db.sh              # trade_test: rules with sources and verification; study drafts, decisions, freeze
pnpm test:e2e:trades              # browser: rules from templates, manufacturing fit, a catalog-filled study decided
```

Screenshots: `docs/trades/screens`.

## S7: compliance and production tracking

Tracking only. VX Design records what labs and inspectors report, with their files. It never certifies a product or
says that one complies.

**Compliance.** Project page → **Compliance**.
- **Suggestions.** `suggestCompliance` in `@vx/planning` works out the regimes that probably apply from the intake:
  markets, radios, power source and intended use. Each suggestion names the intake fact that triggered it.
  - Examples: FCC Part 15B and 15C, ISED, the EU Radio Equipment Directive or the EMC and Low Voltage directives,
    RoHS, WEEE, REACH, the EU Battery Regulation, UK, RCM, Japan radio, UN 38.3 and IEC 62133-2.
  - Cellular, children's and medical uses are flagged.
  - Missing facts are listed as gaps, not guessed.
  - It is a starting list to confirm with a test lab.
- **Progress and results.** Items move through identified → in progress → at the lab. A lab result needs:
  - the lab's report file (checked like other uploads);
  - the lab name and the result date;
  - the released revision that was tested.
- **History.** Results are kept as an unchangeable history. A result tested on an older revision than the current
  release is flagged, so someone assesses whether a retest is needed.
- **Not applicable.** Needs an owner or reviewer and a reason.

**Releases (revision lock).** Project page → **Releases**.
- **What a release is.** A named revision (A, B, 1.1…) holding one committed version of each file it covers: fab
  package, BOM, enclosure and others.
- **Readiness check.** Lists what stands in the way:
  - **Blockers:** unverified major or critical faults, failing requirements, failed compliance items.
  - **Warnings:** an empty or partial file list, newer versions of included files, untested requirements, open
    compliance items.
- **Issuing.** The owner issues the release; blockers need a written reason. Issuing:
  - freezes the manifest (each file's path and sha256) and the manifest's own checksum;
  - records a project decision;
  - supersedes the previous release.
- **After issue.** An issued release cannot change. It can only be withdrawn, with a reason.

**Production.** Project page → **Production**.
- **Lots.** A pilot or production lot is built from the current release. Each lot has:
  - an optional production (test jig) procedure, an approved S6 procedure;
  - a sampling plan: sample size and defects allowed.
- **Units.** Registered by serial range. Each unit carries the release's revision and its fab package.
- **Testing.** Each unit's production test is an ordinary S6 test run. A failure opens an S6 fault, which blocks the
  next release until it is verified.
- **Inspections.** Incoming, in-process or final; unchangeable once recorded. The verdict comes from the plan:
  - reject as soon as the defects exceed the number allowed;
  - accept only once the full sample has been checked.
- **Acceptance.** Owners and reviewers accept a lot. They need a passing latest final inspection, and every unit,
  bar scrapped ones, passing its latest production test. Acceptance marks those units passed.
- **Yield.** First-pass yield and the current pass count are shown per lot.
- **Traceability.** **Trace** takes a serial number back to its lot, release, released files, fab package, test runs
  and faults.

**S7 stage gate.** The S7 sign-off waits for:
- a released revision;
- every compliance item passed or marked not applicable;
- an accepted lot.

```bash
pnpm --filter @vx/planning test   # compliance suggestions from intake facts
./scripts/test-db.sh              # production_test: releases, readiness, compliance results, lots, inspections, trace
pnpm test:e2e:production          # browser: release, compliance from suggestions, lab result, lot, trace, Rev B
```

Screenshots: `docs/production/screens`.

## S8: lifecycle

Project page → **Lifecycle**. All ratings are calculated in `@vx/planning` (`lifecycle.ts`) from catalog records,
with no model, and every rating lists its reasons.

**Watch.**
- **Loading.** **Load the BOM** reads the latest committed sourced BOM and matches each line to the parts catalog. A
  newer committed BOM is offered as a reload.
- **Risk per part:** high, medium, low or clear, with reasons. The inputs are:
  - **lifecycle:** obsolete, last-time buy, not recommended for new designs, or unknown;
  - **notices:** end-of-life notices with the days left to the last order, change notices from the last 180 days,
    counterfeit alerts;
  - **stock:** distributor stock against the need (quantity per board × the intake's build quantity), and how many
    distributors hold it;
  - **price:** a rise of 25% or more since the first observation.
- **Fixture data.** Made-up distributor data is labelled.

**Notices.**
- **Recording.** Product change (PCN), end-of-life, last-time-buy and counterfeit notices are recorded per part, with
  a source link or note.
- **Shared.** Notices are shared with every project using the part, and cannot be edited.
- **Effect on the catalog.** An end-of-life notice moves the part's catalog lifecycle. Any lifecycle change in
  distributor data is recorded automatically as a notice.

**Cases.**
- **Opening.** A risk opens a case: one open case per part, assessed for impact.
- **Resolving.** Owners and reviewers resolve a case with one of:
  - a qualified substitute;
  - a last-time buy (with the quantity);
  - a redesign;
  - an accepted risk;
  - not affected.
- **Recorded as a decision.** The resolution becomes a project decision. Its evidence is a hardware test when the
  substitute was bench-tested.

**Substitutes.**
- **Proposing.** Typed in, or picked from the sourced BOM's alternates.
- **Checks.** Five, each pass, fail or not applicable, always with a basis:
  - footprint and pin-out;
  - electrical ratings;
  - temperature and environment;
  - supply;
  - test, where a pass names a passing S6 test run.
- **Qualifying.** Needs every check done, none failed, and pin-out and electrical passing.

**Revisions and cost.**
- **Release changes.** A release page shows what changed from the previous release: files changed, added or
  removed, and the BOM by reference designator (e.g. "U1: AP2112K → TLV75533").
- **Cost history.** Lists every committed sourced BOM's per-board cost, with the release that used it.
- **Price history.** Each part's price history is the best unit price at the build quantity on each day offers were
  observed.

**Supplier performance.**
- Each supplier's page shows, from the projects you are on:
  - RFQs invited, quoted, declined and awarded, and the median quoted lead time;
  - lots built, accepted and rejected;
  - the inspection defect rate;
  - on-time delivery, from the promised and delivered dates now recorded on each lot.

**S8 stage gate.** The S8 sign-off waits for a loaded BOM and no unresolved lifecycle cases.

Lifecycle data refreshes when sourcing is re-run, which needs distributor keys. There is no scheduled re-check yet.

```bash
pnpm --filter @vx/planning test   # part risk, price breaks and history, file and BOM diffs
./scripts/test-db.sh              # lifecycle_test: BOM loading, notices, cases, substitutes, decisions, S8 blockers
pnpm test:e2e:lifecycle           # browser: watch, EOL notice, case + qualified substitute, BOM change, supplier record
```

Screenshots: `docs/lifecycle/screens`.

## Mechanical checks

Project page → **Mechanical checks**. The calculations are in `@vx/mech`, with no model. Each input keeps its basis,
inputs that are assumptions rather than a supplier's or datasheet figure are counted, and an owner or reviewer
reviews each analysis with a note (saving changes clears it).

**Tolerance stacks.**
- **Contributors.** Each has a nominal, plus and minus tolerances, a direction (adds to or takes from the gap), a
  basis, and an "assumed" mark.
- **Results:**
  - the nominal gap;
  - the worst-case range;
  - the statistical range (root sum square, each tolerance taken as ±3σ, asymmetric tolerances shifting the mean);
  - each contributor's share of the variation.
- **Verdicts:** pass in the worst case, pass statistically only (most builds fit, some can interfere), or fail.
- **Stacks from the enclosure.** Built from the committed fit report:
  - board edge to enclosure wall;
  - tallest component to lid;
  - each edge connector's opening alignment.

  The enclosure tolerance is the loosest stated in any supplier's process rules for that process, named with the
  supplier and date; with no rules recorded, the typical template figure is used and marked as assumed. Board
  outline (±0.1 mm), thickness (±10%), screw clearance and placement tolerances are marked as assumptions to replace.

**Gaskets.**
- **What is checked.** O-ring or foam compression at the extremes (thinnest gasket in the deepest gap, thickest in
  the shallowest), and O-ring groove fill.
- **Limits.** Presets give typical design-guide limits (O-ring static face seal 15–30% with fill ≤ 85%;
  closed-cell foam 25–50%), labelled to be confirmed with the gasket supplier, or you enter your own.

**Thermal estimate.**
- **Inputs from the project.** The heat inside the box is the heaviest operating mode's input power from the
  committed power budget; the box size comes from the fit report.
- **Calculation.**
  - The internal air rise is power ÷ (h × outer surface area).
  - h defaults to 5 W/m²·K, a sealed-box rule of thumb, counted as an assumption.
  - Each converter's junction temperature is recomputed at the internal air temperature, using the θJA the
    budget used.
- **Limits.** It is a first-order estimate for a sealed box; confirm with a thermocouple on a prototype.

```bash
pnpm --filter @vx/mech test       # stacks by hand, gasket extremes and fill, thermal, starting points
./scripts/test-db.sh              # mechanical_test: save, review, edits clear review, roles
pnpm test:e2e:mechanical          # browser: enclosure stacks with supplier tolerance, gasket, thermal, review
```

Screenshots: `docs/mechanical/screens`.

## Database overview

`projects`, `project_members`, `documents`, `requirements`, `plans`, `tasks`,
`task_dependencies`, `decisions`, `approvals`, `runs`, `executions`, `artifacts`,
`artifact_versions`, `task_artifacts`, `validations`, `tool_capabilities`, `cost_events`,
`audit_events`, `project_invitations`, `project_messages`, `sources`, `source_chunks`, `standards`,
`project_standards`, `knowledge_editors`, `concept_rounds`, `concept_variants`, `design_freezes`, `manufacturers`,
`manufacturer_contacts`, `rfqs`, `rfq_attachments`, `rfq_recipients`, `rfq_quotes`, `flux_audits`, `flux_audit_files`, `file_scans`, `platform_settings`, `optimization_runs`, `proposals`,
`units`, `test_procedures`, `test_runs`, `test_measurements`, `test_evidence`, `faults`, `account_plans`, `accounts`, `project_intake`, `risks`, `stage_gates`, `trade_studies`, `process_rules`,
`releases`, `compliance_items`, `compliance_results`, `production_lots`, `lot_inspections`, `part_notices`, `project_bom_parts`,
`lifecycle_cases`, `substitutes`, `mech_analyses`, `ocr_jobs`, `modules`
(and `vx_private.secrets`, readable by no user), plus private `project-files` and `knowledge-files` storage buckets.

Built-in guarantees, each covered by `supabase/tests/schema_test.sql`:

- Project data is visible only to project members (row level security); clients never see runs, executions, costs, audit events or logs.
- Task status follows the spec §6 state machine; every change is written to `audit_events`.
- Task dependencies stay within one plan and cannot form cycles.
- Decisions are immutable; changes are recorded as new decisions that supersede old ones.
- Committed artifact versions are frozen.
- `claim_next_task()` hands out only tasks whose upstream work is complete, never twice.
- Worker leases, checkpoint resume, fenced commits, locks, budgets and run controls are covered by
  `supabase/tests/worker_test.sql`.
