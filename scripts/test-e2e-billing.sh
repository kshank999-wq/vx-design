#!/usr/bin/env bash
# Billing browser end-to-end test. Start the web app with STRIPE_SECRET_KEY=sk_test_fake
# VX_STRIPE_API=http://localhost:4243/v1 (the test runs a stand-in Stripe there).
# VX_LLM=offline.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
STATUS="$(npx -y supabase@3.2.0 status -o json 2>/dev/null)"
json() { node -e 'const s=JSON.parse(require("fs").readFileSync(0,"utf8")); process.stdout.write(s[process.argv[1]] ?? "")' "$1" <<<"$STATUS"; }
export SUPABASE_URL="$(json API_URL)"
export SUPABASE_SERVICE_ROLE_KEY="$(json SERVICE_ROLE_KEY)"
export SUPABASE_ANON_KEY="$(json ANON_KEY)"
NODE_PATH="$(npm root -g)" node apps/web/e2e/billing-flow.mjs
