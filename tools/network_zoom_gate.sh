#!/usr/bin/env bash
# Copyright (c) 2026 Jurjen Stellingwerff
# SPDX-License-Identifier: LGPL-3.0-or-later
#
# PLAN-LAYERS §4 — a signposted route keeps its band at every zoom the block it lives in serves.
#
# The bug this exists for was reported from the live site and is invisible to every gate here: at z15 the
# walking network is a connected web, at z14.6 a scatter of disconnected stubs, because a ROUTE's
# visibility was decided by the ROAD CLASS it happens to run on (`path`/`foot` debut z15, `track`/`cycle`
# z14). Nothing was broken enough to fail — the map simply drew half a network.
#
# ⚠ The assertion reads the DRAW PATH (`map._netStats`, written by `_drawStreetsFlat`), never the style
# table. See browser/cdp_zoom_drop.mjs for why that distinction has already cost this repo a day.
#
#   tools/network_zoom_gate.sh
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dtport="${DTPORT:-9255}"
httpport="${HTTPPORT:-8163}"
chromium="${CHROMIUM_BIN:-chromium-browser}"
command -v "$chromium" >/dev/null || chromium="$(command -v chromium || command -v google-chrome || echo chromium)"
command -v "$chromium" >/dev/null || { echo "SKIP: chromium not found"; exit 2; }
command -v node >/dev/null || { echo "SKIP: node not found"; exit 2; }

# The site is rebuilt here rather than assumed: a gate that reads whatever _site happened to hold last is
# a gate on a previous tree. SITE_LOCAL_ONLY keeps it offline — the fixture block is all this needs.
SITE_LOCAL_ONLY=1 node "$here/browser/build-site.mjs" >/dev/null || exit 1
"$here/tools/build_index.sh" >/dev/null || { echo "  FAIL: could not build the coverage index"; exit 1; }
[ -f "$here/_site/stores/enschede.roads.store" ] || { echo "SKIP: no roads fixture in _site"; exit 2; }

rm -rf "$here/scratch/chromium-$dtport"; mkdir -p "$here/scratch"
srv=""; chr=""; rc=0
cleanup() { kill "$chr" "$srv" 2>/dev/null; }
trap cleanup EXIT
# Range, not python's http.server: the app pages its roads block, and a server that answers every page
# request with the whole file would still render — while measuring something the deployed site never does.
python3 "$here/tools/range_server.py" "$httpport" "$here/_site" /dev/null >/dev/null 2>&1 &
srv=$!
"$chromium" --headless=new --disable-gpu --no-sandbox --window-size=1000,700 \
  --user-data-dir="$here/scratch/chromium-$dtport" --remote-debugging-port="$dtport" about:blank >/dev/null 2>&1 &
chr=$!
sleep 4

echo "== PLAN-LAYERS §4: the signposted network survives a zoom step =="
node "$here/browser/cdp_zoom_drop.mjs" "127.0.0.1:$dtport" "http://127.0.0.1:$httpport/index.html" || rc=1
exit $rc
