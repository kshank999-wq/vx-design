#!/usr/bin/env bash
# Fails if a tracked file looks like it contains a credential (G6). Local Supabase demo keys (issuer "supabase-demo")
# and the labelled local-only assistant key are allowed: they are public and only work against a local stack.
set -euo pipefail
cd "$(dirname "$0")/.."
PATTERNS='sk-ant-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{35}|sk-(proj-)?[A-Za-z0-9_-]{32,}|-----BEGIN ([A-Z]+ )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{40,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|eyJhbGciOi[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{20,}|sb_secret_[A-Za-z0-9_-]{20,}'
hits=$(git ls-files -z | xargs -0 grep -I -n -o -E "$PATTERNS" 2>/dev/null \
  | grep -v 'eyJpc3MiOiJzdXBhYmFzZS1kZW1vIi' || true)
if [ -n "$hits" ]; then
  echo "Possible credentials in tracked files (file:line:match):"; echo "$hits" | cut -c1-160; exit 1
fi
echo "No credentials found in $(git ls-files | wc -l) tracked files."
