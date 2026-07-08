#!/usr/bin/env bash
# Headless proof that browser/standalone.html is a WORKING single-file app: it is loaded over file://
# with the network emulated fully OFF, runs the embedded loft matcher in wasm, and produces a route
# byte-identical to the native reference — no server, no fetch. (PLAN-APP Track 1: standalone.)
#
# NOTE: snap-confined Chromium cannot start inside a restrictive command sandbox (run outside it).
# Requires: node, chromium, the loft toolchain. Builds browser/standalone.html if it is missing.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
loft="${LOFT_BIN:-$(command -v loft)}"
loftroot="${LOFT_ROOT:-$here/../loft}"
chromium="${CHROMIUM_BIN:-chromium}"
dtport="${DTPORT:-9232}"

command -v node >/dev/null || { echo "SKIP: node not found"; exit 2; }
command -v "$chromium" >/dev/null || { echo "SKIP: chromium not found"; exit 2; }
[ -x "$loft" ] || { echo "SKIP: loft not found at $loft (set LOFT_BIN)"; exit 2; }

# Build the single-file app if absent (loft --html + inline wasm/data).
[ -f "$here/browser/standalone.html" ] || LOFT_BIN="$loft" LOFT_ROOT="$loftroot" node "$here/browser/build-standalone.mjs" || exit 1

# Native reference route (app_kernel's demo trace == the page's default sketch, so byte-comparable).
data="lib/routing_kernel/tests/fixtures/real_stretch.json"
ref="$(mktemp)"
( cd "$here" && "$loft" --native --path "$loftroot/" --lib "$here/lib" client/app_kernel.loft "$data" 2>/dev/null ) > "$ref"

rm -rf "$here/scratch/chromium-$dtport"; mkdir -p "$here/scratch"
chr=""
cleanup() { kill "$chr" 2>/dev/null; rm -f "$ref"; }
trap cleanup EXIT

echo "== headless chromium (CDP), file:// + network OFF =="
"$chromium" --headless=new --disable-gpu --no-sandbox \
  --user-data-dir="$here/scratch/chromium-$dtport" --remote-debugging-port="$dtport" about:blank >/dev/null 2>&1 &
chr=$!
sleep 4
node "$here/browser/cdp_verify_standalone.mjs" "127.0.0.1:$dtport" "file://$here/browser/standalone.html" "$ref"
