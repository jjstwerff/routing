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

sleep 1
echo "building + starting server (loft --native)…"
# ⚠ `exec` AND A BOUNDED `LOFT_TIMEOUT`, AND BOTH ARE LOAD-BEARING.
#
# `( … "$loft" … ) &` makes `$!` the SUBSHELL, not the server, so `kill "$srv"` killed the wrapper and
# left the server holding the port. That is what `fuser -k "$port"/tcp` was really for — and `fuser` is
# Linux-only AND kills whatever holds the port, which may be a process this run never started. `exec`
# replaces the subshell with the server, so `$!` is the server and killing it works.
#
# `LOFT_TIMEOUT=0` then made it immortal: nothing bounded it, so a run killed before its trap could fire
# left a server running until the machine rebooted. A bounded timeout is loft's own watchdog (PLAN49) —
# cross-platform, and it ends only this run's server. The same shape as the browser's pipe: the thing you
# start cannot outlive you by more than a known amount. Override with SERVER_TIMEOUT=<secs>.
( cd "$here" && LOFT_TIMEOUT="${SERVER_TIMEOUT:-900}" exec "$loft" --native server/server.loft --lib "$here/lib" >"$here/scratch/srv_routes.log" 2>&1 ) &
srv=$!
cleanup() { [ -n "$srv" ] && kill "$srv" 2>/dev/null; return 0; }
trap cleanup EXIT

for i in $(seq 1 120); do
  curl -s -o /dev/null -m1 "$url/" 2>/dev/null && break
  kill -0 "$srv" 2>/dev/null || { echo "FAIL: server exited early"; tail -8 "$here/scratch/srv_routes.log"; exit 1; }
  sleep 1
done

echo "== WS route store round-trip =="
node "$here/tools/ws_routes.mjs" "ws://127.0.0.1:$port/ws" || { echo "FAILURES"; exit 1; }
