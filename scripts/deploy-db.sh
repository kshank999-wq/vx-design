#!/usr/bin/env bash
# Applies the database to a hosted Supabase project and sets its sign-in settings, over HTTPS through the Supabase
# Management API (no database password or direct Postgres connection needed). Safe to re-run: only migrations not yet
# in the project's migration history are applied (listed first, then confirmed), each in its own transaction and
# recorded the way the Supabase CLI records them; auth settings are idempotent.
#
#   SUPABASE_ACCESS_TOKEN=...      personal access token (supabase.com → Account → Access tokens)
#   SUPABASE_PROJECT_REF=...       the project's reference id
#   VX_SITE_URL=https://...        the web app's public address (no trailing slash)
#   VX_EXTRA_REDIRECTS=...         optional, comma-separated further callback URLs, e.g. Vercel preview deployments:
#                                  https://<project>-*-<team>.vercel.app/auth/callback
#   ./scripts/deploy-db.sh         (add --yes to skip the confirmation, e.g. in CI)
set -euo pipefail
: "${SUPABASE_ACCESS_TOKEN:?}" "${SUPABASE_PROJECT_REF:?}" "${VX_SITE_URL:?}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
API="https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF"
SITE="${VX_SITE_URL%/}"

# Runs SQL (from stdin) and prints the JSON result; fails on an SQL error.
sql() {
  local body out code
  body=$(node -e 'process.stdout.write(JSON.stringify({ query: require("fs").readFileSync(0, "utf8") }))')
  out=$(curl -sS -w '\n%{http_code}' -X POST "$API/database/query" -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
        -H "Content-Type: application/json" --data-binary "$body")
  code="${out##*$'\n'}"; out="${out%$'\n'*}"
  if [ "${code:0:1}" != 2 ]; then echo "$out" >&2; return 1; fi
  printf '%s' "$out"
}

sql >/dev/null <<'SQL'
create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text);
SQL
applied=$(sql <<<"select coalesce(json_agg(version), '[]') as v from supabase_migrations.schema_migrations" |
          node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0, "utf8"))[0].v.join("\n"))')

pending=()
for f in supabase/migrations/*.sql; do
  v="$(basename "$f" | cut -d_ -f1)"
  grep -qx "$v" <<<"$applied" || pending+=("$f")
done
echo "== $SUPABASE_PROJECT_REF: ${#pending[@]} migration(s) to apply"
printf '   %s\n' "${pending[@]##*/}"
if [ "${#pending[@]}" -gt 0 ] && [ "${1:-}" != "--yes" ]; then
  read -r -p "Apply them? [y/N] " ok
  [ "$ok" = "y" ] || [ "$ok" = "Y" ] || { echo "Nothing applied."; exit 1; }
fi
for f in "${pending[@]}"; do
  base="$(basename "$f" .sql)"; v="${base%%_*}"; name="${base#*_}"
  printf '   applying %s… ' "$base"
  { echo "begin;"; cat "$f"; echo ";"
    echo "insert into supabase_migrations.schema_migrations (version, name, statements) values ('$v', '$name', '{}');"
    echo "commit;"; } | sql >/dev/null
  echo ok
done

# Seed rows (the tool capability matrix) on a fresh database only.
if [ "$(sql <<<"select count(*) as n from public.tool_capabilities" | node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(0,"utf8"))[0].n))')" = 0 ]; then
  sql <supabase/seed.sql >/dev/null && echo "   seed rows added"
fi

echo "== Sign-in settings"
# Email confirmation on; confirmation links may only return to this site's /auth/callback.
body=$(node -e 'const s=process.argv[1]; process.stdout.write(JSON.stringify({
  site_url: s, uri_allow_list: [`${s}/auth/callback`, ...(process.argv[2] || "").split(",").map((x) => x.trim()).filter(Boolean)].join(","), mailer_autoconfirm: false, password_min_length: 10,
  external_anonymous_users_enabled: false }))' "$SITE" "${VX_EXTRA_REDIRECTS:-}")
code=$(curl -sS -o /dev/null -w '%{http_code}' -X PATCH "$API/config/auth" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H "Content-Type: application/json" -d "$body")
[ "$code" = "200" ] || { echo "auth settings failed (HTTP $code)" >&2; exit 1; }
echo "   site $SITE, confirmation required, redirects to $SITE/auth/callback${VX_EXTRA_REDIRECTS:+ and $VX_EXTRA_REDIRECTS} only"
echo
echo "Done. Next: ./scripts/set-assistant-key.sh against this project, then the web server's environment (docs/DEPLOY.md)."
