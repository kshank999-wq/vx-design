#!/usr/bin/env bash
# Applies all Supabase migrations to a throwaway local Postgres and runs the
# schema behavior tests. Needs Postgres binaries (initdb, pg_ctl, psql) on PATH
# or under /usr/lib/postgresql/<version>/bin.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PG_BIN="${PG_BIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
export PATH="${PG_BIN:+$PG_BIN:}$PATH"

DATA_DIR="$(mktemp -d)"
PORT="${PGPORT_TEST:-54329}"
RUN_AS=()
if [ "$(id -u)" = "0" ]; then
  chown -R postgres "$DATA_DIR"
  RUN_AS=(runuser -u postgres --)
fi

cleanup() { "${RUN_AS[@]}" pg_ctl -D "$DATA_DIR" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$DATA_DIR"; }
trap cleanup EXIT

"${RUN_AS[@]}" initdb -D "$DATA_DIR" -U postgres -A trust >/dev/null
"${RUN_AS[@]}" pg_ctl -D "$DATA_DIR" -o "-p $PORT -k $DATA_DIR -c listen_addresses=''" -w start >/dev/null

PSQL=(psql -h "$DATA_DIR" -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -q)

"${PSQL[@]}" -f "$ROOT/supabase/tests/stubs.sql"
for f in "$ROOT"/supabase/migrations/*.sql; do
  echo "Applying $(basename "$f")"
  "${PSQL[@]}" -f "$f"
done
echo "Applying seed.sql"
"${PSQL[@]}" -f "$ROOT/supabase/seed.sql"
for t in schema_test planning_test worker_test workspace_test kb_test concept_test rfq_test flux_test optimization_test recovery_test security_test; do
  "${PSQL[@]}" -f "$ROOT/supabase/tests/$t.sql"
done
