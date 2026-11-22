#!/usr/bin/env bash
# Boards integration test: local Supabase + the engineering worker image (vx-engineering-worker).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
STATUS="$(npx -y supabase@3.2.0 status -o json 2>/dev/null)"
json() { node -e 'const s=JSON.parse(require("fs").readFileSync(0,"utf8")); process.stdout.write(s[process.argv[1]] ?? "")' "$1" <<<"$STATUS"; }
export SUPABASE_URL="$(json API_URL)"
export SUPABASE_SERVICE_ROLE_KEY="$(json SERVICE_ROLE_KEY)"
export SUPABASE_ANON_KEY="$(json ANON_KEY)"
cd services/orchestrator
node --test --test-concurrency=1 test/boards.test.ts
