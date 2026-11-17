#!/usr/bin/env bash
# Power browser end-to-end test. Needs the local Supabase stack, the web app running with
# VX_LLM=offline, and the vx-engineering-worker image.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
STATUS="$(npx -y supabase@3.2.0 status -o json 2>/dev/null)"
json() { node -e 'const s=JSON.parse(require("fs").readFileSync(0,"utf8")); process.stdout.write(s[process.argv[1]] ?? "")' "$1" <<<"$STATUS"; }
export SUPABASE_URL="$(json API_URL)"
export SUPABASE_SERVICE_ROLE_KEY="$(json SERVICE_ROLE_KEY)"
export SUPABASE_ANON_KEY="$(json ANON_KEY)"
NODE_PATH="$(npm root -g)" node apps/web/e2e/power-flow.mjs
