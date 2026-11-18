#!/usr/bin/env bash
# Checks a deployed environment from the outside, with only public information. Changes nothing.
#
#   VX_SITE_URL=https://... SUPABASE_URL=https://<ref>.supabase.co SUPABASE_ANON_KEY=... ./scripts/smoke-deploy.sh
set -uo pipefail
: "${VX_SITE_URL:?}" "${SUPABASE_URL:?}" "${SUPABASE_ANON_KEY:?}"
SITE="${VX_SITE_URL%/}"
fails=0
ok() { echo "✓ $1"; }
bad() { echo "✗ $1"; fails=$((fails + 1)); }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }

h=$(curl -sS -D - -o /dev/null "$SITE/login")
check "sign-in page loads" '[[ "$h" =~ ^HTTP/[0-9.]+\ 200 ]]'
for hdr in content-security-policy strict-transport-security x-content-type-options x-frame-options referrer-policy; do
  check "header $hdr" 'grep -qi "^$hdr:" <<<"$h"'
done
check "no x-powered-by" '! grep -qi "^x-powered-by:" <<<"$h"'
check "CSP allows this Supabase project" 'grep -i "^content-security-policy:" <<<"$h" | grep -q "${SUPABASE_URL%/}"'
check "signed-out pages redirect to sign-in" '[[ "$(curl -sS -o /dev/null -w "%{http_code} %{redirect_url}" "$SITE/projects")" =~ ^30[78]\ .*/login ]]'
check "a bad confirmation link is refused" '[[ "$(curl -sS -o /dev/null -w "%{http_code} %{redirect_url}" "$SITE/auth/callback?code=x")" =~ ^303\ .*/login\?error= ]]'

api() { curl -sS -o /dev/null -w '%{http_code}' "$SUPABASE_URL$1" -H "apikey: $SUPABASE_ANON_KEY" -H "Authorization: Bearer $SUPABASE_ANON_KEY" "${@:2}"; }
for t in projects requirements audit_events test_runs platform_settings; do
  code=$(api "/rest/v1/$t?select=*&limit=1")
  check "anonymous read of $t refused (HTTP $code)" '[ "$code" = 401 ] || [ "$code" = 403 ] || [ "$code" = 404 ]'
done
body=$(curl -sS -X POST "$SUPABASE_URL/storage/v1/object/list/project-files" -H "apikey: $SUPABASE_ANON_KEY" \
  -H "Authorization: Bearer $SUPABASE_ANON_KEY" -H "Content-Type: application/json" -d '{"prefix":"","limit":1}')
check "anonymous storage listing is empty or refused" '[ "$body" = "[]" ] || grep -qi "error\|unauthor" <<<"$body"'
settings=$(curl -sS "$SUPABASE_URL/auth/v1/settings" -H "apikey: $SUPABASE_ANON_KEY")
check "email confirmation required" 'grep -q "\"mailer_autoconfirm\":false" <<<"$settings"'
check "anonymous sign-ins off" '! grep -q "\"anonymous_users\":true" <<<"$settings"'

echo
[ "$fails" = 0 ] && echo "Smoke check passed." || { echo "$fails check(s) failed."; exit 1; }
