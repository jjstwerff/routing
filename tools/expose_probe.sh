#!/usr/bin/env bash
# Copyright (c) 2026 Jurjen Stellingwerff
# SPDX-License-Identifier: LGPL-3.0-or-later
#
# Phase profile of the standalone store app in headless Chromium — the measurement PLAN-PERF rests on.
# Attributes the cost of `view` / `match` to wasm-side (store decode + text serialize) vs JS-side
# (text parse) vs render, so the design targets the real bottleneck instead of the assumed one.
#   tools/map_profile.sh
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
chromium="${CHROMIUM_BIN:-chromium}"
dtport="${DTPORT:-9247}"
httpport="${HTTPPORT:-8151}"
command -v node >/dev/null || { echo "SKIP: node not found"; exit 2; }
command -v python3 >/dev/null || { echo "SKIP: python3 not found"; exit 2; }
command -v "$chromium" >/dev/null || { echo "SKIP: chromium not found"; exit 2; }

node "$here/browser/build-site.mjs" || exit 1
[ -f "$here/browser/store-kernel.wasm" ] || { echo "SKIP: browser/store-kernel.wasm missing (run: node browser/build-store-kernel.mjs)"; exit 2; }

rm -rf "$here/scratch/chromium-$dtport"; mkdir -p "$here/scratch"
srv=""; chr=""
cleanup() { kill "$chr" "$srv" 2>/dev/null; }
trap cleanup EXIT
python3 -m http.server "$httpport" --directory "$here/_site" >/dev/null 2>&1 &
srv=$!
"$chromium" --headless=new --disable-gpu --no-sandbox --window-size=1000,700 \
  --user-data-dir="$here/scratch/chromium-$dtport" --remote-debugging-port="$dtport" about:blank >/dev/null 2>&1 &
chr=$!
sleep 4

echo "== step 9: does JS receive the layout handle? =="
node "$here/browser/cdp_expose.mjs" "127.0.0.1:$dtport" "http://127.0.0.1:$httpport/index.html"
rc=$?
exit $rc
