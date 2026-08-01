#!/usr/bin/env bash
# Copyright (c) 2026 Jurjen Stellingwerff
# SPDX-License-Identifier: LGPL-3.0-or-later
#
# PLAN-SCALE §6f F1+F2 — the base map, read a VIEWPORT AT A TIME instead of whole.
#
# This is the gate for the thing that made the map blank outside Enschede: a country's base map is
# ~690 MB, the kernel loaded it WHOLE, so it could not ship on GitHub Pages at all and the app drew a
# route on nothing. Paging it by cell key is the fix, and the failure mode of a paged read is not an
# error — it is a map with less on it, which is precisely what nobody noticed the first time.
#
# So the gate runs the SAME camera path twice against the SAME block, once whole and once paged, and
# compares what got DRAWN, viewport by viewport, per kind. It runs against the shipped Enschede block
# (`window.__baseReadMode` forces paging on a block whose index says "whole"), so it needs no country
# dataset and can run on every checkout.
#
# ⚠ It must be served by tools/range_server.py, NOT `python3 -m http.server` — the latter ignores
# `Range` and answers 200 with the whole file, which would turn "paged" into "whole" and pass.
#
#   tools/base_paged_gate.sh
# Requires: node, python3, chromium, and browser/store-kernel.wasm (node browser/build-store-kernel.mjs).
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
chromium="${CHROMIUM_BIN:-chromium}"
dtport="${DTPORT:-9251}"
httpport="${HTTPPORT:-8159}"
command -v node >/dev/null || { echo "SKIP: node not found"; exit 2; }
command -v python3 >/dev/null || { echo "SKIP: python3 not found"; exit 2; }
command -v "$chromium" >/dev/null || { echo "SKIP: chromium not found"; exit 2; }

node "$here/browser/build-site.mjs" || exit 1
[ -f "$here/browser/store-kernel.wasm" ] || { echo "SKIP: browser/store-kernel.wasm missing (run: node browser/build-store-kernel.mjs)"; exit 2; }
layout="$here/_site/stores/enschede.layout.store"
[ -f "$layout" ] || { echo "SKIP: no layout store at $layout"; exit 2; }

rm -rf "$here/scratch/chromium-$dtport"; mkdir -p "$here/scratch"
srv=""; chr=""
cleanup() { kill "$chr" "$srv" 2>/dev/null; }
trap cleanup EXIT
python3 "$here/tools/range_server.py" "$httpport" "$here/_site" "$here/scratch/.base-paged-report" >/dev/null 2>&1 &
srv=$!
for _ in $(seq 20); do curl -s -o /dev/null "http://127.0.0.1:$httpport/index.html" 2>/dev/null && break; sleep 0.3; done
rc="$(curl -s -o /dev/null -w '%{http_code}' -H 'Range: bytes=0-15' "http://127.0.0.1:$httpport/stores/enschede.layout.store")"
[ "$rc" = "206" ] || { echo "FAIL: the harness server does not honour Range (got $rc) — a 'paged' run would silently be a whole one"; exit 1; }

"$chromium" --headless=new --disable-gpu --no-sandbox --window-size=1000,700 \
  --user-data-dir="$here/scratch/chromium-$dtport" --remote-debugging-port="$dtport" about:blank >/dev/null 2>&1 &
chr=$!
sleep 4

echo "== PLAN-SCALE §6f F1/F2: the base map read by RANGE, one viewport at a time =="
echo "  block: $(stat -c%s "$layout") bytes of layout store, served with real 206 Range"
node "$here/browser/cdp_base_paged.mjs" "127.0.0.1:$dtport" "http://127.0.0.1:$httpport/index.html"
rc=$?
[ $rc -ne 0 ] && { echo "       (F2's stated fallback if the cost GROWS is JS reading pages directly — never a decoder of our own.)"; exit $rc; }

# --- Phase 2: the store this rung actually exists for ------------------------------------------------
#
# Phase 1 pages a 20 MB city block, which proves the MECHANISM but not the CLAIM: what made the map blank
# is that a country's base map is ~690 MB and could not be loaded whole at all. So if the local country
# block is here, point the app at it and require it to DRAW — a browser, a real 1 GB store, real Range.
#
# It SKIPS without the block, because `blocks/` is gitignored and does not travel (HANDOFF §7). That is
# the honest shape: this is the strongest evidence available on a machine that has the data, and no
# evidence at all on one that does not — never a pass by absence.
country="$here/blocks/nl-west.base.store"
croads="$here/blocks/nl-west.roads.store"
if [ ! -f "$country" ] || [ ! -f "$croads" ]; then
  echo "  phase 2 SKIP — no local country block at $country (gitignored; build with tools/build-base-chunked.sh)"
  exit 0
fi
echo
echo "== phase 2: the same thing against a COUNTRY-scale base map =="
root="$here/scratch/nlbase-$httpport"
rm -rf "$root"; mkdir -p "$root"
ln -s "$here/_site/index.html" "$root/index.html"
ln -s "$here/_site/store-kernel.wasm" "$root/store-kernel.wasm"
ln -s "$country" "$root/nl-west.base.store"
ln -s "$croads" "$root/nl-west.roads.store"
[ -f "$croads.dschema" ] && ln -s "$croads.dschema" "$root/nl-west.roads.store.dschema"
[ -f "$country.dschema" ] && ln -s "$country.dschema" "$root/nl-west.base.store.dschema"
# An index of our own rather than the committed one: this names a base map the SITE index deliberately
# does not (it cannot be hosted there — that is the whole problem), and a gate must not write to the tree
# it is checking, so it is built in scratch. `readMode` sits on the base entry, which is where a per-STORE
# hosting decision belongs (HANDOFF §0 rule 2).
python3 - "$here/browser/coverage.json" "$root/coverage.json" "$country" "$croads" <<'PY'
import json, os, sys
src, dst, base, roads = sys.argv[1:5]
idx = json.load(open(src))
nl = next(b for b in idx['blocks'] if b['id'] == 'nl-west')
nl['roads'] = dict(nl['roads'], url='nl-west.roads.store', bytes=os.path.getsize(roads))
nl['base'] = {'url': 'nl-west.base.store', 'readMode': 'paged', 'bytes': os.path.getsize(base),
              'sha256': '', 'tiles': 0, 'features': 0, 'bbox': nl['roads']['bbox']}
nl['names'] = None
json.dump({'version': 'local-country', 'unit': idx['unit'], 'blocks': [nl]}, open(dst, 'w'))
PY
kill "$srv" 2>/dev/null
python3 "$here/tools/range_server.py" "$httpport" "$root" "$root/.report" >/dev/null 2>&1 &
srv=$!
for _ in $(seq 20); do curl -s -o /dev/null "http://127.0.0.1:$httpport/index.html" 2>/dev/null && break; sleep 0.3; done
echo "  block: $(stat -c%s "$country") bytes of base store + $(stat -c%s "$croads") bytes of roads, both paged"
# Two pans around Amsterdam, then two JUMPS — Den Haag, Rotterdam — 60 and 100 km away, because a pan
# and a jump fail differently: a pan re-uses most of the working set, a jump shares none of it and is
# what a search result or a shared link does.
#
# ⚠ Read phase 2's F2 ratio with that in mind. The last third of this walk is the two jumps, so its
# per-viewport cost is dominated by how many bytes each viewport FETCHES, not by the size of the working
# set being re-exposed. Phase 1 is the clean measurement of the re-expose question: uniform pans, uniform
# fetch, one variable.
node "$here/browser/cdp_base_paged.mjs" "127.0.0.1:$dtport" "http://127.0.0.1:$httpport/index.html" \
  '{"mode":"paged","start":{"lat":52.3676,"lon":4.9041,"zoom":16},
    "waypoints":[{"lat":52.3676,"lon":4.9341},{"lat":52.3876,"lon":4.9041},
                 {"lat":52.0907,"lon":4.3007},{"lat":51.9244,"lon":4.4777}]}'
rc=$?
rm -rf "$root"
exit $rc
