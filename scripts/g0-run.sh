#!/usr/bin/env bash
# Builds the engineering worker image, runs the G0 capability audit, and copies the
# report and sample outputs (evidence) into docs/g0/. Raw run output stays in $OUT (default: ./g0-out).
#
# Optional environment:
#   EXTRA_CA_CERT                  CA bundle for TLS-intercepting proxies (build only)
#   DIGIKEY_CLIENT_ID/SECRET, MOUSER_API_KEY, NEXAR_CLIENT_ID/SECRET   live part-data API tests
#   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY                           upsert results to tool_capabilities
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${OUT:-$ROOT/g0-out}"
IMAGE="${IMAGE:-vx-engineering:g0}"

if [ "${SKIP_BUILD:-0}" != "1" ]; then IMAGE="$IMAGE" "$ROOT/services/engineering/build.sh"; fi

rm -rf "$OUT" && mkdir -p "$OUT" && chmod 777 "$OUT"
env_args=()
for v in DIGIKEY_CLIENT_ID DIGIKEY_CLIENT_SECRET MOUSER_API_KEY NEXAR_CLIENT_ID NEXAR_CLIENT_SECRET \
         SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY; do
  if [ -n "${!v:-}" ]; then env_args+=(-e "$v"); fi
done
docker run --rm "${env_args[@]}" -v "$OUT:/out" "$IMAGE"

mkdir -p "$ROOT/docs/g0"
cp "$OUT/report.md" "$ROOT/docs/g0/capability-matrix.md"
cp "$OUT/results.json" "$ROOT/docs/g0/results.json"
rm -rf "$ROOT/docs/g0/samples" && cp -r "$OUT/samples" "$ROOT/docs/g0/samples"
echo "Report: docs/g0/capability-matrix.md   Samples: $OUT/samples"
