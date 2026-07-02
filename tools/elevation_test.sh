#!/usr/bin/env bash
# End-to-end check for the elevation profile (PLAN step 15) — fully OFFLINE: a synthetic terrarium
# tile is pre-placed in the server's disk cache (scratch/tiles), so no terrain fetch happens.
# Route lat 52.0, lon 4.97→5.0 sits in tile 13/4209/2705; the step tile makes up=100/down=0.
#
# Requires the loft toolchain (../loft by default, or $LOFT_BIN) and node. Binds a local port.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"      # routing repo root
loft="${LOFT_BIN:-$here/../loft/target/release/loft}"
port=18080
url="http://127.0.0.1:$port"

[ -x "$loft" ] || { echo "SKIP: loft not found at $loft (set LOFT_BIN)"; exit 2; }
command -v node >/dev/null || { echo "SKIP: node not found"; exit 2; }

echo "generating fixture tile 13/4209/2705…"
rm -f "$here/scratch/tiles/13_4209_2705.png"
( cd "$here" && "$loft" --interpret tools/make_terrarium_tile.loft --lib lib 13 4209 2705 ) \
  || { echo "FAIL: tile generator"; exit 1; }
[ -f "$here/scratch/tiles/13_4209_2705.png" ] || { echo "FAIL: fixture tile not written"; exit 1; }

# Kill any leftover instance holding the port (kill by PORT — loft --native detaches the binary).
fuser -k "$port"/tcp 2>/dev/null || true
sleep 1

echo "building + starting server (loft --native)…"
( cd "$here" && LOFT_TIMEOUT=0 "$loft" --native server/server.loft --lib "$here/lib" >"$here/scratch/srv_elev.log" 2>&1 ) &
srv=$!
cleanup() { kill "$srv" 2>/dev/null; fuser -k "$port"/tcp 2>/dev/null; }
trap cleanup EXIT

for i in $(seq 1 120); do
  curl -s -o /dev/null -m1 "$url/" 2>/dev/null && break
  kill -0 "$srv" 2>/dev/null || { echo "FAIL: server exited early"; tail -8 "$here/scratch/srv_elev.log"; exit 1; }
  sleep 1
done

echo "== WS elevation round-trip (offline tile) =="
node "$here/tools/ws_elevation.mjs" "ws://127.0.0.1:$port/ws" || { echo "FAILURES"; exit 1; }
echo "ALL PASS — elevation profile served from the cached tile, no network."
