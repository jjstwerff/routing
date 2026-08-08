#!/usr/bin/env bash
# Copyright (c) 2026 Jurjen Stellingwerff
# SPDX-License-Identifier: LGPL-3.0-or-later
#
# A CROSS-ORIGIN PAGED STORE MUST OPEN WITHOUT THE PREFETCH — the regression gate for a bug that had
# no error, no failed request and no console line.
#
# The app draws the base map from another origin (`coverage.json` points the region base stores at their
# own Pages repos). `Content-Range` is NOT CORS-safelisted and Pages sends no
# `access-control-expose-headers`, so cross-origin the reader cannot see it — while `Content-Length`
# stays readable and looks like an answer. On a 206 that header is the length of the PART, so using it as
# the file total told loft an 812 MB store was ONE BYTE (the open probe's length). The store then never
# opened: 2 588 reads for 2 588 bytes, `rangeFailed=0`, and a blank base map.
#
# ⚠ IT WAS INVISIBLE BECAUSE THE PREFETCH MASKED IT. The prefetch path takes the size from
# `coverage.json` rather than from a header, so with prefetching on — which is always, in the app — the
# store opened and everything drew. The failure only existed on the path the app does not normally take,
# which is exactly the ground the index does not cover.
#
# So the gate turns the prefetch OFF (`window.__prefetchScope='none'`) and requires the map to DRAW
# anyway. That is the assertion: prefetching is an optimisation, and an optimisation that becomes
# load-bearing for CORRECTNESS has stopped being one.
set -uo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
chromium="${CHROMIUM_BIN:-chromium}"
port="${HTTPPORT:-8179}"
profile="$here/scratch/chromium-crossorigin"

command -v node >/dev/null || { echo "SKIP: node not found"; exit 2; }
command -v python3 >/dev/null || { echo "SKIP: python3 not found"; exit 2; }
command -v "$chromium" >/dev/null || { echo "SKIP: chromium not found"; exit 2; }
[ -f "$here/_site/index.html" ] || { echo "SKIP: no _site (run: node browser/build-site.mjs)"; exit 2; }
# The whole point is a store on ANOTHER origin, so this one needs the network.
curl -sf -o /dev/null --max-time 10 -r 0-0 https://jjstwerff.github.io/routing-data-nl-midwest/nl-midwest.base.store \
  || { echo "SKIP: the cross-origin data host is unreachable"; exit 2; }

echo "== a cross-origin paged store opens with NO prefetch =="
rm -rf "$profile"; mkdir -p "$here/scratch"
python3 "$here/tools/range_server.py" "$port" "$here/_site" /dev/null >/dev/null 2>&1 &
srv=$!
cleanup() { kill "$srv" 2>/dev/null; }
trap cleanup EXIT
sleep 1

out="$(CDP_TIMEOUT_MS=300000 CHROMIUM_BIN="$chromium" timeout 500 \
      node "$here/browser/cdp_trap_scope.mjs" "$profile" "http://127.0.0.1:$port/index.html" none 2>&1)"
echo "$out" | grep -E "scope=|DREW|SESSION" || true

drew="$(echo "$out" | grep -oE 'DREW [0-9]+' | grep -oE '[0-9]+' | head -1)"
hits="$(echo "$out" | grep -oE '· [0-9]+ prefetch hits' | grep -oE '[0-9]+' | head -1)"

# Non-vacuity FIRST (§2): an arm that read nothing cannot fail, so "drew > 0" is only meaningful once
# the prefetch is confirmed OFF. Without this the gate passes hardest when it is testing least.
if [ "${hits:-0}" != "0" ]; then
  echo "  FAIL: the prefetch was ON (${hits} hits) — this gate tests the path WITHOUT it"; exit 1
fi
if [ -z "$drew" ] || [ "$drew" -lt 1000 ]; then
  echo "  FAIL: the base map drew ${drew:-no} features with the prefetch off."
  echo "        A cross-origin 206 has no readable Content-Range; if Content-Length is used as the file"
  echo "        total it is the PART length, and loft is told the store is one byte long."
  exit 1
fi
echo "  ✓ drew $drew features from another origin with 0 prefetch hits — the store opened on its own"
echo "PASS — prefetching is an optimisation, not a correctness dependency."
