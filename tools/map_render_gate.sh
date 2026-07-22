#!/usr/bin/env bash
# Copyright (c) 2026 Jurjen Stellingwerff  SPDX-License-Identifier: LGPL-3.0-or-later
#
# PLAN-BUILD gate — headless proof that the standalone store app renders and routes in a real browser:
#   1. map.test.mjs — the projection / pan-zoom invariant (pure math, no browser).
#   2. build-site.mjs — assemble the deployable _site (inlines the app).
#   3. drive _site/index.html in headless Chromium: `view <bbox>` renders the region on load, and a `match`
#      draws the matched route. The app fetches its stores by URL, so _site is served over HTTP (same origin).
#
# NOTE: snap-confined Chromium cannot start inside a restrictive command sandbox (run outside it).
# Requires: node, python3, chromium, and browser/store-kernel.wasm (build: node browser/build-store-kernel.mjs).
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
chromium="${CHROMIUM_BIN:-chromium}"
dtport="${DTPORT:-9233}"
httpport="${HTTPPORT:-8137}"
command -v node >/dev/null || { echo "SKIP: node not found"; exit 2; }
command -v python3 >/dev/null || { echo "SKIP: python3 not found"; exit 2; }
command -v "$chromium" >/dev/null || { echo "SKIP: chromium not found"; exit 2; }

# 1. Projection invariant + the PLAN-EDIT E0 chokepoints (no browser needed).
node "$here/browser/map.test.mjs" || exit 1

# 1b. PLAN-EDIT E0 — the chokepoints must stay SINGULAR, which is a property of the SOURCE, not of a run.
# A second pointer binding or a second road to the kernel is invisible at runtime until the two disagree, and
# that is exactly how P1 (a pan appending a point) and P4 (a dropped match) survived for two months. Count
# the sites instead: the invariant is "one road in, one road out" (PLAN-EDIT §4).
echo "== PLAN-EDIT E0: the chokepoints are singular =="
e0rc=0
ptr=$(grep -cE "addEventListener\('(pointerdown|pointerup|pointermove|pointercancel|click|mousedown|mouseup|mousemove)'" "$here/browser/rough.mjs")
stray=$(grep -nE "addEventListener\('(pointerdown|pointerup|pointermove|pointercancel|click|mousedown|mouseup|mousemove)'" \
        "$here/browser/store-app.mjs" "$here/browser/map.mjs" || true)
if [ -n "$stray" ]; then
  echo "  FAIL: a pointer/click listener lives outside rough.mjs — input dispatch is no longer a chokepoint:"; echo "$stray"; e0rc=1
elif [ "$ptr" -lt 4 ]; then
  echo "  FAIL: rough.mjs binds $ptr pointer listeners (expected the 4 of the one dispatcher)"; e0rc=1
else
  echo "  ✓ every pointer/click listener is in rough.mjs ($ptr of them, one dispatcher)"
fi
# Reaching the kernel outside the queue re-opens P4 — and `runKernel` keeps ONE resolve slot, so a second
# road to it does not merely race, it orphans a promise. The APP section (everything above the test-only
# __perfHooks block, which measures the kernel in isolation on purpose) must hold exactly two calls: the
# `view` inside ensureViewNow and the `match` inside streamedMatch, both bodies of a queued job.
app_end=$(grep -n 'window.__perfHooks = {' "$here/browser/store-app.mjs" | head -1 | cut -d: -f1)
app_calls=$(head -n "${app_end:-0}" "$here/browser/store-app.mjs" | grep -c 'kernel.runKernel')
if [ "$app_calls" -ne 2 ]; then
  echo "  FAIL: the app reaches the kernel from $app_calls places (expected 2 — ensureViewNow + streamedMatch);"
  echo "        a third is a road around the queue, which is how a match gets dropped (P4)."
  head -n "${app_end:-0}" "$here/browser/store-app.mjs" | grep -n 'kernel.runKernel'
  e0rc=1
else
  echo "  ✓ the app reaches the kernel from exactly 2 places, both inside queued jobs"
fi
[ $e0rc -eq 0 ] || exit 1

# 1a. PLAN-PERF §6e — is the browser kernel threaded? `par` (step 18) is a no-op while it is not.
echo "== step 18 tripwire: browser kernel threading =="
node "$here/tools/wasm_threads.mjs" || exit 1

# 2. Build the deployable site (inlines map.mjs + store-kernel.mjs + store-app.mjs → _site/index.html).
node "$here/browser/build-site.mjs" || exit 1
[ -f "$here/browser/store-kernel.wasm" ] || { echo "SKIP: browser/store-kernel.wasm missing (run: node browser/build-store-kernel.mjs)"; exit 2; }

# 3. Serve _site + drive it in headless Chromium.
rm -rf "$here/scratch/chromium-$dtport"; mkdir -p "$here/scratch"
srv=""; chr=""; rc=0
cleanup() { kill "$chr" "$srv" 2>/dev/null; }
trap cleanup EXIT
python3 -m http.server "$httpport" --directory "$here/_site" >/dev/null 2>&1 &
srv=$!
"$chromium" --headless=new --disable-gpu --no-sandbox --window-size=1000,700 \
  --user-data-dir="$here/scratch/chromium-$dtport" --remote-debugging-port="$dtport" about:blank >/dev/null 2>&1 &
chr=$!
sleep 4

echo "== PLAN-BUILD store-app gate (view <bbox> + match, headless HTTP) =="
node "$here/browser/cdp_verify_store.mjs" "127.0.0.1:$dtport" "http://127.0.0.1:$httpport/index.html" || rc=1

# 4. The deployed artifact must be self-contained (all modules inlined — no external .mjs to trip Pages MIME).
if grep -qE 'src="\./[A-Za-z0-9_-]+\.mjs"' "$here/_site/index.html"; then
  echo "  FAIL: _site/index.html references an external .mjs (not inlined)"; rc=1
else
  echo "  ✓ _site/index.html is self-contained (modules inlined)"
fi
exit $rc
