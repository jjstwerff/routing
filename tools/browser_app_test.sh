#!/usr/bin/env bash
# Headless-Chromium proof (PLAN-APP Track 1): the loft-NATIVE browser app fetches a whole test set and
# runs the full loft matcher in wasm (via loft --html's host_input/println engine — no jco, no WASI) —
# producing a route byte-identical to the native reference, and re-matching on a synthetic click.
#
# NOTE: snap-confined Chromium cannot start inside a restrictive command sandbox (run outside it).
# Requires: node, chromium, the loft toolchain. Builds browser/web_kernel.wasm if it is missing.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
loft="${LOFT_BIN:-$here/../loft/target/release/loft}"
loftroot="${LOFT_ROOT:-$here/../loft}"
chromium="${CHROMIUM_BIN:-chromium}"
port="${PORT:-8099}"; dtport="${DTPORT:-9231}"
url="http://127.0.0.1:$port/browser/"

command -v node >/dev/null || { echo "SKIP: node not found"; exit 2; }
command -v "$chromium" >/dev/null || { echo "SKIP: chromium not found"; exit 2; }
[ -x "$loft" ] || { echo "SKIP: loft not found at $loft (set LOFT_BIN)"; exit 2; }

# Build the browser wasm + terrain areas.txt + buildings.txt if absent (loft --html, loft emit_*).
{ [ -f "$here/browser/web_kernel.wasm" ] && [ -f "$here/browser/areas.txt" ] && [ -f "$here/browser/buildings.txt" ] && [ -f "$here/browser/places.txt" ] && [ -f "$here/browser/streets.txt" ]; } || LOFT_BIN="$loft" LOFT_ROOT="$loftroot" node "$here/browser/build.mjs" || exit 1

# Native reference route (app_kernel's demo trace == the page's default sketch, so byte-comparable).
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
node "$here/browser/cdp_verify.mjs" "127.0.0.1:$dtport" "$url" "$ref"
