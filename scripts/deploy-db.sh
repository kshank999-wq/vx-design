#!/usr/bin/env bash
# Applies the database to a hosted Supabase project and sets its sign-in settings. Safe to re-run: only migrations
# not yet applied are pushed (shown first, then confirmed), and auth settings are idempotent.
#
#   SUPABASE_ACCESS_TOKEN=...      personal access token (supabase.com → Account → Access tokens)
#   SUPABASE_PROJECT_REF=...       the project's reference id
#   SUPABASE_DB_PASSWORD=...       the database password chosen when the project was created
#   VX_SITE_URL=https://...        the web app's public address (no trailing slash)
#   ./scripts/deploy-db.sh         (add --yes to skip the confirmation, e.g. in CI)
set -euo pipefail
: "${SUPABASE_ACCESS_TOKEN:?}" "${SUPABASE_PROJECT_REF:?}" "${SUPABASE_DB_PASSWORD:?}" "${VX_SITE_URL:?}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
SB=(npx -y supabase@3.2.0)
REF="$SUPABASE_PROJECT_REF"
SITE="${VX_SITE_URL%/}"
export SUPABASE_DB_PASSWORD

echo "== Migrations that would be applied to $REF"
"${SB[@]}" link --project-ref "$REF" >/dev/null
"${SB[@]}" db push --remote --include-seed --dry-run
if [ "${1:-}" != "--yes" ]; then
  read -r -p "Apply them? [y/N] " ok
  [ "$ok" = "y" ] || [ "$ok" = "Y" ] || { echo "Nothing applied."; exit 1; }
fi
"${SB[@]}" db push --remote --include-seed

echo "== Sign-in settings"
# Email confirmation on; confirmation links may only return to this site's /auth/callback.
body=$(node -e 'const s=process.argv[1]; process.stdout.write(JSON.stringify({
  site_url: s, uri_allow_list: `${s}/auth/callback`, mailer_autoconfirm: false, password_min_length: 10,
  external_anonymous_users_enabled: false }))' "$SITE")
code=$(curl -sS -o /dev/stderr -w '%{http_code}' -X PATCH "https://api.supabase.com/v1/projects/$REF/config/auth" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H "Content-Type: application/json" -d "$body")
[ "$code" = "200" ] || { echo "auth settings failed (HTTP $code)" >&2; exit 1; }
echo
echo "Done. Next: ./scripts/set-assistant-key.sh against this project, then set the web server's environment (docs/DEPLOY.md)."
