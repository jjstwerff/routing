#!/usr/bin/env bash
# Copyright (c) 2026 Jurjen Stellingwerff
# SPDX-License-Identifier: LGPL-3.0-or-later
#
# CAN YOU WALK THE ROUTE WITH THE RADIO OFF? — the observable the offline pack exists for.
#
# Everything else about persistence can be wrong quietly: a page that fails to persist costs a fetch and
# nobody notices. This cannot, because its failure is a person on a hill looking at a blank screen. So the
# gate is the TRIP — save a pack, go offline, reload, follow the route — and the bar is not "it drew
# something" but "it drew what it draws online".
#
# ⚠ SHELL_CACHE_S IS SET, and it is faithful rather than convenient: GitHub Pages sends `max-age=600` on
# everything, so a real browser can reload the app shell without a network. Our harness defaults to
# `no-store`, under which the page itself cannot come back and the trip could never start.
#
#   tools/offline_pack_gate.sh [half-width-m] [zooms]
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
chromium="${CHROMIUM_BIN:-chromium}"
port="${HTTPPORT:-8531}"
command -v node >/dev/null || { echo "SKIP: node not found"; exit 2; }
command -v "$chromium" >/dev/null || { echo "SKIP: chromium not found"; exit 2; }
[ -f "$here/browser/store-kernel.wasm" ] || { echo "SKIP: no store-kernel.wasm"; exit 2; }

SITE_LOCAL_ONLY=1 node "$here/browser/build-site.mjs" >/dev/null || exit 1
# The pack can only cover ground the page index covers, so a checkout without a built index cannot run
# this — a SKIP, never a pass by absence.
[ -f "$here/_site/coverage.pagesx" ] || { echo "SKIP: no _site/coverage.pagesx (tools/finish_page_indexes.sh)"; exit 2; }

srv=""
cleanup() { [ -n "$srv" ] && kill "$srv" 2>/dev/null; return 0; }
trap cleanup EXIT
SHELL_CACHE_S=600 python3 "$here/tools/range_server.py" "$port" "$here/_site" /dev/null >/dev/null 2>&1 &
srv=$!
for _ in $(seq 40); do curl -s -o /dev/null "http://127.0.0.1:$port/index.html" 2>/dev/null && break; sleep 0.3; done

echo "== the offline route pack: save it, cut the network, walk it =="
CHROMIUM_BIN="$chromium" node "$here/browser/cdp_offline_pack.mjs" \
  "$here/scratch/chromium-offline" "http://127.0.0.1:$port/index.html#14/49.6116/6.1319" "${1:-800}" "${2:-14}"
