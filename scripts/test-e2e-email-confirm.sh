#!/usr/bin/env bash
# Sign-up with email confirmation (as on hosted Supabase): confirmation email → /auth/callback → signed in.
# The local stack normally auto-confirms. To run this, set enable_confirmations = true under [auth.email] in
# supabase/config.toml, restart Supabase, serve the app at http://127.0.0.1:3000, run, then revert.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
STATUS="$(npx -y supabase@3.2.0 status -o json 2>/dev/null)"
json() { node -e 'const s=JSON.parse(require("fs").readFileSync(0,"utf8")); process.stdout.write(s[process.argv[1]] ?? "")' "$1" <<<"$STATUS"; }
API="$(json API_URL)"
if curl -sS "$API/auth/v1/settings" -H "apikey: $(json ANON_KEY)" | grep -q '"mailer_autoconfirm":true'; then
  echo "Email confirmation is off in the local stack; see the comment at the top of this script." >&2
  exit 2
fi
MAILPIT_URL="$(json MAILPIT_URL)" NODE_PATH="$(npm root -g)" node apps/web/e2e/email-confirm-flow.mjs
