#!/bin/sh
# Keeps this host's workers on the newest images. Runs in the "updater" service (docker CLI image, with the host's
# Docker socket and this folder mounted at /deploy): every UPDATE_INTERVAL_SECONDS it pulls the worker images and
# recreates the workers whose image changed. Work in progress is safe: a stopped worker's job goes back to the queue
# and resumes from its last checkpoint. It never recreates itself (only the services listed below).
set -u
cd /deploy
interval="${UPDATE_INTERVAL_SECONDS:-900}"
# The compose project this updater was started in (its own container's label), so it updates that project's workers.
project=$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project" }}' "$(hostname)" 2>/dev/null || true)
[ -n "$project" ] || project="vx-workers"
dc() { docker compose -p "$project" "$@"; }
services="worker clamav"
case ",${COMPOSE_PROFILES:-}," in *,engineering,*) services="$services engineering" ;; esac

if [ -n "${GHCR_TOKEN:-}" ]; then
  if echo "$GHCR_TOKEN" | docker login ghcr.io -u "${GHCR_USER:-vx}" --password-stdin >/dev/null 2>&1; then
    echo "updater: signed in to ghcr.io"
  else
    echo "updater: could not sign in to ghcr.io with GHCR_TOKEN (expired, or missing read:packages); private images cannot be pulled"
  fi
else
  echo "updater: GHCR_TOKEN is not set in workers.env; private images from ghcr.io cannot be pulled"
fi
echo "updater: project $project; checking $services every ${interval}s"

while true; do
  if out=$(dc pull --quiet $services 2>&1); then
    dc up -d --no-deps $services 2>&1 | grep -E "Recreat|Start|Creat" | sed 's/^/updater: /'
    docker image prune -f >/dev/null 2>&1
  else
    echo "updater: pull failed (will retry): $(echo "$out" | tail -n 2 | tr '\n' ' ')"
  fi
  sleep "$interval"
done
