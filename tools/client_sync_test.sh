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
dtport=9224
url="http://127.0.0.1:$port"

[ -x "$loft" ] || { echo "SKIP: loft not found at $loft (set LOFT_BIN)"; exit 2; }
command -v "$chromium" >/dev/null || { echo "SKIP: chromium not found"; exit 2; }
command -v node >/dev/null || { echo "SKIP: node not found"; exit 2; }

fuser -k "$port"/tcp 2>/dev/null || true
sleep 1
# Hermetic run: no chromium session restore, no stale test route, no leftover working sketch
# (this test overwrites _working anyway — see the NOTE above).
rm -rf "$here/scratch/chromium-$dtport"
rm -f "$here/routes/CDP_Sync_Route.route" "$here/routes/_working.route"
echo "building + starting server (loft --native)…"
( cd "$here" && LOFT_TIMEOUT=0 "$loft" --native server/server.loft --lib "$here/lib" >"$here/scratch/srv_csync.log" 2>&1 ) &
srv=$!
chr=""
cleanup() { kill "$srv" "$chr" 2>/dev/null; fuser -k "$port"/tcp 2>/dev/null; }
trap cleanup EXIT

for i in $(seq 1 120); do
  curl -s -o /dev/null -m1 "$url/" 2>/dev/null && break
  kill -0 "$srv" 2>/dev/null || { echo "FAIL: server exited early"; tail -8 "$here/scratch/srv_csync.log"; exit 1; }
  sleep 1
done

echo "== headless chromium, two tabs (CDP) =="
"$chromium" --headless=new --disable-gpu --no-sandbox --user-data-dir="$here/scratch/chromium-$dtport" --remote-debugging-port=$dtport "$url/" >/dev/null 2>&1 &
chr=$!
sleep 4
node "$here/tools/cdp_sync.mjs" "127.0.0.1:$dtport" "$url" \
  && echo "ALL PASS — an edit in one tab appears in the other, echo-free." \
  || { echo "FAILURES"; exit 1; }
