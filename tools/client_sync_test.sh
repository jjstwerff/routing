#!/usr/bin/env bash
# Headless-Chromium two-tab check for live sync (PLAN step 19): an edit in tab 1 appears in tab 2
# without tab 2 sending anything (echo-free apply). Driven over the DevTools protocol.
# NOTE: overwrites the developer's "_working" sketch.
# NOTE: snap-confined Chromium cannot start inside restrictive command sandboxes.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
loft="${LOFT_BIN:-$here/../loft/target/release/loft}"
chromium="${CHROMIUM_BIN:-chromium}"
port=18080
profile="$here/scratch/chromium-client_sync"
url="http://127.0.0.1:$port"

[ -x "$loft" ] || { echo "SKIP: loft not found at $loft (set LOFT_BIN)"; exit 2; }
command -v "$chromium" >/dev/null || { echo "SKIP: chromium not found"; exit 2; }
command -v node >/dev/null || { echo "SKIP: node not found"; exit 2; }

sleep 1
# Hermetic run: no chromium session restore, no stale test route, no leftover working sketch
# (this test overwrites _working anyway — see the NOTE above).
rm -rf "$profile"
rm -f "$here/routes/CDP_Sync_Route.route" "$here/routes/_working.route"
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
( cd "$here" && LOFT_TIMEOUT="${SERVER_TIMEOUT:-900}" exec "$loft" --native server/server.loft --lib "$here/lib" >"$here/scratch/srv_csync.log" 2>&1 ) &
srv=$!
cleanup() { [ -n "$srv" ] && kill "$srv" 2>/dev/null; return 0; }
trap cleanup EXIT

for i in $(seq 1 120); do
  curl -s -o /dev/null -m1 "$url/" 2>/dev/null && break
  kill -0 "$srv" 2>/dev/null || { echo "FAIL: server exited early"; tail -8 "$here/scratch/srv_csync.log"; exit 1; }
  sleep 1
done

echo "== headless chromium, two tabs (CDP) =="
# ⚠ THIS SCRIPT NO LONGER LAUNCHES A BROWSER, and that is the point. It used to start Chromium on a
# debugging PORT and take it down from `trap cleanup EXIT` — correct for every way this script ends, and
# useless for the way it actually dies (a timeout or an interrupted turn kills the shell, no trap runs,
# and a detached browser owned by nobody runs for days). The driver now owns it over a CDP pipe, so the
# browser cannot outlive `node` on any OS and there is nothing here to clean up. See browser/cdp_transport.mjs.
CHROMIUM_BIN="$chromium" node "$here/tools/cdp_sync.mjs" "$profile" "$url" \
  && echo "ALL PASS — an edit in one tab appears in the other, echo-free." \
  || { echo "FAILURES"; exit 1; }
