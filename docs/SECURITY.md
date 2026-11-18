# VX Design security, recovery and regression (G6)

What protects the platform, how to check it still does, and how to recover. Each claim names the test or tool that
proves it; anything not yet in place is listed under *Gaps*.

## Who can see what

| Data | Owner | Engineer | Reviewer | Viewer | Client | Supplier | Signed in, not a member |
|---|---|---|---|---|---|---|---|
| Requirements, plan, outputs, concepts, chat | ✓ | ✓ | ✓ | ✓ | ✓ | – | – |
| Runs, executions, logs, costs, audit log | ✓ | ✓ | ✓ | ✓ | – | – | – |
| RFQs, quotes, RFQ packets, Flux imports (rows **and** storage folders) | ✓ | ✓ | ✓ | ✓ | – | own invitation only, while its window is open | – |
| Supplier directory | ✓ | ✓ | – | – | – | – | – |
| Anything, for the anonymous (not signed-in) role | – | – | – | – | – | – | – |

Enforced by row-level security on every table and by storage policies (`project_file_readable`). The anonymous role has
no table, sequence or function privileges in the public schema.

## Controls

**Database (Supabase/Postgres)**
- Row-level security on every table; views run as the caller (`security_invoker`).
- Every `SECURITY DEFINER` function pins `search_path` and checks who is calling; worker-only functions (claim,
  complete, record…) are executable by the service role only. Trigger functions cannot be called directly.
- **Security lint** (`supabase/tests/security_test.sql`, run by `./scripts/test-db.sh` and CI): fails the build if a
  migration adds a table without RLS, gives anon anything, adds an unpinned or unchecked definer function, or opens
  a worker-only function to users.
- **Tamper-evident audit log.** Audit events cannot be updated (trigger) and each project's events form a SHA-256
  hash chain (`seq`, `prev_hash`, `hash`). `verify_audit_chain(project)` names the first edited or missing event.
  Anchor the head hash outside the database (e.g. in a release note) to also detect a rewrite of the whole chain.
- **Signed assistant messages.** Only the web server holds `VX_ASSISTANT_SIGNING_KEY`. `post_message` accepts an
  assistant answer only with a fresh (5-minute) HMAC-SHA256 over the project, user, time, question, answer and data,
  and each signature once. Members calling the database directly cannot post as the assistant.

**Files**
- **Upload inspection** (`@vx/security`): the file's real type is read from its bytes. Programs, scripts, Office
  macros, extension/content mismatches, script in SVG/HTML, and archive tricks (path traversal, symlinks, encrypted
  entries, more than 200:1 compression, too many entries or bytes) are refused at every upload form and in the Flux
  import worker.
- **Virus scanning**: a worker with `CLAMD_HOST` scans every uploaded file (documents, 3D models, knowledge files,
  Flux exports) with ClamAV. An infected file is unreadable to everyone through storage policies, shown as blocked,
  and audited (`file.infected`); the Flux audit refuses to run on it. Setting `require_virus_scan` to `true` in
  `platform_settings` keeps uploads unreadable until scanned clean.
- Hashes: every stored output records its SHA-256; packets and reports are reproducible.

**Web**
- Security headers on every response: Content-Security-Policy (scripts only from the site; data only to the site and
  the Supabase project; no plugins; framing only by the site), `X-Frame-Options: SAMEORIGIN`, `nosniff`,
  `Referrer-Policy`, `Permissions-Policy`, HSTS, COOP; no `X-Powered-By`.
- Secrets live in environment variables only (web: Supabase URL and anon key, the Anthropic key for the chat, the
  signing key; workers: service-role key, model, image, distributor and scanner settings). The service-role key is
  never in the web app. `./scripts/check-secrets.sh` (CI) fails on credentials committed to the repository.

**Model safety**
- Models return data validated against schemas, never commands. Uploaded and retrieved text is passed as data with
  instructions not to follow it; quotes extracted from documents are kept only if found word for word.

## Encryption and data handling (policy review)

| Where | State |
|---|---|
| In transit | HTTPS to Vercel and Supabase (HSTS on the web app); workers reach Supabase over HTTPS. |
| At rest | Supabase encrypts the database and storage at rest (provider-managed keys). No application-level encryption yet. |
| Backups | Supabase daily backups / point-in-time recovery (plan-dependent); see *Recovery*. |
| Third parties | Text sent to Anthropic (chat, planning, design), image prompts to the chosen image provider, part numbers to distributors. Each is configured per worker; nothing is sent without its key. |
| Retention | Projects and their files are kept until deleted; audit events are deleted only with their project. |

Decisions for the owner: whether any project data needs customer-managed keys or per-project encryption, a data
retention period, and which regions the Supabase project and workers run in.

## Recovery

- **Worker crashes**: every job type is lease-based. A dead worker's job is retaken after its lease goes stale, its
  late result is refused, and a job that keeps failing gives up after 3 attempts (`supabase/tests/recovery_test.sql`;
  tasks in `worker_test.sql` and the G2 browser test).
- **Integrity check** (`pnpm check:integrity`): re-hashes every stored file the database vouches for and verifies every
  audit chain; prints anything missing, changed or broken. Run it after any restore or migration, and on a schedule.
- **Backup and restore drill** (`pnpm drill:backup`): backs up the database and every stored file with a manifest,
  restores the database into a separate database, and proves the copy (identical row counts, all audit chains verify,
  every recorded file in the backup with its recorded hash), then reports timings. Production: restore the Supabase
  backup to a branch and run the same checks against it; copy the storage buckets on a schedule (Supabase backups do
  not include storage objects).

## Regression

`pnpm test:regression` runs each deterministic pipeline twice and compares with committed snapshots
(`tests/regression/golden`): the Flux audit, RFQ packet, power calculator, spec → requirements → plan (offline),
knowledge excerpts, concept brief and placeholder images, and upload verdicts. A changed result names which inputs or
versions changed. `pnpm test:regression:engineering` adds the KiCad tier (schematic, layout, fab package built twice in
fresh engineering-worker containers, outputs normalised for dates). After an intended change: `--update` and review the
snapshot diff.

What it found on its first run: two builds of the same circuit gave different board files and Gerbers, because KiCad
gives each new board item a random UUID and saves items in UUID order (the schematic already used deterministic IDs).
vx_eng now seeds KiCad's UUID generator from a hash of the inputs for the board build and for KiKit; the board, the
routed copper, the Gerbers and the drill files are now byte-for-byte repeatable. What still differs between builds is
only the creation time KiCad writes into PDFs, renders and the Gerber job file; the suite compares those by presence.

## Operating

| Setting | Where | Notes |
|---|---|---|
| `VX_ASSISTANT_SIGNING_KEY` | web server | `./scripts/set-assistant-key.sh` stores a new key and prints it once |
| `CLAMD_HOST`, `CLAMD_PORT` | workers | a ClamAV daemon with current signatures (`clamav/clamav` image with freshclam) |
| `require_virus_scan` | `platform_settings` | `update platform_settings set value = 'true' where key = 'require_virus_scan'` (service role) |

## Gaps

- No live test against official ClamAV signatures here (the signature server is blocked in this sandbox); the scan
  path is tested with a real clamd and a custom EICAR signature.
- No rate limiting on chat beyond the request size; concept generation is limited per project.
- Document parsing runs in the web server at upload time (after inspection, before the virus scan).
- No application-level encryption, MFA enforcement, or session/device management beyond Supabase Auth defaults.
- External penetration test not done.
