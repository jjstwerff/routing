#!/usr/bin/env bash
# Copyright (c) 2026 Jurjen Stellingwerff
# SPDX-License-Identifier: LGPL-3.0-or-later
#
# THE PAGE INDEX, END TO END — the app plans its own viewport out of `coverage.pagesx` and the map that
# comes out is the same map.
#
# `browser/page-index.test.mjs` proves the FORMAT (python writes it, JS reads back the same pages) with no
# data and no browser. This is the other half: a real store, a real 206 Range host, the app's own view
# path, and no capture — the pages come from the index the build staged, or they do not come at all.
#
# ⚠ WHAT MAKES IT A GATE RATHER THAN A PROFILE. A prefetch that named the WRONG pages still draws the
# right map, because a page number is a fetch hint and every byte still comes from the store at the offset
# the kernel asked for. So the failure this exists to catch is silent by construction, and a timing cannot
# see it. What can: the buffer HIT RATE (did the kernel ask for what the index named?) and drawing the
# same viewport twice, once with the index and once without, and requiring identical counts.
#
# ⚠ LATENCY_MS IS SET, and that is not decoration: a local server has ~0 RTT, which is exactly the cost
# prefetching removes. 26 ms is what the live host answers in on a reused connection
# (docs/prefetch-index-design.md §0), so both arms pay a realistic round trip and only their COUNT differs.
#
#   tools/prefetch_gate.sh [camera] [hit-floor-pct]
# Requires: node, python3, chromium, browser/store-kernel.wasm, and a built page index (blocks/coverage.pagesx).
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
chromium="${CHROMIUM_BIN:-chromium}"
profile="$here/scratch/chromium-prefetch"
httpport="${HTTPPORT:-8163}"
cam="${1:-14/52.3702/4.8952}"
floor="${2:-80}"
command -v node >/dev/null || { echo "SKIP: node not found"; exit 2; }
command -v python3 >/dev/null || { echo "SKIP: python3 not found"; exit 2; }
command -v "$chromium" >/dev/null || { echo "SKIP: chromium not found"; exit 2; }
[ -f "$here/browser/store-kernel.wasm" ] || { echo "SKIP: browser/store-kernel.wasm missing (run: node browser/build-store-kernel.mjs)"; exit 2; }

# ⚠ REBUILD `_site` FIRST. A gate serves `_site`, which only `build-site.mjs` refreshes — so an index
# rebuilt in `blocks/` reaches nothing until this runs (HANDOFF §2). SITE_LOCAL_ONLY keeps the off-origin
# base maps out, so nothing here reaches the network.
SITE_LOCAL_ONLY=1 node "$here/browser/build-site.mjs" >/dev/null || exit 1
# The index is gitignored output (`blocks/`), so a fresh clone has none. That is a SKIP, never a pass:
# with no index every arm falls through to normal reads and both sides of the A/B would agree — a green
# tick over an experiment that did not happen (HANDOFF §2, "a gate pointed at a staging directory").
[ -f "$here/_site/coverage.pagesx" ] || {
  echo "SKIP: no _site/coverage.pagesx — build one with tools/finish_page_indexes.sh"; exit 2; }

mkdir -p "$here/scratch"; rm -rf "$profile"-A "$profile"-B
srv=""
cleanup() { [ -n "$srv" ] && kill "$srv" 2>/dev/null; return 0; }
trap cleanup EXIT
LATENCY_MS="${LATENCY_MS:-0}" python3 "$here/tools/range_server.py" "$httpport" "$here/_site" /dev/null >/dev/null 2>&1 &
srv=$!
for _ in $(seq 40); do curl -s -o /dev/null "http://127.0.0.1:$httpport/index.html" 2>/dev/null && break; sleep 0.3; done
rc="$(curl -s -o /dev/null -w '%{http_code}' -H 'Range: bytes=0-15' "http://127.0.0.1:$httpport/coverage.pagesx")"
[ "$rc" = "206" ] || { echo "FAIL: the harness server does not honour Range on the index (got $rc)"; exit 1; }

echo "== the page index, wired: $(stat -c%s "$here/_site/coverage.pagesx") bytes over $(ls "$here"/_site/stores/*.store 2>/dev/null | wc -l) stores, link emulated in the browser =="
CHROMIUM_BIN="$chromium" node "$here/browser/cdp_prefetch_wired.mjs" "$profile" "http://127.0.0.1:$httpport/index.html" "$cam" "$floor" "${PREFETCH_PAD:-}" "${LINK_MBPS:-82}" "${LINK_RTT:-45}"
