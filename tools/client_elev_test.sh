#!/usr/bin/env bash
# Headless-Chromium check for the elevation dock (PLAN step 15) — fully OFFLINE.
# The real server serves the client + answers WS 10 from the cached synthetic tile; Chromium is
# driven over the DevTools protocol (tools/cdp_elev.mjs — plain node, no puppeteer) to verify:
# dock closed by default, opens on toggle, draws the profile (canvas pixels), totals ↑100/↓0.
#
# NOTE: snap-confined Chromium cannot start inside restrictive command sandboxes
# (snap-confine needs cap_dac_override) — run this from a normal shell.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
loft="${LOFT_BIN:-$here/../loft/target/release/loft}"
chromium="${CHROMIUM_BIN:-chromium}"
port=18080
profile="$here/scratch/chromium-client_elev"
url="http://127.0.0.1:$port"

[ -x "$loft" ] || { echo "SKIP: loft not found at $loft (set LOFT_BIN)"; exit 2; }
command -v "$chromium" >/dev/null || { echo "SKIP: chromium not found"; exit 2; }
command -v node >/dev/null || { echo "SKIP: node not found"; exit 2; }

echo "generating fixture tile 13/4209/2705…"
( cd "$here" && "$loft" --interpret tools/make_terrarium_tile.loft --lib lib 13 4209 2705 >/dev/null ) \
  || { echo "FAIL: tile generator"; exit 1; }

sleep 1
rm -rf "$profile"   # hermetic: localStorage (dock/profile/goals) must not leak between runs
echo "building + starting server (loft --native)…"
( cd "$here" && LOFT_TIMEOUT=0 "$loft" --native server/server.loft --lib "$here/lib" >"$here/scratch/srv_celev.log" 2>&1 ) &
srv=$!
cleanup() { [ -n "$srv" ] && kill "$srv" 2>/dev/null; return 0; }
trap cleanup EXIT

for i in $(seq 1 120); do
  curl -s -o /dev/null -m1 "$url/" 2>/dev/null && break
  kill -0 "$srv" 2>/dev/null || { echo "FAIL: server exited early"; tail -8 "$here/scratch/srv_celev.log"; exit 1; }
  sleep 1
done

echo "== headless chromium (CDP) =="
# ⚠ THIS SCRIPT NO LONGER LAUNCHES A BROWSER, and that is the point. It used to start Chromium on a
# debugging PORT and take it down from `trap cleanup EXIT` — correct for every way this script ends, and
# useless for the way it actually dies (a timeout or an interrupted turn kills the shell, no trap runs,
# and a detached browser owned by nobody runs for days). The driver now owns it over a CDP pipe, so the
# browser cannot outlive `node` on any OS and there is nothing here to clean up. See browser/cdp_transport.mjs.
CHROMIUM_BIN="$chromium" node "$here/tools/cdp_elev.mjs" "$profile" "$url" \
  && echo "ALL PASS — dock closed by default, opens, draws the profile from the cached tile." \
  || { echo "FAILURES"; exit 1; }
