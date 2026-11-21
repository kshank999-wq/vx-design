# VX Design — Master Development Specification v1.1

**AI electronic product development platform**

| | |
|---|---|
| Reference product | VC Smart Slate |
| Initial deployment | In-house, private |
| Stack | Vercel · Supabase · GitHub, with separate long-running engineering workers |
| Status | Merged working specification, 17 Nov 2026 (owner decisions and G4.5 recorded the same day). Architecture and plan, not evidence that any vendor API works or that any hardware design has passed professional validation. |

## 0. Document control

This document merges three sources. Where they disagree, §0.2 records how the conflict was resolved.

| Source | Date | What it contributes |
|---|---|---|
| *VC Web Engineering Platform Development Spec v0.1* | Nov 2026 | Plan-first execution, supervision modes, task contract, worker backbone, capability gate, platform build gates G0–G6, Flux import, MVP scope |
| *VX Design Master Development Spec v1.0* | 16 Nov 2026 | Product vision, product lifecycle stages, agents, knowledge system and standards registry, sourcing fallback policy, process library, manufacturer network and RFQ, Smart Slate subsystems, optimization engine, compliance and privacy, API contracts, backlog, owner checklist, metrics |
| `docs/ASSESSMENT.md` | Nov 2026 | Feasibility, SoM-carrier recommendation, fab package gate (G4.5), risks, costs |

Status markers used throughout: **Built** (implemented and tested in this repository), **Partial**, **Planned**, **Deferred**.

### 0.1 Naming: three different numbered sequences

v0.1 and v1.0 both use G-numbers for different things, and v1.0 and the assessment both use P-numbers for different things. This spec keeps them apart:

| Prefix | Meaning | Defined in |
|---|---|---|
| **S0–S8** | *Product stages*: the lifecycle the platform takes a customer's product through (v1.0's "G0–G8"). | §3.1 |
| **G0–G6, G4.5** | *Platform build milestones*: what we build, in order. These names are already used in code, tests, commits and README, so they are kept. | §3.2, §19 |
| **P0–P3** | *Backlog priority* of a deliverable (v1.0's meaning). The assessment's "P1 sourcing / P2 enclosure" phases become milestones M-SRC and M-ENC. | §19 |

### 0.2 Conflicts between the sources and how they are resolved

| # | Conflict | Resolution |
|---|---|---|
| 1 | v1.0 numbers product stages G0–G8; v0.1 numbers build gates G0–G6 (G0–G4 already built). | Product stages are renamed S0–S8 (§0.1). |
| 2 | v1.0 drops plan-first execution, supervision modes, task states, unattended runs, immutable decisions and Flux import. | Kept: they are the platform's core and already built (§7) or planned (§16). v1.0's agents run *as executors inside* that workflow. |
| 3 | v1.0 lists REST endpoints (`POST /projects` …). The built system uses Supabase RLS, SQL functions and Next.js server actions; v0.1 defers a public API. | v1.0's endpoints are adopted as **logical interfaces** (§18). They map to existing functions now. A public REST API stays deferred. |
| 4 | v1.0 starts every product with a concept mockup (S1). The platform has no image generation and uses one model provider (Claude, text only). | Owner decided: add an image-generation provider behind an adapter for concepts; CAD-model renders take over later (§9). |
| 5 | v1.0 mentions clients, supplier access windows and role-based access, which implies external users. v0.1 is in-house only, with multi-tenancy deferred. | Owner decided: clients get logins and a project workspace (§17.1, M-UI). Supplier roles come with M-RFQ. Billing and public sign-up stay deferred. |
| 6 | v1.0 has a 12–16 week plan; the assessment estimates 8–10 months for a useful in-house tool. | The roadmap (§19) is milestone-based with exit tests. The 16-week table is kept only as v1.0's own planning target, not a commitment. |
| 7 | v0.1 G4 passes on "aligned genuine **manufacturer** geometry" and "fit results". G4 as built uses KiCad library 3D models (generic package shapes), and there is no enclosure yet. | G4 is recorded as **Built, with two carried items**: manufacturer STEP per part (needs sourcing, M-SRC) and fit results (needs enclosure, M-ENC). |
| 8 | Sourcing: v1.0 has Nexar (primary), DigiKey and Mouser. v0.1 has Nexar and DigiKey. The assessment adds the JLCPCB/LCSC catalog. | v1.0's three-provider order is adopted. LCSC/JLC is added as an **assembly catalog** (basic/extended parts for JLC assembly), not a fourth distributor (§10). |
| 9 | v1.0 includes firmware, compliance and lifecycle (S6–S8) work. v0.1 defers manufacturing sign-off. | In scope as **tracking and packaging**: test plans, evidence capture, standards obligations, PCN/EOL watch. Never as certification (§15). Firmware generation is Deferred; firmware *architecture* tasks use design briefs today. |

## 1. Vision

Build an AI-assisted, beginner-friendly, engineering-grade platform that takes a physical electronic product through every stage:
- requirements and an industrial-design concept;
- architecture, PCB, firmware and the mechanical enclosure;
- prototype and supplier quotations;
- manufacturing handoff.

VX Design is broader than a PCB generator. It is a coordinated design-to-production workspace with a reusable, licensed knowledge base and a manufacturer network.

The differentiator is **spec → verified, orderable product, with an audit trail and open files**:
- a plan-first engine (v0.1);
- proven open engineering tools driven by the model (KiCad, Freerouting, ngspice, CadQuery/OCCT);
- deterministic checks on everything the model proposes;
- evidence attached to every decision;
- native, editable files.

**Reference implementation: VC Smart Slate.** It has:
- a 10-inch sunlight-readable touch display from an existing direct manufacturer relationship;
- a custom mainboard and a separate timecode subsystem;
- power and swappable batteries;
- CNC or printed enclosure parts;
- wireless, clapper sensing, firmware and production documentation.

Later testbeds are VC Composer external processing hardware and VC Film Studio sync boxes and monitors. The architecture must generalize to other electronic products.

## 2. Principles

1. **Plan first.** Ingest the specification, extract cited requirements and build a dependency plan. Get it approved, then execute bounded tasks under a chosen supervision mode.
2. **The model proposes; deterministic tools verify.** A result is committed only after checks pass, with evidence attached. Model output that is not checked is labelled "unverified assumption".
3. **Evidence for every engineering decision:**
   - identifiable sources and current datasheet revisions;
   - calculations, simulation and CAD checks;
   - hardware tests;
   - human design review.
4. **Separate gates.** ERC, DRC, mechanical interference, BOM validation and manufacturing readiness are separate. No single gate proves a product is ready.
5. **Visual concept early, after a short feasibility and safety pre-check.** The client approves appearance and high-level requirements before detailed engineering.
6. **Reuse modules and dev boards** when they beat custom work on cost, schedule, power, size, certification or risk. For the Smart Slate mainboard, the default is a SoM carrier (assessment §3.3).
7. **Primary plus two fallback providers** per integration category, where genuinely independent, licensed providers exist. Otherwise disclose the gap and provide a manual or file-based fallback (§10, §11).
8. **Optimize on the full objective set:**
   - power, area, mass and thermal margin;
   - reliability and repairability;
   - assembly labor and tooling;
   - lead time and cost at the expected volume.
   
   Hard constraints (safety, function, certified-component limits) are never traded away.
9. **Beginner and expert modes.**
   - Beginner mode explains tradeoffs.
   - Expert mode exposes schematics, nets, constraints, calculations and approval checkpoints.
10. **Nothing fabricated.** Never invent:
    - part numbers, ratings, quotes or prices;
    - supplier contacts or certifications;
    - placeholder CAD images.
    
    Unsupported operations are labelled as such and blocked, not simulated.
11. **Privacy and IP.** Customer IP is private by default. No shared-model training on proprietary projects without explicit opt-in. Retrieved web pages and PDFs are untrusted content, never instructions.
12. **Open files, no lock-in.** KiCad native files are the electrical system of record (ADR 0001). STEP files are the mechanical exchange format.

## 3. Stages and milestones

### 3.1 Product stages (what a customer's product goes through) — from v1.0

| Stage | Phase | Outputs / acceptance | Platform support today |
|---|---|---|---|
| S0 | Project intake & feasibility | Intended use, region, quantity, target cost, dimensions, battery/radio needs, risk register, target standards; high-risk or infeasible requirements flagged | **Built**: spec intake with cited requirements and ambiguity flags; intake facts; deterministic feasibility check filing cited, scored risks; risk register; S0 sign-off; a guided requirement wizard (six steps of plain questions → intake facts and draft requirements with acceptance criteria and their basis, repeatable without duplicates). |
| S1 | Concept & industrial design | 2D render or moodboard, 3D cosmetic mockup, rough internal envelope, colour and material options, customer sign-off | **Built** for generated concepts and the design freeze (§9); CAD-based mock-ups later |
| S2 | System architecture | Block diagram, module-vs-custom comparison, interfaces, power budget, preliminary mechanical stack, tentative BOM | **Built**: architecture and mechanical briefs, power calculator, sourced BOM, trade studies (weighted criteria, catalog-filled part data, sensitivity, decision with evidence). |
| S3 | Detailed design | Schematics, verified symbols and footprints, PCB layout with DRC and ERC, firmware architecture, MCAD assembly, harness drawings, thermal checks | **Partial**: schematic + ERC (G3), PCB + DRC + 3D (G4). MCAD is M-ENC; tolerance stacks, gasket and thermal checks are built (Mechanical checks). Firmware architecture uses briefs. |
| S4 | Sourcing & DFM | Approved vendor list, sourced BOM with alternates, stackup, placement and export files, manufacturing constraints | **Built**: sourced BOM (M-SRC), fab package (G4.5), approved vendor list (M-RFQ), manufacturer process rules and manufacturing-fit checks of the committed board and enclosure |
| S5 | Prototype packages & RFQs | Manufacturer-specific STEP/STL/DXF/Gerber/ODB++/IPC-2581, BOM/CPL, drawings, tolerances, inspection plan, NDA and RFQ packets | **Partial**: fab package (G4.5), NDA/RFQ packets with disclosure approval (M-RFQ), process-rule fit per supplier built; IPC-2581, ODB++, IPC-D-356 and DXF exports, each read back and checked against the board, and inspection plans (bare board, PCBA, enclosure) drafted from the fab check and fit report, approved, versioned, exported as CSV and linked to production lots, built |
| S6 | Build & validation | Incoming inspection, bring-up, test logs, fault corrections, firmware validation, fit and finish, environmental tests | **Built** (evidence capture): units traced to the fab package; versioned test procedures drafted from requirement limits and approved by a reviewer; immutable runs with conditions, calibrated equipment, measurements and attachments, pass/fail computed from the approved limits; faults opened by failures and closed only by a passing retest; requirement verification matrix. Firmware and environmental test execution stay manual. |
| S7 | Compliance & production | Lab and regulatory assessment, pilot run, production test jig, revision lock, QC and traceability, released files | **Built** (tracking only, never certification): compliance items suggested from the intake (markets, radios, power, use) with lab results that keep the report file and tested revision; releases that lock a revision's files and checksums after a readiness check (owner, with a written waiver for blockers); pilot and production lots from the current release with serial-numbered units, an approved production-test procedure, sampling-plan inspections and acceptance rules, yield; serial-number traceability; S7 gate blockers. |
| S8 | Lifecycle | PCN and EOL tracking, redesign impact, substitute qualification, revisions, vendor performance, cost history | **Built**: BOM parts watched with a calculated risk and reasons (lifecycle, notices, stock against need, distributor count, price change); sourced PCN/EOL/LTB notices shared across projects, automatic notices on catalog lifecycle changes; lifecycle cases with impact assessment and resolutions recorded as decisions; substitute qualification checklist with a basis per check and a passing test run for the test check; release-to-release file and BOM changes; BOM cost history; supplier performance from RFQs, lots, inspections and delivery dates. No scheduled re-check of distributor data yet (needs keys and a worker). |

Each task carries a `stage` alongside its `discipline` (default from the discipline, editable in a draft plan). Stage sign-off is an approval gate: with stage gates on, later stages' tasks wait for it (**Built**; see README "Stage gates and the risk register").

### 3.2 Platform build milestones (what we build) — from v0.1, extended

| Milestone | Deliverables | Pass condition | Status |
|---|---|---|---|
| G0 — API audit | Capability matrix, sample projects, licence and hosting notes | Each proposed integration has a real test or a documented blocker | **Built** (`docs/g0/capability-matrix.md`) |
| G1 — Plan engine | Upload → cited requirements → task DAG → approvals | Smart Slate spec produces a stable, editable plan with cited requirements | **Built**, tested with a sample spec. **Project inputs** added: several specs extracted together (cross-document duplicates flagged), mock-ups and prior-design files as numbered references, Flux audits as prior work; parts already chosen with their datasheets and STEP models; an earlier-work register read from every prior design document and corrected by people; the plan is generated from all of it, must address every committed earlier-work item, and each task states whether it reuses, adapts, replaces (with concerns and alternatives) or starts fresh, citing the inputs. The formal pass needs the real Smart Slate spec and an API key. |
| G2 — Worker backbone | Durable queue, logs, checkpoints, budgets, locks | Browser may close; an authorized run resumes with no duplicate committed work | **Built** |
| G3 — First circuit | Component evidence, editable schematic, ERC report | A simple test sub-board opens and checks in KiCad | **Built**: KiCad CLI checks pass; the desktop app is untested. Tested with a fixture circuit; a real design needs an API key. |
| G4 — PCB + 3D | Board, DRC, STEP, 3D, fit results | Native PCB, zero unwaived DRC errors, matches the schematic, 3D visible | **Built**. Manufacturer STEP per part comes from the verified model library (§10.1); fit results come from M-ENC |
| G4.5 — Fab package | Gerbers, drill, CPL, fab BOM per fab profile, KiKit panel, fab ZIP, fab and assembly drawings | **Order the board, assemble it and test it** | **Built**: package checked independently of KiCad. The physical order needs a real design (API key) and LCSC numbers for assembly (M-SRC). |
| M-SRC — Sourcing & power | Nexar/DigiKey/Mouser adapters with fallbacks, LCSC assembly catalog, BOM resolve and alternates, manufacturer 3D model library (§10.1), deterministic power-tree calculator | Smart Slate BOM and power budget usable with real timestamps | **Partial**: distributor adapters, fallback chain, BOM resolution, catalog and LCSC-to-fab built and tested with fixtures and documented response shapes; no live call yet (no keys). Power calculator built (model-proposed tree, deterministic checks, repair loop). Manufacturer 3D model library built (upload, URL, Nexar CAD candidates; automatic alignment check; human verification; used by layouts). Remaining: live keys. |
| M-KB — Knowledge base | Source registry, licensing controls, standards registry, retrieval with citations | Searches return official URLs, edition and licence flags, and citations | **Built**: source registry with licensing rules enforced in the database, cited excerpts, standards registry (spec references, editions unconfirmed until reviewed), per-project applicability with confirmation, project-private licensed copies, full-text plus identifier search, chat citations. Also built: fetching from the official link with SSRF guards and change detection (changed documents re-indexed and returned to draft), OCR of scanned PDFs by the worker (Tesseract, marked as OCR text), modules catalog with sourced certifications. Not yet: vector search (needs an embedding provider). |
| M-ENC — Enclosure & fit | CadQuery enclosure from board STEP, interference and fit report, process rules, STEP/STL/drawings | A 3D-printed housing fits the real assembled board | **Built** (model-designed housing, per-part interference against the board's 3D models, process rules, STEP/STL/GLB/drawings). The physical exit test needs a real board. |
| M-CON — Concept | S1 workflow: concept variants from an image-generation provider, envelope, design freeze | The client selects a concept and records a design freeze | **Built**: Claude brief from requirements and direction, Gemini ("Nano Banana") and OpenAI image adapters plus an offline placeholder, rounds and refinement from a chosen variant, provenance per image, design freeze recorded as a decision with change control, workspace checklist step. Live image generation untested until a key is set. |
| M-UI — Client workspace | Project workspace with chat, live checklist with approval stops, and a central viewer; client logins (§17.1) | A client signs in, talks to the project in a running chat, watches the checklist, approves at a stop, and sees outputs in the viewer | **Built**: client role, invitations, staff-only RLS on runs/executions/costs/audit/logs, workspace (chat, centre viewer, live checklist with approval stops), Claude assistant grounded in the project with an offline summary fallback. Streamed replies and plan changes proposed in chat (drafted by staff as a new plan version, approved like any plan) built. Not yet: email delivery of invitations. |
| M-RFQ — Manufacturers & RFQ | Manufacturer CRM, NDA/RFQ packet generator, disclosure approvals | An approved request produces complete attachments and an audit log | **Built**: directory with candidate → verified → approved vendor states and "verify contact"; §12 manifest with completeness checks; reproducible supplier-neutral packet (cover letter, manifest, NDA template, chosen requirements and committed files, checksums); owner approval bound to the packet hash; supplier portal with access windows, quotes and decline; award recorded as a decision; full audit trail. Not yet: email sending, structured quote adapters for vendor portals, quote currency conversion, process-rule matching. |
| G5 — Smart Slate Flux audit | Flux import and revision trace | Actionable migration plan, verified vs unknown | **Built**: import of Flux exports (project JSON, EDIF, IPC-D-356, Gerbers, BOM, placement, STEP, chat/report exports) per revision; inventory and missing dependencies; cross-export consistency and schematic-vs-layout connectivity; current-state map; revision comparison with undone changes; quoted decisions and claims (always unverifiable); migration plan. Tested on a synthetic export; the formal pass needs the real Smart Slate Flux export. |
| G6 — Hardening | Security, recovery, regression fixture suite | Repeat runs give traceable, consistent results | **Built**: security lint over the whole schema (found and fixed anon grants, two ID-based leaks, client access to RFQ/Flux storage, forgeable assistant messages); tamper-evident audit hash chain; upload inspection and ClamAV scanning with storage-level blocking; CSP and headers; secret scan and CI; lease recovery for every job type, integrity check, backup/restore drill; regression suite (repeatable and unchanged, with input and version tracing) including a KiCad tier. See `docs/SECURITY.md`. |

## 4. Scope

**In scope for the in-house MVP:** everything marked Built, plus G4.5, M-SRC, M-KB, M-ENC and G5.

**Deployment:** prepared and tested locally (docs/DEPLOY.md): email confirmation, uploads staged in storage (no web-server body limit), database deploy script, worker images and Compose file, smoke check. Hosted Supabase and Vercel are set up; the worker host is waiting for an in-house machine. **Accounts:** per-account plans and quotas (projects, active runs, concurrent tasks, monthly AI/compute allowances, concept rounds) and fair queueing across accounts. Billing (Stripe) is still deferred.

**Deferred:**
- public multi-tenant SaaS, Stripe billing, transactional email (Resend), a public REST API and a marketplace;
- full browser CAD editing parity with Flux;
- advanced autorouting guarantees (high-speed, impedance-controlled, DDR, SDI);
- wireless-video RF design automation;
- firmware code generation;
- automated ordering, NDA signing or outbound email without explicit per-action authorization;
- any claim of certification or manufacturing sign-off.

## 5. Architecture

| Layer | Implementation | Responsibility | Status |
|---|---|---|---|
| Web UI | Next.js 16 / TypeScript on Vercel | Spec upload, plan and approvals, run controls, engineering viewers, reports | **Built** (G1–G4 views) |
| Identity & data | Supabase Auth + Postgres + RLS | Private access, task state, decisions, permissions, audit | **Built** |
| Artifacts | Supabase Storage + version metadata (sha256, tool version and config) | Specs, native files, BOMs, STEP/GLB, reports | **Built** |
| Orchestrator | Durable worker service on Postgres (leases, heartbeats, fenced commits, locks, budgets) | Task execution, retries, checkpoints, overnight runs, reports | **Built** (G2) |
| AI gateway | Provider-neutral model adapter (Claude by default; offline stand-in for tests) | Extraction, planning, design proposals, structured outputs | **Built** |
| Engineering workers | Docker image: KiCad 10, Freerouting, KiKit, CadQuery, ngspice, SKiDL; plus `vx_eng` | Schematic, PCB, DRC/ERC, 3D, exports; later enclosure and simulation | **Built** for schematic and PCB |
| Knowledge store | Postgres catalogs + pgvector + Storage, licence-aware | Sources, standards, parts, offers, modules, manufacturers, process rules | **Built** except vector search: sources (fetched or uploaded, OCR for scans), excerpts, standards, project standards, parts and offers, modules, manufacturers and process rules; full-text search (pgvector pending an embedding provider) |
| Source control | GitHub | Code, migrations, rules, fixtures, CI | **Built** (CI: `.github/workflows/ci.yml`; nightly e2e: `e2e.yml`) |

Constraints:
- Vercel handlers never host long CAD jobs. Workers do.
- Supabase is the system of record, with the queue implemented in it (`claim_next_task` with `SKIP LOCKED`).
- Workers advertise the disciplines they can run, and a run reports when no online worker can do the remaining work.

AI usage is selective:
1. Parse requirements.
2. Retrieve a small, attributable set of references.
3. Call deterministic CAD and calculation functions.
4. Inspect exceptions.
5. Ask for human review.

Measure token cost, retrieval latency, CAD execution time, supplier requests and false-confidence incidents. Cache embeddings and stable facts; never cache volatile stock or prices as if they were live.

## 6. Agents and engineering engines

v1.0's agents are implemented as **executors**. Each handles one or more task disciplines inside the plan-first workflow. They do not run as free-running autonomous agents.

| Agent (v1.0) | Responsibilities | Required evidence / checks | Executor today | Status |
|---|---|---|---|---|
| Orchestrator | Sequence stages, assign tasks, dependencies, approvals, tool calls | State machine, audit, retries, cost ceiling | Worker + SQL state machine | **Built** |
| Knowledge agent | Retrieve standards, licensed references, datasheets, vendor rules | Citations, edition dates, source permission, uncertainty | Datasheet text-match evidence only | **Partial** (M-KB) |
| Industrial design agent | Concept renders, manufacturable style variants | Concept images clearly distinguished from valid CAD | Claude brief + image provider | **Built** (M-CON) |
| Systems engineer | Block diagrams, requirement allocation, trade studies | Requirement traceability, interface contracts | Design-brief executor (architecture, components, power, thermal, mechanical, enclosure, documentation) | **Partial** |
| EE/PCB agent | Circuit planning, schematic and PCB via CAD adapters | ERC, DRC, netlist and parity checks, simulation, reviewer sign-off | `kicad-schematic`, `kicad-pcb` | **Built** (simulation planned) |
| Mechanical/DFM agent | Enclosure, datums, clearances, mounts, gasket, heat, finish | Tolerance stacks, process-specific DFM | `enclosure` executor, `@vx/mech` | **Built**: housing, fit and process rules; tolerance stacks (worst case and RSS, contributions, starting stacks from the enclosure with supplier tolerances), gasket compression and groove fill, first-order enclosure thermal estimate from the power budget; reviewed per analysis |
| Firmware agent | MCU selection, drivers, protocols, testing | CI, hardware-in-the-loop, security review | Briefs only | Deferred (generation) |
| Supply chain agent | BOM/AVL normalization, quotes, alternates | Price timestamp, MPN identity, fit/function check | `sourcing` executor | **Partial** (no live keys yet) |
| Manufacturing agent | Route work to process suppliers, generate RFQs | Feasibility, owner approval | — | Planned (G4.5, M-RFQ) |
| Compliance agent | Applicable regions, tests, documentation | Human-certified expert or lab decision, recorded results | — | Planned (tracking only) |

**Learning.** The platform does not "learn" from projects automatically. Explicit feedback ingestion (reviewed design changes, test outcomes, approved supplier ratings) enriches private retrieval data. Reviewer return notes already feed the next attempt of a task. Shared model improvement is a separate, opt-in, governed process.

## 7. Plan-first workflow and execution — from v0.1 (Built)

1. **Intake.** Upload DOCX, PDF or text and keep a checksum. Requirements are extracted with citations to source blocks, plus ambiguity notes. *(Built)*
2. **Clarification.** Classify ambiguity, constraints, interfaces, measurable acceptance tests and open decisions. *(Partial: ambiguity and open questions are captured; there is no wizard yet — v1.0 P0.)*
3. **Planning.** A dependency DAG covering:
   - architecture;
   - power and enclosure envelope;
   - schematic;
   - stackup and layout;
   - detailed power and thermal;
   - mechanical fit;
   - verification and outputs.
   
   Each task has requirement links, acceptance tests, risk and an approval policy. *(Built)*
4. **Plan approval.** Review, edit and approve. The approved baseline is frozen and versioned. *(Built)*
5. **Execution.** A worker claims one ready task, loads approved upstream artifacts, calls allowed tools, writes scratch versions and validates them. *(Built)*
6. **Commit.** Outputs are promoted atomically when checks pass and sign-off is not required. Otherwise the task fails or blocks with a bounded retry history. *(Built)*
7. **Change control.** A new decision triggers impact analysis: only affected tasks are invalidated, and unaffected evidence is kept. *(Planned)*
8. **Reporting.** In-app completion report: outputs, checks, recoveries, approvals, spend, next steps. *(Built)*

**Task contract.** Each task stores:
- id, discipline, upstream tasks and input artifact versions;
- required tools, acceptance tests, approval policy and risk;
- status, assigned worker, attempts, timeout and cost budget;
- outputs, validation evidence, decisions, timestamps and blocker reason.

v1.1 adds a `stage` (S0–S8).

**Task states:** draft → ready → running → validating → awaiting_approval → complete. Alternative outcomes are blocked, failed, canceled and superseded. Every transition is logged.

**Concurrency.** Tasks run in parallel only on immutable inputs, with per-artifact write locks.

**Supervision modes** *(Built)*:

| Mode | Default behaviour | Mandatory boundaries |
|---|---|---|
| Guided | Explains decisions; asks for approval on significant component, board, power or mechanical changes | Never implies that user review is professional validation |
| Professional | Roadmap plus chosen decision classes are approved; routine tasks advance automatically | Failed checks, major deviations and budget breaches are always surfaced |
| Autonomous | Runs the approved scope unattended, with budgets, retries and checkpoints | Stops the affected branch on safety-critical uncertainty or out-of-scope architecture; independent work continues |

These always need approval: processor family, battery chemistry or charger architecture, PCB dimensions or stackup, major connector reassignment, and a BOM increase over the user's threshold. Passive substitutions within approved ratings and budget may proceed.

**Beginner and expert presentation (v1.0)** is a display setting, separate from supervision mode:
- Beginner mode adds plain-language explanations of each tradeoff and checkpoint.
- Expert mode shows nets, constraints, calculations and raw reports.

*(Planned. Today's UI is expert-leaning.)*

## 8. Knowledge system — from v1.0 (M-KB: core built)

**Storage:**
- Postgres is the system of record.
- pgvector holds embeddings of *licensed* excerpts.
- Storage holds approved source files.
- GitHub holds schemas, adapters and rules.

Retrieval-augmented generation is used, not fine-tuning, for v1.

**Catalogs**, with existing tables marked:

| Catalog | Core fields | Relation to today's schema |
|---|---|---|
| sources | id, title, publisher, official_url, license, acquisition_method, document_version, last_verified_at, access_level | **Exists** (`sources` + `source_chunks`; `project_id` null = shared library, set = project-private). `documents` still holds project specifications. |
| standards | identifier, issuing_body, edition, region, product_scope, purchase_link, licensed_excerpt_location, review_status | **Exists** (`standards`, seeded; applicability per project in `project_standards`) |
| parts | manufacturer, normalized_mpn, function, package, lifecycle, ratings, footprint ref, datasheet version | New. The schematic evidence report holds this per design today. |
| offers | supplier_id, part_id, qty_breaks, currency, MOQ, stock, lead_time, observed_at, terms | **Exists** (M-SRC: `offers`, plus `parts` and `part_models`) |
| modules | module/board id, interfaces, supply, performance, dimensions, CAD, support status | New |
| manufacturers | legal name, country, processes, contacts, certification evidence, NDA method, file specs, lead times | **Exists** (`manufacturers`, `manufacturer_contacts`; RFQs in `rfqs`, `rfq_attachments`, `rfq_recipients`, `rfq_quotes`) |
| process_rules | process, material, capability envelope, tolerances, thickness, finish, verified_at | New. Starts from `vx_eng/fab.py`'s fab profiles. |
| requirements | project, constraint, priority, acceptance test, provenance, approval status | **Exists** (with citations) |
| design_revisions | project, rev, CAD artifacts, suppliers, results, sign-offs | Covered by `plans`, `artifact_versions`, `approvals` and `audit_events`. A release/revision view is planned. |
| test_results | prototype serial, rev, procedure, conditions, measurement, limit, pass/fail, attachment | Exists (S6): `units`, `test_procedures`, `test_runs`, `test_measurements`, `test_evidence`, `faults` |

**Licensing rules:**
- A URL is not permission to download, republish or train on a document.
- Index excerpts only where the licence and API terms allow.
- Otherwise store metadata plus a pointer to the user's licensed copy.

**Standards registry.** These are starting identifiers, not proof of applicability. Every entry tracks edition, applicability, licence status and reviewer verification.

| Domain | Starting references |
|---|---|
| PCB design & current | IPC-2221/2222/2223/2226, IPC-2152, IPC-2141, IPC-7351/7352 |
| Fabrication & assembly | IPC-6012/6013, IPC-A-600, IPC-A-610, J-STD-001, IPC-2581 |
| Soldering & materials | IPC-4101, J-STD-033, J-STD-004/005/006, IPC/WHMA-A-620 |
| Electrical safety | IEC/UL 62368-1; IEC 61010-1 where appropriate; IEC 60529 |
| Battery | IEC 62133-2; UL 2054/1642 as applicable; UN 38.3 |
| EMC / radio | FCC 47 CFR Part 15; EU EMC/RED; CISPR and IEC 61000 series |
| Environmental | EU RoHS (2011/65/EU as amended), REACH, WEEE, applicable state rules |
| Mechanical material | ASTM methods, ISO material standards, IEC 60695, UL 94 |
| Manufacturing QA | ISO 9001, ISO 2768, ISO 286, ASME Y14.5 |
| RF / connectivity | Bluetooth SIG, IEEE 802.11, USB-IF |

Publishers: ipc.org, iec.ch, iso.org, astm.org, ul.com, fcc.gov, bluetooth.com, usb.org, echa.europa.eu. Check edition and normative status with each body.

**Design resources:**
- Tools: KiCad (libraries under their licence terms), FreeCAD, OpenSCAD, Autodesk Fusion API, Onshape API.
- Vendor references: TI, ADI, ST, Microchip, Nordic, Espressif, Raspberry Pi, Arduino. Use their application notes, evaluation boards, reference schematics, calculators, SPICE models and PCNs.

A community footprint or 3D model is never trusted until its geometry and pad mapping are verified against the datasheet. Today `vx_eng` checks pin-to-pad coverage and courtyards; a dimension check against the datasheet is planned with the parts catalog.

## 9. Concept and industrial design (S1) — from v1.0 (M-CON: built)

- **Inputs:** approved feasibility pre-check (S0), target envelope, display and battery choices, brand and material preferences.
- **Outputs:** 2–4 concept variants (moodboard or renders), rough internal envelope, colour and material options, annotated decisions, client sign-off and a recorded **design freeze**.
- **Rendering** (owner decision, 17 Nov 2026):
  - **Early concepts come from an image-generation provider** behind a provider-neutral adapter, the same pattern as the
    model gateway: `generateConcept(prompt, references, n)` returns images plus provider, model, prompt and seed. Candidates
    are Google's Gemini image model ("Nano Banana") and OpenAI's image API. Each needs its terms, data-sharing and
    pricing reviewed before use, and keys are stored as worker secrets. The owner has used ChatGPT and Claude Design
    for concepts; Claude itself does not generate images, so a second provider is required.
  - **Later mock-ups come from the CAD 3D model**: board STEP plus enclosure (M-ENC), rendered from the CAD viewport
    (KiCad `pcb render`, CadQuery/three.js, Blender automation as fallback). These replace the generated concepts as the design
    matures.
  
  Every generated image is labelled **"concept, not CAD"** and is never used as engineering geometry. Generated images,
  prompts and references are stored as artifacts with their provenance.
- The design freeze becomes an approved decision that S2+ tasks depend on. Changing it triggers change control (§7).

**Built (18 Nov 2026):**
- A member (owner, engineer or client) asks for a round of 1–4 variants with a direction, or refines a variant. At most
  2 rounds run at a time and 12 a day per project, because image generation is paid.
- A worker with an image key takes the round. Claude writes the brief from the requirements, the direction, the variant
  being refined and the current freeze: per variant a name, design language, rationale, colours/materials/finishes and
  an image prompt (studio three-quarter render; no text, logos, brands, people or imitation of real products), plus a
  rough envelope with its basis. The image provider renders each prompt; a refinement sends the chosen variant's
  image as the reference. A variant the provider declines is recorded with the reason; the rest still count.
- Images are stored in the project's folder with the prompt, provider, model, seed, any rewritten prompt, references,
  usage and the provider's watermark notice (Gemini adds SynthID). Every image is labelled "concept, not CAD".
- Providers: Google Gemini image (`gemini-nano-banana-2.1` by default) via generateContent, and OpenAI GPT image
  (`gpt-image-2.5-sunburst` by default; `gpt-image-1` was shut down in Oct 2026) via images/generations and
  images/edits. Both follow the published API references (checked 18 Nov 2026) and are untested live until a key is
  set. `VX_IMAGES=fixture` draws labelled placeholders for development and tests.
- Owners, reviewers and clients freeze a variant with the envelope (L × W × H mm) and CMF. The freeze is a `mechanical`
  decision citing the image's hash; a later freeze needs a reason and supersedes the earlier decision.
- The workspace checklist starts with "Concept and design freeze", the centre shows the concepts, and the chat knows
  the rounds and the freeze.
- Not yet: S2+ tasks reading the frozen envelope automatically (the enclosure task still takes its size from the board),
  CAD-based mock-ups, uploading reference images (sketches, mood images) from the client.

## 10. Sourcing and three-provider fallback — from v1.0 (Partial, M-SRC)

| Priority | Provider | Capability | Action |
|---|---|---|---|
| Primary | Nexar (Octopart data) | GraphQL catalog, inventory, distributor offers | Request access; confirm caching and display terms |
| Fallback A | DigiKey | Product info, quotes, orders, change notices | Developer credentials and quotas |
| Fallback B | Mouser | Search, cart, order | Key; rate limits and terms |
| Assembly catalog | JLCPCB/LCSC | Basic/extended parts for JLC assembly; LCSC numbers in the fab BOM | Needed for G4.5 assembly orders |
| Custom parts | Direct manufacturer workflow | Displays, batteries, custom cables | RFQ (§12) |

Nexar is the API platform for Octopart data, so the two are not separate fallbacks.

**For every search:**
- Normalize manufacturer and MPN, and record substitutions and discrepancies.
- Refresh volatile stock and prices.
- Compare landed cost: shipping, duty, tax, MOQ and assembly.
- Flag single-source risk.
- Label each value **live / cached (timestamp) / estimate**. An old offer is never shown as a current price.

**Distributor experience:**
- Catalog parts show the exact MPN, approved variants, distributor, price breaks, availability date, region, datasheet and purchase link.
- A saved cart or draft PO is created where supported. Purchasing is always human-authorized.

### 10.1 Manufacturer 3D model library (owner decision, 17 Nov 2026)

A database of manufacturer 3D models, filled per project:
- for each sourced MPN, fetch the manufacturer's STEP (manufacturer site first, then licensed library providers such as
  SnapEDA, Ultra Librarian or SamacSys, each with its licence recorded), store it once per part with its sha256, source and
  licence, and link it to every project that uses the part;
- keep the manufacturer's mechanical data with it (package drawing dimensions, mounting and keep-out notes, connector mating
  side), so placement and enclosure work integrate the part per its specification;
- check the model against the footprint (pad-to-model overlay, body height against the datasheet) before it replaces
  KiCad's generic model; until then the generic model stays and the 3D model report says which is used.

This closes G4's carried item (manufacturer geometry) and feeds the enclosure fit work (M-ENC).

**Status (built):** models are added by upload, URL or Nexar CAD link. They are private per project unless
shared. The KiCad worker checks each one by matching terminals to pads in all 24 orientations (aligned STEP,
overlay, measured body, datasheet height), and a person verifies the result. Verified models replace generic
ones in layouts and ship inside the KiCad project. The pad-to-model alignment convention is tested through
KiCad's own STEP export.

**Power planning** (assessment §3.4) ships with M-SRC as deterministic math, not model guesswork:
- power tree, per-rail budgets, regulator dissipation, thermal estimate, battery runtime, inrush and sequencing;
- ngspice where vendor models exist.

## 11. Adapters, capability gate and simulation — v0.1 §4 + v1.0 §9

No integration is assumed to work because a product exists. Desktop scripting, CLI automation, file exchange and cloud REST APIs are different integration methods. Each adapter records:
- supported operations, version, auth and quotas;
- deployment mode and licence;
- sample input and output, errors and fallback;
- test owner and verification date.

An adapter may not claim a function until it passes contract tests. Status lives in `tool_capabilities` and `docs/g0/capability-matrix.md`.

| Capability | Primary | Fallbacks | Status |
|---|---|---|---|
| Electrical CAD | KiCad 10 files + CLI + pcbnew scripting | Fusion Electronics API; Altium via Nexar design data (licence) | **Built** (IPC API blocked in G0) |
| Autorouting | Freerouting (2-layer, low speed) | Human routing in KiCad for critical nets | **Built** |
| Mechanical CAD | CadQuery / OCCT scripted workers | FreeCAD, OpenSCAD; Fusion API, Onshape API (commercial terms TBD) | Verified in G0; executor planned |
| Circuit analysis | ngspice | LTspice where automation is licensed; vendor simulators | Verified in G0; executor planned |
| Design data | Manufacturer schematics, SPICE, IBIS, STEP | Authorized library providers; reviewed manual import | Planned |
| Rendering | KiCad render/GLB; three.js | Blender; external image generation for concepts only | **Built** for boards |
| Manufacturing quotes | Structured RFQ adapters | Vendor forms or email; manual portal upload | Planned |
| Collaboration / storage | Supabase | GitHub revision store; customer-approved offline exports | **Built** |

The **three-options policy** is a procurement goal. If three usable providers do not exist, say so and give a manual or file-based fallback. Never invent integrations.

## 12. Mechanical, processes, manufacturers and RFQ — from v1.0

**Process library.** Each process profile records:
- materials, drawing formats, tolerances and minimum features;
- maximum envelope and lead time;
- inspection evidence, quote method and volume breakpoints;
- restrictions.

Profiles start from published supplier DFM data (e.g. JLCPCB capabilities, Protolabs moldability toolkit). Written supplier data replaces assumptions as it arrives. Each profile has a `verified_at` date.

| Process | Typical use | Key rules to capture |
|---|---|---|
| FDM / SLA / SLS / MJF printing | Early fit, ergonomics, nylon parts | Orientation, minimum wall, clearances, anisotropy, finish, inserts |
| CNC aluminium / plastic | Precision U-frame, heat spreader, small runs | Corner radii, tool access, datums, fixtures, tolerances |
| Sheet metal | Frames, brackets, panels | Bend radii, K-factor, relief, flat pattern, fasteners, finish |
| Injection molding | Production shells, buttons | Draft, uniform wall, ribs and bosses, gates and ejectors, shrink, tooling |
| Silicone / rubber | Seals, grips, keypads | Durometer, compression set, draft, adhesion, chemical compatibility |
| Over/insert molding | Seals, captive fasteners | Material compatibility, insert retention, sequence |
| Wood / laminate / coating | Clapper sticks, appearance parts | Moisture, finish durability, adhesives, variation |
| Cable harness | Internal power and data | Bend radius, strain relief, pinouts, lengths, continuity test |

Build order: 3D print and CNC first (M-ENC). **Manufacturing routes** (built) record each part's prototype and production process and material, rank prototype materials, export a 3D-printing pack, and feed the plan and the enclosure design. **Assembly instructions** (built): drafted, checked, edited, approved and exported work instructions for the final assembly. **Injection molding** (built): material rules, an STL design check (draft, undercuts, walls, clamp, shot), a molding spec per part and the mold maker's package. The generated enclosure is drafted for molded parts. Not yet: gate and parting-line proposals, warp or fill simulation, and a quote request for the mold sent through RFQs.

**Manufacturer network.** The target is ten *candidate* suppliers per category. These are research targets, not pre-vetted partners:
- bare PCB;
- PCBA/SMT and test;
- sheet metal and finishing;
- CNC;
- printing and urethane casting;
- injection molding and tooling;
- silicone and overmolding;
- displays and optical bonding;
- battery packs, BMS and testing;
- harnesses and flex cables;
- finishing, packaging and final assembly;
- compliance and environmental labs.

Initial discovery list (not endorsements): JLCPCB, PCBWay, Seeed Fusion, Protolabs, Xometry, Hubs. Legal identity and process matrices are confirmed before a supplier enters the approved vendor list.

**RFQ for custom parts:**
- Recommend manufacturing classes and *verified* manufacturers.
- Prepare a contact sheet, an NDA template (for legal review), a cover letter, specs, drawings and acceptance criteria.
- A contact without a confirmed email is marked **"verify contact"**, never guessed.
- Every outbound disclosure and purchase needs the owner's explicit approval, recorded in the audit log.

**RFQ manifest:**
- project code, buyer and supplier;
- classification, forecast, prototype and production quantities;
- materials, critical-to-quality dimensions, drawing revision, 3D files and finish;
- standards, compliance, tests and inspection;
- tooling ownership, shipping terms, response deadline and quote breakdown;
- NDA status and permitted sharing scope.

**Built (18 Nov 2026, M-RFQ):**
- **Directory.**
  - Suppliers move from candidate to verified (legal identity, country and processes recorded, with evidence) to
    approved vendor (library editors only).
  - Editing a verified supplier's identity resets it to candidate.
  - Contacts stay "verify contact" until the email's confirmation is recorded.
- **RFQs.**
  - The manifest above is checked for completeness in the database.
  - Disclosure is explicit: the sharing scope, the chosen requirements and the chosen committed files.
  - The packet is reproducible and supplier-neutral, and its NDA template is marked for legal review.
  - The contact sheet stays internal.
- **Approval and release.**
  - The owner's approval is bound to the packet's sha256 and the supplier list. Any change drops it.
  - Release opens per-supplier access windows. Email is sent by the owner.
  - Suppliers sign in with the confirmed contact address to download, quote, revise or decline.
- **Award.** Choosing a quote closes access and is recorded as a `manufacturing` decision. The order itself happens
  outside VX Design.
- **Not yet:**
  - recommending manufacturers by process rules (today: a category filter);
  - structured adapters for vendor quote portals;
  - currency conversion;
  - sending email.

## 13. Smart Slate pilot

| Subsystem | Early decision / investigation | Evidence required | Platform path |
|---|---|---|---|
| Display / touch | Existing direct touchscreen OEM; electrical and mechanical interface | Current drawings, pinout, voltage, brightness and thermal data, drivers, NDA | Owner supplies OEM data → custom part record (§10) |
| Main processing board | SoM/dev board vs custom main PCB (default: SoM carrier) | Compute and graphics needs, boot time, heat and power, footprint, module lifecycle | Architecture trade study (S2), modules catalog |
| Timecode PCB | Separate jam-sync/free-run LTC hardware and sync scheme | Frame accuracy, drift, connectors, compatibility tests | **First board through G3/G4/G4.5** |
| Power & battery | Swappable packs, hot-swap, protection, charger | Wh budget, peaks, battery qualification, transport (UN 38.3) | Power calculator (M-SRC); mandatory review gate |
| RF / wireless | Bluetooth / Wi-Fi / proprietary | Module approvals, antenna clearance, regulatory route | Prefer pre-certified modules (§14) |
| Sensors / UI | Clapper sensor, stick state, camera, controls | Durability, sensitivity, false-trigger tests, fit | Schematic/PCB + S6 tests |
| Mechanical case | Aluminium front, printed or molded rear, fasteners, finish | Tolerance stack, serviceability, drop and thermal tests | M-ENC |
| Firmware / software | Metadata logging, timecode, reports, comms | Test plan, secure updates, export compatibility, failure recovery | Briefs now; generation deferred |

Order:
1. One demonstrable subsystem (the timecode board, ordered and tested via G4.5).
2. One enclosure component (M-ENC).
3. Only then the mainboard and any autonomous end-to-end work.

Existing Smart Slate work in Flux is imported and audited by G5 (§16).

## 14. Optimization and recommendation engine — from v1.0 (Built, first version)

Ranked change proposals. Each one carries:
- the targeted requirement and the proposed change;
- predicted impact and its calculation or simulation basis;
- confidence, cost and complexity;
- affected interfaces, manufacturability effects and applicable standards;
- a before/after comparison;
- an approval control.

Accepted proposals become decisions and go through change control (§7).

**Objectives:**
- unit cost at 1, 10, 100 and 1,000 units, plus NRE and tooling;
- availability;
- volume and weight;
- peak and standby power, and thermal margin;
- stackup and routing;
- yield, repair time and supply concentration.

Hard constraints are never traded for appearance or price. Example: a pre-certified wireless module instead of discrete RF, accepting the board-area and BOM cost.

**Built (18 Nov 2026):**
- **Inputs:** proposals come from the latest approved sourced BOM and power budget, with alternates looked up fresh at
  the distributors.
- **Objectives covered:**
  - unit cost at 1/10/100/1,000 boards;
  - availability and lifecycle, second sources and fewer unique parts;
  - power (LDO → switcher), standby (quiescent current) and thermal margin.
- **Computed, not estimated:** cost from offers priced with the sourced BOM's rules; power by re-running the power
  calculator on the changed tree. Assumptions are named and lower the confidence.
- **Constraints:** each part is re-checked against value, package and rating. Requirements that name or forbid a
  change exclude it. Judgment calls are marked *needs review* and must be confirmed before accepting.
- **Approval:** owners or reviewers accept or reject. An accepted proposal becomes a decision; a rejection needs a
  reason. Decisions carry over between analyses.
- **Not yet:**
  - NRE and tooling, volume and weight, stackup and routing, yield, repair time;
  - pre-certified-module trade studies;
  - automatic application of an accepted change to the design (today a decision for the next revision);
  - a written narrative from Claude next to the computed numbers.
## 15. Quality, compliance, safety, security, privacy and IP

**Evidence categories** *(Built)*:
- datasheet-verified;
- deterministic calculation;
- simulation;
- CAD check;
- hardware test;
- unverified assumption.

Today's datasheet evidence is a text match and is labelled so.

**Separate gates** *(Built for ERC, DRC + parity, footprint/3D coverage; planned for interference, BOM, DFM)*.

**Mandatory human review gates:**
- PCB power sections;
- hot-swap;
- battery charging;
- RF and EMC;
- high-speed signals and timecode fidelity;
- tolerancing and thermal;
- mechanical pinch hazards.

**Compliance:**
- Standards selection is per jurisdiction and product.
- Many standards must be purchased; the platform tracks obligations.
- Interpretation and sign-off go to qualified engineers and labs.
- Electrical, battery, RF and fire risks need hazard analysis, protective features, tests and independent review.
- An AI-designed board is never marked certified by inference.

**Security:**
- RLS tenant isolation, roles, signed URLs, an immutable audit log and secrets kept out of the database *(Built)*;
- sandboxed tools with no model-originated commands *(Built: the model returns data, never commands)*;
- file virus scanning (ClamAV), upload and archive validation, an encryption and data-handling review, and supplier
  access windows *(Built, G6 / M-RFQ; `docs/SECURITY.md`)*;
- a security lint over the schema, a tamper-evident audit hash chain, signed assistant messages, CSP and security
  headers, and a secret scan *(Built, G6)*.

**Provenance:**
- Every artifact has a sha256 and tool version/config *(Built)*.
- Provenance for each symbol, footprint, datasheet and 3D model, with its licence (GPL, CC-BY-SA, SDK, vendor), is recorded. Today: KiCad library IDs and model sources. Planned: per-part licence fields.

**Prompt injection.** Supplier pages and PDFs are untrusted content. Datasheets are only text-matched today; retrieved text is never placed where it can act as instructions.

**Authorization.**
- Ordering, NDA signing, outbound email and supplier data-sharing each need explicit user authorization.
- Export-control and sanctions checks happen before supplier disclosure.

**Privacy.** No shared-model training on customer projects without opt-in.

## 16. Flux import and engineering audit (G5) — from v0.1

Inputs, depending on what Flux actually exports:
- ZIPs, native CAD files and BOM CSVs;
- datasheets and STEP files;
- screenshots, chat/workflow exports and reports.

Steps:
1. Inventory revisions, design units, footprint/model links and missing dependencies.
2. Extract prior decisions and claimed validations. Anything without supporting files is marked unverifiable.
3. Build a current-state map: approved vs uncertain components, motherboard connections, power budget, layer assumptions, enclosure constraints.
4. Compare revisions to find repeated decisions and preventable rework.
5. Produce a migration plan with bounded tasks.

An imported board is never assumed verified.

**What Flux exports** (Flux documentation, checked 18 Nov 2026):
- **Project data:** Flux project data (JSON). This is `project.json` with a published `project.schema.json`, plus
  optional asset files. It holds components, part data, pins, placements, nets, the BOM, boards (outline, stackup,
  traces, vias, pads, fills, rules), schematic wires, and assets with SHA-256.
- **Netlists:** schematic netlist (EDIF) and layout netlist (IPC-D-356).
- **Manufacturing and assembly:** Gerbers ZIP, BOM ZIP (per-manufacturer CSVs), pick-and-place ZIP, IPC-2581C,
  ODB++, GenCAD.
- **Mechanical:** STEP and other 3D formats, plus DXF, SVG and PDF drawings.
- **Documents:** schematic PDF, and Markdown for documents and tables.

No KiCad export and no revision-history export are documented.

**Built (18 Nov 2026):**
- **Upload:** each revision's exports are uploaded straight to project storage.
- **Deterministic audit (`@vx/flux`):** covers steps 1, 3 and 4 above. That is the inventory with missing
  dependencies; consistency across the exports; schematic against layout compared by which pins are joined; board
  facts; the current-state map; and revision diffs, including changes that were made and undone.
- **Step 2:** Claude extracts decisions and claims, and each quote is checked word for word against its file. All of
  them are unverifiable; where a related file exists the claim is "evidence present, not re-run".
- **Step 5:** a migration plan of bounded tasks, each tied to the findings it resolves.
- **Not yet:** parsing IPC-2581 and ODB++; reading screenshots; turning the migration plan into project plan tasks;
  checking the JSON reader against a real export.

## 17. User interface

| View | Content | Status |
|---|---|---|
| Project home | Documents, requirements, plans, runs | **Built** |
| Plan view | Ordered checklist, dependencies, approvals, risk, edit locks | **Built**. Graph view and stage grouping planned. |
| Run view | Controls (pause/resume/cancel/continue), approvals with previews, activity, report, waiting-for-worker banner | **Built** |
| Engineering view | Schematic SVG/PDF, ERC, component evidence, BOM, board renders, interactive 3D (GLB), DRC with parity, 3D model report, placement, downloads | **Built** |
| Activity view | Reasoning summaries (not hidden reasoning), tool calls, checks, errors, costs | **Built** (execution logs) |
| Beginner wizard | Requirements wizard, risk classification, plain-language tradeoffs | Planned (v1.0 P0) |
| Concept review | Variant comparison, design freeze | **Built** (M-CON; also in the workspace centre) |
| Supplier comparison / BOM | Offers with live/cached/estimate labels, alternates, landed cost | Planned (M-SRC) |
| Revision browser | Released revisions, sign-offs, manifests | Planned |

### 17.1 Client workspace (owner decision, 17 Nov 2026) — M-UI

Clients get their own login and a page per project. The project page is a three-part workspace:

| Area | Content |
|---|---|
| Chat (left) | A running dialogue with the project, like Claude or ChatGPT: ask questions, give requirements and feedback, approve or return work. Messages are stored per project; the assistant answers from the project's requirements, plan, outputs and evidence, and its actions go through the same plan, approvals and audit as everything else. |
| Centre | What has been done: reports, schematic, layout, 3D views, concepts, fab package. The viewers built in G3–G4.5 move here. |
| Checklist (right) | The live plan: what is running, done and next. At an approval point the work **stops**, the checklist shows "approval needed", and the client approves or returns it with a note. |

Implementation notes:
- The checklist and approval stops are the existing plan, runs and `decide_task`; the chat is new (project
  conversation table, streaming responses, tool calls limited to reading the project and creating plan changes or
  approvals that still need confirmation).
- Client accounts are project members with a `client` role: they see only their projects, approve at their stops, and
  never see internal notes, costs or other clients. Engineers keep the full views.
- External accounts arrive with M-UI rather than waiting for M-RFQ (this replaces open decision 3).

**Built (17 Nov 2026):**
- `client` project role. Clients read requirements, the plan and tasks, approvals, outputs, checks, models and the chat; runs,
  executions, cost events, audit events and worker logs are staff-only (RLS). Clients may approve or return at stops
  (`decide_task`), alongside owners and reviewers.
- Owners invite by email (`invite_member`); an invitation waits until that address signs up and becomes a membership on the
  first visit (`accept_invitations`). VX Design does not send email yet: the owner shares the sign-up link.
- Chat (`project_messages`, written only through `post_message`). The assistant answers from context read with the
  asker's own credentials, so it cannot reveal anything RLS hides from them. It points to outputs (links open in the centre
  viewer) and restates requested changes as suggested requirement changes for the team; it cannot change the project.
  Without an API key (`VX_LLM=offline`) it returns a deterministic, labelled status summary.
- Workspace page: chat (left), overview or embedded output viewer (centre), live checklist with approval stops (right).
  Clients are sent to the workspace; staff reach it from the project page.

## 18. Data and API contracts

**Built schema:**
- projects, project_members, documents, requirements, task_requirements;
- plans, tasks, task_dependencies, decisions, approvals;
- runs, executions, execution_logs, workers;
- artifacts, artifact_versions, task_artifacts;
- validations, tool_capabilities, cost_events, audit_events.

**v1.1 data changes, planned:**
- the knowledge catalogs (§8);
- `offers`;
- `process_rules` (`manufacturers` built in M-RFQ);
- per-part licence and provenance fields.

v1.0's endpoints are **logical interfaces**. Today they are SQL functions under RLS plus server actions. A public REST surface is deferred.

| Interface | v1.0 endpoint | Today |
|---|---|---|
| Project | `POST /projects`, `GET /projects/:id`, `POST /projects/:id/requirements` | Tables under RLS; document intake action → requirement extraction |
| Plan & runs | (v0.1) | `create_plan_version`, `submit_plan`, `decide_plan`, `authorize_run`, `control_run`, `decide_task` |
| Concept | `request_concepts`, `cancel_concepts`, `freeze_design` (Supabase RPCs; the worker uses `claim_concept_round` / `complete_concept_round`) | **Built** |
| Knowledge | `GET /sources/search`, `POST /sources/register`, `GET /standards/applicability` | Planned |
| Parts/BOM | `GET /parts/search`, `POST /bom/resolve`, `POST /bom/alternates` | Planned |
| Design | `POST /design/jobs`, `GET /design/jobs/:id`, `POST /revisions/:id/approve` | A design job is a task in an authorized run; approval via `decide_task` |
| Manufacturing | `GET /manufacturers/match`, `POST /rfq/draft`, `POST /rfq/:id/approve-disclosure` | **Built** as RPCs: `create_rfq`, `update_rfq`, `set_rfq_attachments`, `add_rfq_recipient`, `request_rfq_packet`, `approve_rfq_disclosure`, `send_rfq`, `close_rfq`; supplier side `supplier_rfqs`, `supplier_open_rfq`, `submit_quote`, `decline_rfq`. Matching is a category filter for now |
| Optimization | (§14 proposals with an approval control) | **Built** as RPCs: `request_optimization`, `decide_proposal`; workers `claim_optimization` / `complete_optimization` |
| Compliance | `POST /assessments`, `POST /test-results`, `GET /projects/:id/gate-status` | Planned |

Every response carries source references, timestamps, job state, error codes, permissions and a trace id.

**Adapter methods:**
- *Built* (in `vx_eng` and the orchestrator): `runERC()`, `runDRC()`, `generateSchematic()`, `renderModel()`.
- *Built* (M-RFQ): `createRFQDraft()` (`create_rfq`), `getQuoteStatus()` (quotes per supplier).
- *Planned*: `searchParts()`, `fetchDatasheetMetadata()`, `validateDFM()`.

## 19. Roadmap and backlog

v1.0's backlog, merged with build status:

| Pri | Deliverable | Definition of done | Status / milestone |
|---|---|---|---|
| P0 | Repo, Vercel app, Supabase DB/auth, file store, project model | Sign in, create a project, upload restricted documents | **Built** (Vercel deploy pending) |
| P0 | Source registry, licensing controls, document search | Search returns official URLs, edition/licence flags and citations | M-KB |
| P0 | Requirement wizard, risk classification, gate approvals | Smart Slate requirements entered, amended and approved | **Partial**: extraction, edit and approval, risk register and feasibility check, stage gates built; wizard planned |
| P1 | Concept mockup/review, engineering envelope | Client selects a concept; design freeze recorded | M-CON |
| P1 | Component master, BOM/AVL, Nexar/DigiKey/Mouser adapters | Normalized cross-vendor results, tested fallbacks, timestamps | M-SRC (needs keys) |
| P1 | Smart Slate subsystem library + module comparisons | Architecture and trade studies with supplier evidence | Briefs built; catalogs with M-KB/M-SRC |
| P1 | KiCad worker, ERC/DRC, export verification | Reproducible, tested generated PCB starter project | **Built** (G3, G4); exports in G4.5 |
| P2 | Mechanical CAD worker + process rules | Editable source + STEP/STL/drawings + checks | M-ENC |
| P2 | Manufacturer CRM, NDA/RFQ packets | Approved request → complete attachments + audit log | **Built** (M-RFQ) |
| P2 | Power/thermal validation, BOM optimization proposals | Ranked recommendations with evidence and approvals | **Built** (power calculator; §14 proposals) |
| P3 | Production test, compliance docs, price analytics | Pilot package traceable to revisions and results | Later |

**Next order** (owner decisions, §21):
1. **G4.5 fab package.** *Built.* Its exit test is ordering and testing the timecode board, which needs a real design.
2. **M-SRC** (owner decision) with the manufacturer 3D model library. Starts as soon as distributor keys arrive.
3. **M-KB.** v1.0 P0. *Core built* (vector search waits for an embedding provider).
4. **M-ENC.** *Built* (physical print-and-fit test pending a real board).
5. **M-UI** (client workspace) *Built*. **M-CON** *Built* (live images need a key). **M-RFQ** *Built*. **G5 Flux audit** *Built* (its formal pass needs the real Flux export).

v1.0's 16-week sequence is kept as a target, not a commitment:
- weeks 1–2: foundation and source registry;
- weeks 3–4: requirements and concepts;
- weeks 5–6: parts stack and BOM;
- weeks 7–9: ECAD and power;
- weeks 10–12: MCAD/DFM, partners and RFQ;
- weeks 13–16: prototype feedback and hardening.

Weeks 7–9 are already largely delivered.

## 20. Owner action checklist

1. **Anthropic API key**, so real Claude designs replace offline stand-ins (unblocks the formal G1 pass and real G3/G4 designs).
2. **Smart Slate specification** (sanitized), plus an approved concept, target envelope, screen and power requirements, first-article quantity and unit-cost targets.
3. **Distributor API credentials and usage approval**: Nexar, DigiKey, Mouser (plus LCSC/JLC access if you'll use JLC assembly).
4. **Worker host.** One CPU VM or container host for the ~7 GB KiCad worker, with a persistent volume for the 3D model cache.
5. **Touchscreen OEM**: permission, current interface drawings, CAD, pinouts, SDK and any confidentiality restrictions.
6. **Manufacturer candidates**: 10 per category, with legal name, site, location, contact, processes, MOQ, certifications and quality documents. Also request capabilities, file formats, DFM rules, tolerances, quote template, shipping terms and sample inspection reports.
7. **Commercial terms with suppliers**: NDA, IP and tooling ownership, warranty, import/export documents, referral or volume arrangements, all in writing.
8. **Paid standards**: decide which need licensing at their latest editions.
9. **Outside reviewers** for battery, power, timecode, RF/EMC, industrial design and manufacturing DFM.
10. **Flux export** of the existing Smart Slate work (G5 is built and waiting). For each revision you have, in Flux: Export → Flux project data (*JSON and asset files*); Electronics → Netlists (both EDIF and IPC-D-356), Manufacturing files, Bill of materials, Pick & place; Mechanical → full 3D assembly (STEP); plus any chat or notes exports and test reports.
11. **Image provider for concepts**: pick one (Google Gemini image / "Nano Banana", or OpenAI) and set `GEMINI_API_KEY`
    or `OPENAI_API_KEY` as a worker secret once its terms and data-sharing are acceptable (M-CON is built and waiting).
12. **NDA template review**: have counsel review (or replace) the RFQ packet's mutual NDA template before the first
    full-design RFQ. Enter the first real suppliers in the directory with how each identity and contact email was
    confirmed (M-RFQ is built and waiting).
13. **Security settings for deployment** (G6, `docs/SECURITY.md`):
    - run `scripts/set-assistant-key.sh` and set `VX_ASSISTANT_SIGNING_KEY` on the web server;
    - give the workers a ClamAV daemon (`CLAMD_HOST`) and decide whether uploads must be scanned clean before anyone
      can read them (`require_virus_scan`);
    - decide the data region, the retention period and whether any project needs customer-managed encryption;
    - schedule `check:integrity` and a storage-bucket backup.

## 21. Owner decisions

Decided 17 Nov 2026:
1. **Next milestone after G4.5: parts sourcing (M-SRC).** The knowledge base (M-KB) runs alongside where it does not
   compete for the same work.
2. **Concept images: add an image-generation provider** (e.g. Gemini "Nano Banana" or OpenAI) behind an adapter, for
   concepts; later mock-ups come from the CAD 3D model (§9).
3. **Manufacturer 3D models: build a library**, filled per project, with STEP plus the manufacturer's mechanical data
   (§10.1).
4. **Clients get logins and a project workspace** with chat, a live checklist with approval stops, and a central viewer
   (§17.1, M-UI).

Still open:
- Which image provider to start with, after its terms and pricing are reviewed (both adapters are built).
- Which embedding provider for semantic search in the knowledge base (Anthropic has none; Voyage AI is the usual
  pairing), or whether full-text search is enough for now. Also who the first knowledge editors are.
- Whether clients see RFQs and quotes (today they do not), and who besides library editors may approve vendors.
- Whether VX Design should send RFQ emails itself (needs a transactional email provider; today the owner sends them).
- Whether clients see optimization proposals (today staff only) and may accept cost proposals, and the assembly
  house's per-part setup fee to use in "fewer parts" proposals.

## 22. Success metrics and launch boundaries

**Metrics:**
- 100% of standards references and engineering recommendations cite a tracked source or state their uncertainty.
- 100% of supplier quotes and offers are labelled live, cached (timestamp) or estimate.
- Exports are native editable CAD plus interoperable manufacturing files that pass importer and supplier checks. G3/G4 projects re-open and re-check clean in a fresh KiCad.
- Automated checks: ERC, DRC with schematic parity, BOM validation, pin/footprint review, mechanical interference, revision traceability.
- Prototype packages include drawings, revision IDs, file manifests, inspection tests and approval history.
- Every run tracks AI and compute spend against its budget. Cache and retrieval savings are measured, not assumed.

**Definition of done for the private MVP** (v0.1, extended). A user can:
- sign in, upload the Smart Slate spec and approve a full plan;
- authorize a bounded unattended run, watch task state and recover from a worker interruption;
- read an in-app completion report;
- download verified, editable KiCad schematic and board files;
- **order the fab package for the timecode board**.

Unsupported operations are plainly labelled and never simulated with placeholders.

**Launch boundary.** "AI-assisted", never "autonomously certified". Designs need professional approval and the appropriate compliance tests.

## 23. Source and verification ledger

Official pages reviewed for v1.0 (16 Nov 2026). They establish that the services exist, not that any commercial access has been negotiated:
- Nexar developer: https://nexar.com/developer
- DigiKey developer APIs: https://developer.digikey.com/
- Mouser APIs: https://www.mouser.com/en/api-hub/
- IPC PCBA checklist: https://www.ipc.org/sites/default/files/documents/PCBA-Checklist_0.pdf
- KiCad library licence: https://www.kicad.org/libraries/license/
- Autodesk Fusion API: https://help.autodesk.com/cloudhelp/ENU/Fusion-360-API/files/UserManualIndex_UM.htm
- JLCPCB board and assembly capabilities: https://jlcpcb.com/capabilities/Capabilities, https://jlcpcb.com/capabilities/pcb-assembly-capabilities
- Protolabs moldability toolkit: https://www.protolabs.com/resources/design-for-moldability-toolkit/

Verified in this repository (G0–G4, run in the engineering image):
- KiCad 10.0.8, Freerouting 2.5.0, KiKit 1.8.1, CadQuery 2.8.0, ngspice 44.2, SKiDL 3.0.0 (`docs/g0/capability-matrix.md`);
- KiCad 3D models from kicad-packages3D at tag 10.0.8.

**Companion document (next):** *Knowledge Base & Source Ingestion Specification*. It covers acquisition priority, licensing policy, document metadata, embedding and retrieval, the standards applicability engine, and the three-provider connector contracts. It gets its own document number, separate from this master spec's version.
