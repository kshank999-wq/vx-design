#!/usr/bin/env bash
# Builds the engineering worker image. Set EXTRA_CA_CERT to a CA bundle path when
# building behind a TLS-intercepting proxy.
set -euo pipefail
cd "$(dirname "$0")"
args=()
if [ -n "${EXTRA_CA_CERT:-}" ]; then args+=(--secret "id=extra_ca,src=$EXTRA_CA_CERT"); fi
DOCKER_BUILDKIT=1 docker build "${args[@]}" -t "${IMAGE:-vx-engineering:g0}" .
