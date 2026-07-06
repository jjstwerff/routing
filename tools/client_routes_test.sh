#!/usr/bin/env bash
# Headless-Chromium check for the routes panel + working-route restore (PLAN step 16), driven over
# the DevTools protocol (tools/cdp_routes.mjs). Offline — the store is disk I/O; the sketch's match
# request may fail without network, which the autosave tolerates by design.
# NOTE: overwrites the developer's "_working" sketch (the reload-restore IS the test).
# NOTE: snap-confined Chromium cannot start inside restrictive command sandboxes.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
loft="${LOFT_BIN:-$here/../loft/target/release/loft}"
chromium="${CHROMIUM_BIN:-chromium}"
port=18080
dtport=9223
url="http://127.0.0.1:$port"

[ -x "$loft" ] || { echo "SKIP: loft not found at $loft (set LOFT_BIN)"; exit 2; }
command -v "$chromium" >/dev/null || { echo "SKIP: chromium not found"; exit 2; }
command -v node >/dev/null || { echo "SKIP: node not found"; exit 2; }

fuser -k "$port"/tcp 2>/dev/null || true
sleep 1
rm -rf "$here/scratch/chromium-9223"   # hermetic: localStorage (dock/profile/goals) must not leak between runs
echo "building + starting server (loft --native)…"
( cd "$here" && LOFT_TIMEOUT=0 "$loft" --native server/server.loft --lib "$here/lib" >"$here/scratch/srv_croutes.log" 2>&1 ) &
srv=$!
chr=""
cleanup() { kill "$srv" "$chr" 2>/dev/null; fuser -k "$port"/tcp 2>/dev/null; }
trap cleanup EXIT

for i in $(seq 1 120); do
  curl -s -o /dev/null -m1 "$url/" 2>/dev/null && break
  kill -0 "$srv" 2>/dev/null || { echo "FAIL: server exited early"; tail -8 "$here/scratch/srv_croutes.log"; exit 1; }
  sleep 1
done

echo "== headless chromium (CDP) =="
"$chromium" --headless=new --disable-gpu --no-sandbox --user-data-dir="$here/scratch/chromium-$dtport" --remote-debugging-port=$dtport "$url/" >/dev/null 2>&1 &
chr=$!
sleep 4
node "$here/tools/cdp_routes.mjs" "127.0.0.1:$dtport" "$url" \
  && echo "ALL PASS — panel save/list/open/delete + reload restores the working sketch." \
  || { echo "FAILURES"; exit 1; }
