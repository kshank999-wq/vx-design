#!/usr/bin/env bash
# Starts a local ClamAV daemon for tests on port 3310. Uses the official signatures when freshclam can reach
# database.clamav.net; where that is blocked (as in some sandboxes), it runs with a single custom signature for the
# EICAR test file so the full scan path (clamd protocol, recording, blocking) is still exercised with a real clamd.
set -euo pipefail
DIR="${CLAMAV_DIR:-$(mktemp -d)}"
mkdir -p "$DIR/db"
printf 'Foreground yes\nTCPSocket 3310\nTCPAddr 0.0.0.0\nDatabaseDirectory /var/lib/clamav\nStreamMaxLength 300M\nUser clamav\n' > "$DIR/clamd.conf"
docker rm -f vx-clamav >/dev/null 2>&1 || true
if docker run --rm -v "$DIR/db:/var/lib/clamav" --entrypoint freshclam clamav/clamav:1.4 --datadir=/var/lib/clamav >/dev/null 2>&1; then
  echo "official signatures downloaded"
else
  echo "signature download blocked: using the EICAR test signature only"
  echo "44d88612fea8a8f36de82e1278abb02f:68:VX-Test-EICAR" > "$DIR/db/vxtest.hdb"
fi
chmod -R a+rwx "$DIR"
docker run -d --name vx-clamav -p 3310:3310 -v "$DIR/db:/var/lib/clamav" -v "$DIR/clamd.conf:/etc/clamav/vx.conf:ro" \
  --entrypoint clamd clamav/clamav:1.4 --config-file=/etc/clamav/vx.conf >/dev/null
for i in $(seq 1 60); do
  if printf 'zPING\0' | timeout 2 bash -c 'exec 3<>/dev/tcp/127.0.0.1/3310; cat >&3; cat <&3' 2>/dev/null | grep -q PONG; then echo "clamd ready on 127.0.0.1:3310"; exit 0; fi
  sleep 2
done
echo "clamd did not start" >&2; docker logs vx-clamav | tail -20 >&2; exit 1
