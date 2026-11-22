# Deploying VX Design

Three parts, each on its own host:

| Part | Where | What it holds |
|---|---|---|
| Web app (`apps/web`) | Vercel | Pages and server actions. No secrets beyond the ones listed below; no long-running work. |
| Database, sign-in, files | Supabase (hosted) | Postgres with row level security, Auth, private storage buckets. |
| Workers (`services/orchestrator`, engineering image, ClamAV) | Any Docker host (a small VM) | Planning and design runs, sourcing, concepts, RFQ packets, Flux audits, optimization, virus scans. Outbound connections only. |

Workers never take inbound traffic, and the web app never needs the worker host. Both talk to Supabase only.

## Before you start: decisions

These are yours to make before deployment:

- **Data region.** The Supabase project's region is fixed at creation; put Vercel's function region next to it.
- **Email sending.** Hosted Supabase's built-in mailer is for testing (a few emails an hour). Sign-up confirmation needs a
  real SMTP provider (Supabase → Authentication → Emails → SMTP settings).
- **Retention and backups.** The Pro plan keeps daily backups for 7 days. Point-in-time recovery is a paid add-on.
  `scripts/backup-drill.sh` shows a restore works.
- **Worker host** and which workers run: the plain worker (always), the engineering worker (KiCad design tasks, 3D
  model checks; 8 GB RAM), ClamAV (virus scanning; 2–3 GB RAM).
- **Keys:** Anthropic, at least one distributor (Nexar, DigiKey or Mouser), and one image provider (Gemini or OpenAI).

## 1. Supabase project

1. Create a project (dashboard → New project) in the chosen region. Keep the database password.
2. Project settings → Storage → **Upload file size limit**: 100 MB. 3D models and Flux exports are uploaded straight
   from the browser.
3. Apply the database and the sign-in settings. This goes over HTTPS through the Supabase Management API, so it needs
   only an access token (supabase.com → Account → Access tokens), no database password or direct connection:

   ```bash
   SUPABASE_ACCESS_TOKEN=... SUPABASE_PROJECT_REF=... VX_SITE_URL=https://<your-domain> ./scripts/deploy-db.sh
   ```

   It lists the migrations not yet applied and asks before applying them. Each one runs in its own transaction and is
   recorded in the project's migration history, as the Supabase CLI does. Seed rows go into a fresh database only.
   Then it turns on email confirmation, allows confirmation links back to `VX_SITE_URL/auth/callback` only (plus
   `VX_EXTRA_REDIRECTS`, e.g. Vercel preview URLs) and switches off anonymous sign-ins. Re-run it after each release.
4. Create the signing key for assistant messages. Keep the printed value for the web app:

   ```bash
   SUPABASE_URL=https://<ref>.supabase.co SUPABASE_SERVICE_ROLE_KEY=... ./scripts/set-assistant-key.sh
   ```

5. Put your own account (and other staff) on the unlimited plan once you have signed up. In the SQL editor:
   `select public.set_account_plan((select id from auth.users where email = '<your email>'), 'unlimited');`
   Review the **standard** plan's placeholder limits in `account_plans` before opening sign-ups.
6. Optional: require a clean virus scan before anyone can open an uploaded file (once ClamAV runs, step 3):
   `update public.platform_settings set value = 'true' where key = 'require_virus_scan';` in the SQL editor.

## 2. Web app on Vercel

New project → import this repository:

- **Root directory:** `apps/web`. Vercel installs the pnpm workspace from the repository root.
- **Framework:** Next.js. **Node.js:** 22.x.
- **Function region:** the one closest to the Supabase region.
- **Environment variables** (Production and Preview):

| Variable | Value | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://<ref>.supabase.co` | Also sets the CSP's allowed origin. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | the project's anon key | Public by design; RLS protects data. |
| `VX_ASSISTANT_SIGNING_KEY` | from `set-assistant-key.sh` | Server only. Without it, assistant answers are refused. |
| `ANTHROPIC_API_KEY` | | Server only. Requirement extraction, plans, the assistant. |
| `VX_SITE_URL` | `https://<your-domain>` | Where confirmation emails link back to. Defaults to the request's host. |
| `NEXAR_CLIENT_ID`, `NEXAR_CLIENT_SECRET` | | Optional, server only. Parts from their datasheets are looked up here before the AI reads them. |
| `DIGIKEY_CLIENT_ID`, `DIGIKEY_CLIENT_SECRET` | | Optional, as above (the same keys as the workers'). |
| `MOUSER_API_KEY` | | Optional, as above. Without any distributor key, parts are matched against the saved parts catalog, then read by AI. |
| `STRIPE_SECRET_KEY` | `sk_live_…` (or `sk_test_…` to try it) | Optional, server only. Card top-ups on Account → Billing through Stripe Checkout. No webhook is needed: payments are confirmed on the return page, and any left open are checked again at the next Billing visit. Uses `VX_ASSISTANT_SIGNING_KEY` to sign the credit it records. Without it, staff add credit with `add_credit`. |

Never set `SUPABASE_SERVICE_ROLE_KEY` on Vercel: the web app does not use it.

Uploads never pass through Vercel's function body limit (4.5 MB). Files go from the browser to a staging folder in
storage; the server action reads each one back as the signed-in user, checks it and stores it. The worker removes
staged copies nobody collected after an hour.

**Billing (staff, in the Supabase SQL editor).** Accounts stay on the unbilled `standard` plan until they choose a plan
on Account → Billing. Staff can add credit (a bank transfer, a goodwill credit; a negative amount takes it back) and
change plans or prices:

```sql
select public.add_credit('<user id>', 100, 'Bank transfer 2026-11-30');
select public.set_account_plan('<user id>', 'unlimited');            -- staff/internal: not billed, cannot be changed by the user
update public.account_plans set monthly_fee_usd = 40, ai_markup_pct = 0 where id = 'studio';
```

Add your domain, then make sure `VX_SITE_URL` and the Supabase site URL (`deploy-db.sh`) both use it.

## 3. Workers

On the worker host (Docker with Compose):

1. Build the images: Actions → **Worker images** → Run workflow. They go to this repository's private GitHub container
   registry, `ghcr.io/<owner>/vx-worker` and `vx-engineering-worker`. Log the host in once with
   `docker login ghcr.io` and a token that has `read:packages`.
   GitHub only offers **Run workflow** for workflows on the default branch, so merge first. Or build on the host:
   `docker build -f services/orchestrator/Dockerfile -t <prefix>/vx-worker .`.
2. `cp deploy/workers.env.example deploy/workers.env` and fill it in. It holds the service role key: keep it on the host only.
3. Start the workers:

   ```bash
   VX_IMAGE_PREFIX=ghcr.io/<owner> VX_IMAGE_TAG=<tag> docker compose -f deploy/docker-compose.yml up -d
   ```

   Add `--profile engineering` to also start the KiCad worker. Each worker logs what it will and will not take at
   start (missing keys are named). ClamAV downloads its signatures on first start, which takes a few minutes; workers
   wait for it.

**Automatic updates.** Worker images are built on every push that changes worker code (Actions → Worker images).
To have a host pick them up by itself:

1. Add a GitHub token with `read:packages` to `deploy/workers.env` as `GHCR_USER=<GitHub user>` and `GHCR_TOKEN=<token>`.
2. In `deploy/.env`, set `COMPOSE_PROFILES=engineering,autoupdate` (or `autoupdate` alone without the KiCad worker).
3. Run `docker compose -f deploy/docker-compose.yml up -d`.

The `updater` service (`deploy/autoupdate.sh`) checks every 15 minutes (`UPDATE_INTERVAL_SECONDS`) and recreates
only the workers whose image changed. A worker stopped mid-job loses nothing: the job goes back to the queue and
resumes from its last checkpoint. The updater logs each update (`docker compose -f deploy/docker-compose.yml logs
updater`) and says plainly if the token is missing or has expired.

More capacity: `VX_WORKERS=3` (plain workers) or a second host with the same files. Leases make it safe to run any
number of workers, and to stop or restart them at any time (`docker compose restart`): work in progress goes back to
the queue and resumes from its last checkpoint.

## 4. Check it

```bash
VX_SITE_URL=https://<your-domain> SUPABASE_URL=https://<ref>.supabase.co SUPABASE_ANON_KEY=... ./scripts/smoke-deploy.sh
```

It changes nothing and needs no secrets. It checks the sign-in page and its security headers, and that signed-out
pages redirect. It checks that a bad confirmation link is refused and that anonymous access to tables and storage is
refused. It also checks that email confirmation is required.

Then by hand: sign up, confirm the email, create a project, upload a specification, and watch a worker pick up the run.
With the service role key, `pnpm check:integrity` re-hashes stored files and verifies the audit chains.

## Current environment

Set up on 2026-11-18. Nothing here is secret.

| Part | Where |
|---|---|
| Supabase | project `vx-design` (ref `xowysbjfroklrankpxqe`), us-west-1. All migrations and seed rows applied; static security lint passed; email confirmation on; assistant signing key set. |
| Vercel | project `vx-design`, functions in sfo1, Node 22, linked to this repository. `https://vx-design.vercel.app` (first build, from `claude/practical-davinci-r0wfap`). Vercel login protects every URL until launch. Pushes to the branch make preview deployments; the default branch deploys to production. |
| Smoke check | passed against `https://vx-design.vercel.app` before login protection was turned on. |
| Not yet | Resend SMTP for confirmation emails; `ANTHROPIC_API_KEY` on Vercel (until then, requirement extraction reports that no model is configured); the worker host. |

## Updating

1. `./scripts/deploy-db.sh` (migrations are additive).
2. Vercel deploys on push to the production branch.
3. Run the worker images workflow, then `VX_IMAGE_TAG=<new> docker compose -f deploy/docker-compose.yml up -d`.

Migrations run before the web app and workers that need them. Release in this order.

## Tested locally

| What | How |
|---|---|
| Email confirmation (as hosted) | `scripts/test-e2e-email-confirm.sh` with confirmations turned on locally (see the script) |
| Large uploads without the server | `scripts/test-e2e-staged-upload.sh`: a 6 MB specification posts a 240-byte form |
| Worker image | builds and starts against the local stack, naming its missing keys |
| Smoke check | `scripts/smoke-deploy.sh` against the local stack (fails only "email confirmation required", as expected locally) |
| Compose file | `docker compose config` |
