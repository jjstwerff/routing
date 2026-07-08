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

rm -rf "$here/scratch/chromium-$dtport"; mkdir -p "$here/scratch"
chr=""
cleanup() { kill "$chr" 2>/dev/null; }
trap cleanup EXIT

echo "== M0 headless canvas gate (CDP, file://) =="
"$chromium" --headless=new --disable-gpu --no-sandbox --allow-file-access-from-files \
  --user-data-dir="$here/scratch/chromium-$dtport" --remote-debugging-port="$dtport" about:blank >/dev/null 2>&1 &
chr=$!
sleep 4
node "$here/browser/cdp_verify_map.mjs" "127.0.0.1:$dtport" "file://$here/browser/map-demo.html"
