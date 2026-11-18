#!/usr/bin/env bash
# Sets the key the web server signs assistant answers with (G6). Run once per environment, then set the same value as
# VX_ASSISTANT_SIGNING_KEY on the web server (e.g. a Vercel environment variable) and redeploy. Rotating: run again;
# answers being written during the switch fail once and can be re-asked.
#
#   SUPABASE_URL=https://<ref>.supabase.co SUPABASE_SERVICE_ROLE_KEY=... ./scripts/set-assistant-key.sh
set -euo pipefail
: "${SUPABASE_URL:?set SUPABASE_URL}" "${SUPABASE_SERVICE_ROLE_KEY:?set SUPABASE_SERVICE_ROLE_KEY}"
KEY="$(openssl rand -hex 32)"
code=$(curl -sS -o /dev/stderr -w '%{http_code}' -X POST "$SUPABASE_URL/rest/v1/rpc/set_assistant_signing_key" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" -d "{\"p_key\":\"$KEY\"}")
[ "$code" = "204" ] || [ "$code" = "200" ] || { echo "failed (HTTP $code)" >&2; exit 1; }
echo "Key stored in the database. Set this on the web server (server-side only, never NEXT_PUBLIC_):"
echo "VX_ASSISTANT_SIGNING_KEY=$KEY"
