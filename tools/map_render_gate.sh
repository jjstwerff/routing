#!/usr/bin/env bash
# Copyright (c) 2026 Jurjen Stellingwerff  SPDX-License-Identifier: LGPL-3.0-or-later
#
# PLAN-MAP M0 gate — headless proof that browser/map.mjs renders on a REAL canvas: the camera centre
# projects to the viewport centre, unproject∘project round-trips, render() paints, and a resize keeps
# the centre centred. Loads browser/map-demo.html over file:// with --allow-file-access-from-files so
# the ES-module import (`import {RouteMap} from './map.mjs'`) resolves without a server.
#
# NOTE: snap-confined Chromium cannot start inside a restrictive command sandbox (run outside it).
# Requires: node, chromium.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
chromium="${CHROMIUM_BIN:-chromium}"
dtport="${DTPORT:-9233}"
command -v node >/dev/null || { echo "SKIP: node not found"; exit 2; }
command -v "$chromium" >/dev/null || { echo "SKIP: chromium not found"; exit 2; }

# Pure-math check first (no browser needed) — the projection invariant.
node "$here/browser/map.test.mjs" || exit 1

# Build the deployable site (bakes browser/tiles/ + inlines _site/index.html) if the layers are present.
if [ -f "$here/browser/areas.txt" ]; then node "$here/browser/build-site.mjs" || exit 1; fi

rm -rf "$here/scratch/chromium-$dtport"; mkdir -p "$here/scratch"
chr=""; rc=0
cleanup() { kill "$chr" 2>/dev/null; }
trap cleanup EXIT

echo "== M0..M3b headless canvas gate (CDP, file://) =="
"$chromium" --headless=new --disable-gpu --no-sandbox --allow-file-access-from-files \
  --user-data-dir="$here/scratch/chromium-$dtport" --remote-debugging-port="$dtport" about:blank >/dev/null 2>&1 &
chr=$!
sleep 4
node "$here/browser/cdp_verify_map.mjs" "127.0.0.1:$dtport" "file://$here/browser/map-demo.html" || rc=1

# M4: whole-region tiled working set (dev app: map.html + browser/tiles/).
if [ -f "$here/browser/tiles/index.json" ]; then
  echo "== M4 tiled-working-set gate (index.html) =="
  node "$here/browser/cdp_verify_tiles.mjs" "127.0.0.1:$dtport" "file://$here/browser/index.html" || rc=1
else
  echo "~ M4 skipped: no browser/tiles/ (needs the whole-region layers)"
fi

# M5: the DEPLOYED artifact (_site/index.html — inlined, Leaflet-free) must run + be Leaflet-free.
if [ -f "$here/_site/index.html" ]; then
  echo "== M5 deployed-artifact gate (_site/index.html) =="
  node "$here/browser/cdp_verify_tiles.mjs" "127.0.0.1:$dtport" "file://$here/_site/index.html" || rc=1
  # No Leaflet USAGE: its `L.` API global (non-letter before capital L, so "URL." doesn't match) or a
  # vendored leaflet.js/.css asset. A descriptive comment mentioning Leaflet is fine — we're checking deps.
  if grep -qE "[^A-Za-z]L\.[A-Za-z]" "$here/_site/index.html" || grep -qiE "leaflet\.(js|css)|vendor/leaflet" "$here/_site/index.html"; then echo "  FAIL: _site/index.html still uses Leaflet"; rc=1; else echo "  ✓ _site/index.html is Leaflet-free"; fi
fi
exit $rc
