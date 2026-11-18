#!/usr/bin/env bash
# Knowledge base polish browser end-to-end test (the app must run with VX_TEST_FETCH_REWRITE=https://docs.example.test=http://127.0.0.1:4599).
# VX_LLM=offline.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
STATUS="$(npx -y supabase@3.2.0 status -o json 2>/dev/null)"
json() { node -e 'const s=JSON.parse(require("fs").readFileSync(0,"utf8")); process.stdout.write(s[process.argv[1]] ?? "")' "$1" <<<"$STATUS"; }
export SUPABASE_URL="$(json API_URL)"
export SUPABASE_SERVICE_ROLE_KEY="$(json SERVICE_ROLE_KEY)"
export SUPABASE_ANON_KEY="$(json ANON_KEY)"
NODE_PATH="$(npm root -g)" node apps/web/e2e/kb-polish-flow.mjs
