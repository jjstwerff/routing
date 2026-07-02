#!/usr/bin/env bash
# End-to-end check for live sync (PLAN step 19): three WebSocket clients — subscribe via open/save,
# edit broadcast (echo-free), late-joiner replay via plain open, unsubscribe by switching routes.
# Works offline (assertions stop at the rough-points part of the broadcast).
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
( cd "$here" && LOFT_TIMEOUT=0 "$loft" --native server/server.loft --lib "$here/lib" >"$here/scratch/srv_sync.log" 2>&1 ) &
srv=$!
cleanup() { kill "$srv" 2>/dev/null; fuser -k "$port"/tcp 2>/dev/null; }
trap cleanup EXIT

for i in $(seq 1 120); do
  curl -s -o /dev/null -m1 "$url/" 2>/dev/null && break
  kill -0 "$srv" 2>/dev/null || { echo "FAIL: server exited early"; tail -8 "$here/scratch/srv_sync.log"; exit 1; }
  sleep 1
done

echo "== WS live-sync (3 clients) =="
node "$here/tools/ws_sync.mjs" "ws://127.0.0.1:$port/ws" || { echo "FAILURES"; exit 1; }
