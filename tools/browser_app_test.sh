#!/usr/bin/env bash
# Headless-Chromium proof (PLAN-APP Track 1a–c): the browser shell fetches a WHOLE test set and runs
# the full loft matcher in wasm (jco-transpiled) — NO server — producing a route byte-identical to the
# native reference. Offline, self-contained (SVG draw, no map-tile CDN).
#
# NOTE: snap-confined Chromium cannot start inside a restrictive command sandbox (run outside it).
# Requires: node, chromium, the loft toolchain, and a built browser/gen (npm i + jco transpile).
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
loft="${LOFT_BIN:-$here/../loft/target/release/loft}"
loftroot="${LOFT_ROOT:-$here/../loft}"
chromium="${CHROMIUM_BIN:-chromium}"
port="${PORT:-8099}"; dtport="${DTPORT:-9224}"
url="http://127.0.0.1:$port/browser/"

command -v node >/dev/null || { echo "SKIP: node not found"; exit 2; }
command -v "$chromium" >/dev/null || { echo "SKIP: chromium not found"; exit 2; }
[ -x "$loft" ] || { echo "SKIP: loft not found at $loft (set LOFT_BIN)"; exit 2; }
[ -f "$here/browser/gen/app_kernel.js" ] || { echo "SKIP: browser/gen missing — run: npm --prefix browser i && npm --prefix browser run build"; exit 2; }

# Native reference route (demo trace == the page's sketch, so byte-comparable).
data="lib/routing_kernel/tests/fixtures/real_stretch.json"
ref="$(mktemp)"
( cd "$here" && "$loft" --native --path "$loftroot/" --lib "$here/lib" client/app_kernel.loft "$data" 2>/dev/null ) > "$ref"

fuser -k "$port"/tcp 2>/dev/null || true; sleep 1
mkdir -p "$here/scratch"; rm -rf "$here/scratch/chromium-$dtport"
node "$here/browser/serve.mjs" "$port" >"$here/scratch/srv_app.log" 2>&1 &
srv=$!
chr=""
cleanup() { kill "$srv" "$chr" 2>/dev/null; fuser -k "$port"/tcp 2>/dev/null; rm -f "$ref"; }
trap cleanup EXIT

for _ in $(seq 1 60); do curl -s -o /dev/null -m1 "$url" && break; sleep 0.5; done

echo "== headless chromium (CDP) =="
"$chromium" --headless=new --disable-gpu --no-sandbox \
  --user-data-dir="$here/scratch/chromium-$dtport" --remote-debugging-port="$dtport" about:blank >/dev/null 2>&1 &
chr=$!
sleep 4
node "$here/browser/cdp_app_test.mjs" "127.0.0.1:$dtport" "$url" "$ref"
