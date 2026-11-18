#!/usr/bin/env bash
# Backup and restore drill (G6), against the local Supabase stack:
#   1. back up the database (public, vx_private and auth schemas) and every stored file, with a hash manifest;
#   2. restore the database into a separate drill database on the same server;
#   3. prove the copy is complete and trustworthy: same row counts in every table, every audit hash chain verifies,
#      and every file the restored database vouches for is in the file backup with the recorded sha256;
#   4. drop the drill database and report how long backup and restore took.
# Production uses the hosting provider's backups (Supabase daily backups / point-in-time recovery) plus a copy of the
# storage buckets; run this drill against a restored branch the same way. See docs/SECURITY.md.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DB_CONTAINER="${DB_CONTAINER:-supabase_db_vx-design}"
OUT="${BACKUP_DIR:-$(mktemp -d)}"
DRILL=vx_restore_drill
STATUS="$(cd "$ROOT" && npx -y supabase@3.2.0 status -o json 2>/dev/null)"
json() { node -e 'const s=JSON.parse(require("fs").readFileSync(0,"utf8")); process.stdout.write(s[process.argv[1]] ?? "")' "$1" <<<"$STATUS"; }
export SUPABASE_URL="$(json API_URL)" SUPABASE_SERVICE_ROLE_KEY="$(json SERVICE_ROLE_KEY)"
psql_in() { docker exec -i "$DB_CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 -tA -d "$1" -c "$2"; }
t0=$(date +%s)

echo "1. Backing up to $OUT"
docker exec "$DB_CONTAINER" pg_dump -U postgres -Fc -n public -n vx_private -n auth -f /tmp/vx-drill.dump postgres
docker cp "$DB_CONTAINER:/tmp/vx-drill.dump" "$OUT/database.dump" >/dev/null
psql_in postgres "select bucket_id || E'\t' || name from storage.objects order by 1" \
  | node "$ROOT/services/orchestrator/src/backup-storage.ts" "$OUT/storage"
t1=$(date +%s)

echo "2. Restoring the database into $DRILL"
psql_in postgres "drop database if exists $DRILL" >/dev/null
psql_in postgres "create database $DRILL" >/dev/null
psql_in "$DRILL" "drop schema public" >/dev/null   # the dump recreates it
# Supabase's own default-privilege entries for supabase_admin cannot be recreated by postgres; everything else must restore.
docker exec "$DB_CONTAINER" pg_restore -U postgres -d "$DRILL" --no-owner /tmp/vx-drill.dump 2> "$OUT/restore.log" || true
other=$(grep -E 'ERROR:' "$OUT/restore.log" | grep -vc 'permission denied to change default privileges' || true)
if [ "$other" != "0" ]; then echo "restore failed ($other unexpected error(s)):"; grep -E 'ERROR:' "$OUT/restore.log" | grep -v 'default privileges'; exit 1; fi
echo "   restored ($(grep -c 'default privileges' "$OUT/restore.log" || true) Supabase-internal default-privilege entries skipped)"
t2=$(date +%s)

echo "3. Verifying the restored copy"
fail=0
COUNTS_SQL="select string_agg(t || '=' || n, ' ' order by t) from (select c.relname as t, (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from public.%I', c.relname), false, true, '')))[1]::text::bigint as n from pg_class c join pg_namespace s on s.oid = c.relnamespace where s.nspname = 'public' and c.relkind = 'r') x"
live=$(psql_in postgres "$COUNTS_SQL"); restored=$(psql_in "$DRILL" "$COUNTS_SQL")
if [ "$live" = "$restored" ]; then echo "   row counts: identical in $(wc -w <<<"$live") tables"; else echo "   row counts DIFFER"; diff <(tr ' ' '\n' <<<"$live") <(tr ' ' '\n' <<<"$restored") || true; fail=1; fi
chains=$(psql_in "$DRILL" "select count(*) || ' ' || count(*) filter (where not v.ok) from (select distinct project_id from public.audit_events) p, lateral public.verify_audit_chain(p.project_id) v")
read -r nchains nbroken <<<"$chains"
if [ "$nbroken" = "0" ]; then echo "   audit chains: $nchains verified"; else echo "   audit chains: $nbroken of $nchains BROKEN"; fail=1; fi
psql_in "$DRILL" "
  select 'project-files', storage_path, sha256 from public.artifact_versions
  union all select 'project-files', storage_path, sha256 from public.documents
  union all select 'project-files', image_path, sha256 from public.concept_variants where status = 'ready'
  union all select 'project-files', storage_path, sha256 from public.part_models where storage_path is not null and sha256 is not null
  union all select case when project_id is null then 'knowledge-files' else 'project-files' end, storage_path, sha256 from public.sources where storage_path is not null
  union all select 'project-files', packet_path, packet_sha256 from public.rfqs where packet_path is not null
  union all select 'project-files', storage_path, sha256 from public.flux_audit_files
  union all select 'project-files', report_path, report_sha256 from public.flux_audits where status = 'ready'" \
  | node -e '
    const fs = require("fs");
    const m = new Map(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).map((x) => [x.bucket + "/" + x.path, x.sha256]));
    let ok = 0, bad = [];
    for (const l of fs.readFileSync(0, "utf8").split("\n").filter(Boolean)) {
      const [b, p, s] = l.split("|");
      const have = m.get(b + "/" + p);
      if (have === s) ok++; else bad.push(`${b}/${p}: ${have ? "hash differs" : "not in the file backup"}`);
    }
    console.log(`   files: ${ok} recorded file(s) present in the backup with the recorded sha256${bad.length ? `, ${bad.length} PROBLEM(S)` : ""}`);
    for (const x of bad.slice(0, 20)) console.log("     " + x);
    process.exit(bad.length ? 1 : 0);' "$OUT/storage/manifest.json" || fail=1

echo "4. Cleaning up"
psql_in postgres "drop database $DRILL" >/dev/null
docker exec "$DB_CONTAINER" rm -f /tmp/vx-drill.dump
t3=$(date +%s)
echo "backup $((t1 - t0)) s, restore $((t2 - t1)) s, verification $((t3 - t2)) s; backup kept in $OUT ($(du -sh "$OUT" | cut -f1))"
[ "$fail" = 0 ] && echo "Backup and restore drill passed." || { echo "Backup and restore drill FAILED."; exit 1; }
