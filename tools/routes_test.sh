#!/usr/bin/env bash
# End-to-end check for the named route store (PLAN step 16): builds + starts the native server,
# then drives save/list/open/delete + the working-route autosave over WebSocket from node.
# Works offline — the store is pure disk I/O; the one match request in the flow asserts only the
# autosave that happens BEFORE the corridor fetch.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
loft="${LOFT_BIN:-$here/../loft/target/release/loft}"
port=18080
url="http://127.0.0.1:$port"

[ -x "$loft" ] || { echo "SKIP: loft not found at $loft (set LOFT_BIN)"; exit 2; }
command -v node >/dev/null || { echo "SKIP: node not found"; exit 2; }

fuser -k "$port"/tcp 2>/dev/null || true
sleep 1
echo "building + starting server (loft --native)…"
( cd "$here" && LOFT_TIMEOUT=0 "$loft" --native server/server.loft --lib "$here/lib" >"$here/scratch/srv_routes.log" 2>&1 ) &
srv=$!
cleanup() { kill "$srv" 2>/dev/null; fuser -k "$port"/tcp 2>/dev/null; }
trap cleanup EXIT

for i in $(seq 1 120); do
  curl -s -o /dev/null -m1 "$url/" 2>/dev/null && break
  kill -0 "$srv" 2>/dev/null || { echo "FAIL: server exited early"; tail -8 "$here/scratch/srv_routes.log"; exit 1; }
  sleep 1
done

echo "== WS route store round-trip =="
node "$here/tools/ws_routes.mjs" "ws://127.0.0.1:$port/ws" || { echo "FAILURES"; exit 1; }
