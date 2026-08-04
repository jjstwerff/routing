#!/usr/bin/env bash
# Copyright (c) 2026 Jurjen Stellingwerff
# SPDX-License-Identifier: LGPL-3.0-or-later
#
# PLAN-SCALE §6i — the app opens on the COUNTRY, the handover is exclusive, and the retry stays off.
#
# §6i shipped three behaviours with no assertion between them, and this repo already knows the price of
# that: F5 exists because a blank map passed every gate that never asked whether anything was DRAWN.
# What this pins:
#
#   * a BARE url — the camera a first visitor gets, not a pinned one — draws the country from the
#     overview block ALONE, in one request, reading no detailed roads;
#   * the handover is exclusive BOTH ways: below it no detailed block is touched, above it the overview
#     is not. Getting that wrong is not a slower map, it is a 2 GB read at z12 or a blank one at z16;
#   * the densified retry does NOT fire on a sketch that already matches (the property that keeps every
#     working route byte-identical), and DOES fire on one the matcher hands back.
#
# Runs entirely LOCAL: `SITE_LOCAL_ONLY=1` keeps only blocks whose stores are all on this origin, which
# is the overview (19.6 MB, committed to the release and linked from blocks/) and the small Enschede
# block — one below the handover and one above it, which is exactly the pair these checks need.
#
#   tools/overview_gate.sh
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
chromium="${CHROMIUM_BIN:-chromium}"
profile="$here/scratch/chromium-overview"
httpport="${HTTPPORT:-8167}"
site="$here/_site"
command -v node >/dev/null || { echo "SKIP: node not found"; exit 2; }
command -v "$chromium" >/dev/null || { echo "SKIP: chromium not found"; exit 2; }
# The overview is generated output (gitignored), so a fresh clone has not built it and there is nothing
# to check. SKIP rather than FAIL — the same rule nl_live_gate uses for the country blocks.
[ -f "$here/blocks/overview.base.store" ] || {
  echo "SKIP: no overview block (build: tools/build-derived.sh, or tools/fetch-site-blocks.sh)"; exit 2; }

srv=""
cleanup() { [ -n "$srv" ] && kill "$srv" 2>/dev/null; return 0; }
trap cleanup EXIT

SITE_LOCAL_ONLY=1 node "$here/browser/build-site.mjs" >/dev/null || { echo "  FAIL: build-site"; exit 1; }
grep -q "overview.base.store" "$site/coverage.json" || {
  echo "  FAIL: the local site index does not name the overview — build-site dropped it"; exit 1; }

# STAGE THE MIDDLE-ZOOM BLOCK LOCALLY. It is hosted on its own Pages data repo, so `SITE_LOCAL_ONLY`
# correctly drops it — a local gate must not reach the internet. But then the z12–13 band has no data and
# the middle level goes ungated, which is one of the bands this gate exists to check. So: link the block
# in and point the index at it with a relative URL — the same block, served from this origin.
if [ -f "$here/blocks/nl-mid.base.store" ]; then
  ln -sf "$here/blocks/nl-mid.base.store" "$site/stores/nl-mid.base.store"
  ln -sf "$here/blocks/nl-mid.base.store.dschema" "$site/stores/nl-mid.base.store.dschema" 2>/dev/null || true
  python3 "$here/tools/stage_mid_local.py" "$site/coverage.json" "$here/browser/coverage.json" || {
    echo "  FAIL: could not stage nl-mid into the local index"; exit 1; }
fi

rm -rf "$profile"; mkdir -p "$here/scratch"
# Range, because the detailed side of the handover is read paged; python's own http.server answers every
# range request with the whole file and the gate would be grading something else.
python3 "$here/tools/range_server.py" "$httpport" "$site" /dev/null >/dev/null 2>&1 &
srv=$!
# ⚠ THIS SCRIPT NO LONGER LAUNCHES A BROWSER, and that is the point. It used to start Chromium on a
# debugging PORT and take it down from `trap cleanup EXIT` — correct for every way this script ends, and
# useless for the way it actually dies (a timeout or an interrupted turn kills the shell, no trap runs,
# and a detached browser owned by nobody runs for days). The driver now owns it over a CDP pipe, so the
# browser cannot outlive `node` on any OS and there is nothing here to clean up. See browser/cdp_transport.mjs.
CHROMIUM_BIN="$chromium" node "$here/browser/cdp_overview.mjs" "$profile" "http://127.0.0.1:$httpport/index.html"
