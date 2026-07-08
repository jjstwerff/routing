#!/usr/bin/env bash
# End-to-end check for the routing server (PLAN step 4): builds + starts the native loft server,
# then verifies the points→length round-trip over WebSocket from BOTH a Node client and a real
# browser (headless Chromium), plus that the server serves the static client over HTTP.
#
# Requires the loft toolchain (../loft by default, or $LOFT_BIN), node, and chromium. Binds a
# local port, so run it outside any network sandbox.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"      # routing repo root
loft="${LOFT_BIN:-$here/../loft/target/release/loft}"
port=18080
url="http://127.0.0.1:$port"
fail=0

[ -x "$loft" ] || { echo "SKIP: loft not found at $loft (set LOFT_BIN)"; exit 2; }
command -v node >/dev/null || { echo "SKIP: node not found"; exit 2; }

# Kill any leftover instance holding the port (loft --native spawns a detached server binary,
# so we must kill by PORT, not by the wrapper process).
fuser -k "$port"/tcp 2>/dev/null || true
sleep 1

echo "building + starting server (loft --native)…"
( cd "$here" && LOFT_TIMEOUT=0 "$loft" --native server/server.loft --lib "$here/lib" >"$here/scratch/srv.log" 2>&1 ) &
srv=$!
cleanup() { kill "$srv" 2>/dev/null; fuser -k "$port"/tcp 2>/dev/null; }
trap cleanup EXIT

for i in $(seq 1 120); do
  curl -s -o /dev/null -m1 "$url/" 2>/dev/null && break
  kill -0 "$srv" 2>/dev/null || { echo "FAIL: server exited early"; tail -8 "$here/scratch/srv.log"; exit 1; }
  sleep 1
done

echo "== HTTP static serve =="
if curl -s -m5 "$url/" | grep -qi "<!doctype html>"; then echo "PASS http serves index.html"; else echo "FAIL http"; fail=1; fi

echo "== Node WS round-trip =="
node "$here/tools/ws_roundtrip.mjs" "ws://127.0.0.1:$port/ws" || fail=1

echo "== server log tail =="; tail -3 "$here/scratch/srv.log"
[ "$fail" -eq 0 ] && echo "ALL PASS — server serves the client + round-trips points→length over WS." || { echo "FAILURES"; exit 1; }
