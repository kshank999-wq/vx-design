#!/usr/bin/env bash
# Integrity check against the local Supabase stack (or set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY for another one).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ -z "${SUPABASE_URL:-}" ]; then
  STATUS="$(cd "$ROOT" && npx -y supabase@3.2.0 status -o json 2>/dev/null)"
  json() { node -e 'const s=JSON.parse(require("fs").readFileSync(0,"utf8")); process.stdout.write(s[process.argv[1]] ?? "")' "$1" <<<"$STATUS"; }
  export SUPABASE_URL="$(json API_URL)" SUPABASE_SERVICE_ROLE_KEY="$(json SERVICE_ROLE_KEY)"
fi
exec node "$ROOT/services/orchestrator/src/integrity-cli.ts"
