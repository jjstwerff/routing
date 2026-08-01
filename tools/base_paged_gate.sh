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
loft="${LOFT_BIN:-$(command -v loft || echo /usr/local/bin/loft)}"
command -v node >/dev/null || { echo "SKIP: node not found"; exit 2; }
command -v python3 >/dev/null || { echo "SKIP: python3 not found"; exit 2; }
command -v "$chromium" >/dev/null || { echo "SKIP: chromium not found"; exit 2; }

# ⚠ SITE_LOCAL_ONLY, and phase 1 depends on it for its DATASET rather than only for staying offline: the
# Enschede block is a FIXTURE now (data/coverage.toml), and only a local build merges it back in. Without
# it a z16 camera over Enschede resolves to `nl-east`, whose base map is off-origin and 774 MB, and the
# app never becomes ready — which is exactly how this read when the block left coverage.
# Phase 2 is unaffected: it stages its own index and serves it from its own root.
SITE_LOCAL_ONLY=1 node "$here/browser/build-site.mjs" || exit 1
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
# blocks are here, point the app at them and require it to DRAW — a browser, real stores, real Range.
#
# It SKIPS without them, because `blocks/` is gitignored and does not travel (HANDOFF §7). That is the
# honest shape: this is the strongest evidence available on a machine that has the data, and no evidence
# at all on one that does not — never a pass by absence.
#
# The FOUR regions PLAN-SCALE §6f F3 cuts the country into, if they have been built here. The staged
# index below also carries the small committed ENSCHEDE block, because the live index does — and the
# combination is what broke the deployed map on 2026-08-02: a camera inside the city block with a
# viewport WIDER than it, so selection picks the country block while a session-wide read mode still says
# `whole`, and the app asks for a 774 MB store in one download. The interesting
# case only exists once there is a cut: a viewport ON a seam. Each base region carries a 0.10° margin of
# its neighbours so ONE region answers it whole — that margin is what this phase checks, by looking at a
# viewport centred on a cut and requiring a full map rather than a half one.
REGIONS="west midwest mideast east"
r4=1
for f in $REGIONS; do
  [ -f "$here/blocks/nl-$f.base.store" ] && [ -f "$here/blocks/nl-$f.roads.store" ] || r4=0
done
if [ "$r4" = "0" ]; then
  echo "  phase 2 SKIP — no local country blocks in $here/blocks (gitignored; build with tools/build-base-chunked.sh)"
  exit 0
fi
echo
echo "== phase 2: the same thing against a COUNTRY-scale base map =="
root="$here/scratch/nlbase-$httpport"
rm -rf "$root"; mkdir -p "$root"
ln -s "$here/_site/index.html" "$root/index.html"
ln -s "$here/_site/store-kernel.wasm" "$root/store-kernel.wasm"
ln -s "$here/_site/stores/enschede.layout.store" "$root/enschede.layout.store"
ln -s "$here/_site/stores/enschede.roads.store" "$root/enschede.roads.store"
for f in $REGIONS; do
  ln -s "$here/blocks/nl-$f.base.store" "$root/nl-$f.base.store"
  ln -s "$here/blocks/nl-$f.roads.store" "$root/nl-$f.roads.store"
  [ -f "$here/blocks/nl-$f.base.store.dschema" ] && ln -s "$here/blocks/nl-$f.base.store.dschema" "$root/nl-$f.base.store.dschema"
  [ -f "$here/blocks/nl-$f.roads.store.dschema" ] && ln -s "$here/blocks/nl-$f.roads.store.dschema" "$root/nl-$f.roads.store.dschema"
done
# An index of our own rather than the committed one: this names a base map the SITE index deliberately
# does not (it cannot be hosted there — that is the whole problem), and a gate must not write to the tree
# it is checking, so it is built in scratch. `readMode` sits on the base entry, which is where a per-STORE
# hosting decision belongs (HANDOFF §0 rule 2).
# The extents come from the STORES, not from a guess: the app picks blocks by bbox intersection, so a
# hand-written extent would decide the very thing under test (which regions a seam viewport names).
for f in $REGIONS; do
  "$loft" --native --lib "$here/lib" "$here/tools/store_extent.loft" "$root/nl-$f.roads.store" roads >"$root/.x-$f" 2>/dev/null
  "$loft" --native --lib "$here/lib" "$here/tools/store_extent.loft" "$root/nl-$f.base.store"  base  >"$root/.b-$f" 2>/dev/null
done
"$loft" --native --lib "$here/lib" "$here/tools/store_extent.loft" "$root/enschede.roads.store" roads >"$root/.x-ens" 2>/dev/null
"$loft" --native --lib "$here/lib" "$here/tools/store_extent.loft" "$root/enschede.layout.store" base >"$root/.b-ens" 2>/dev/null
python3 - "$root" <<'PY'
import json, os, re, sys
root = sys.argv[1]
def extent(p):
    m = re.search(r'^EXTENT (\S+) (\S+) (\S+) (\S+) (\d+) (\d+)', open(p).read(), re.M)
    return {'mnla': int(m.group(1)), 'mnlo': int(m.group(2)), 'mxla': int(m.group(3)), 'mxlo': int(m.group(4))}
# The city block FIRST and read WHOLE, exactly as the live index has it — it is the block a camera over
# Enschede resolves to, and the one whose read mode used to be applied to everything.
eb, ebb = extent(f'{root}/.x-ens'), extent(f'{root}/.b-ens')
blocks = [{'id': 'enschede', 'name': 'Enschede (local)', 'readMode': 'whole',
           'roads': {'url': 'enschede.roads.store', 'bytes': os.path.getsize(f'{root}/enschede.roads.store'),
                     'sha256': '', 'tiles': 0, 'features': 0, 'bbox': eb},
           'base': {'url': 'enschede.layout.store', 'readMode': 'whole',
                    'bytes': os.path.getsize(f'{root}/enschede.layout.store'),
                    'sha256': '', 'tiles': 0, 'features': 0, 'bbox': ebb},
           'names': None}]
for f in ('west', 'midwest', 'mideast', 'east'):
    rb, bb = extent(f'{root}/.x-{f}'), extent(f'{root}/.b-{f}')
    blocks.append({'id': f'nl-{f}', 'name': f'NL {f} (local)', 'readMode': 'paged',
                   'roads': {'url': f'nl-{f}.roads.store', 'bytes': os.path.getsize(f'{root}/nl-{f}.roads.store'),
                             'sha256': '', 'tiles': 0, 'features': 0, 'bbox': rb},
                   'base': {'url': f'nl-{f}.base.store', 'readMode': 'paged',
                            'bytes': os.path.getsize(f'{root}/nl-{f}.base.store'),
                            'sha256': '', 'tiles': 0, 'features': 0, 'bbox': bb},
                   'names': None})
json.dump({'version': 'local-country', 'unit': 'fixed-1e-7', 'blocks': blocks}, open(f'{root}/coverage.json', 'w'))
PY
kill "$srv" 2>/dev/null
python3 "$here/tools/range_server.py" "$httpport" "$root" "$root/.report" >/dev/null 2>&1 &
srv=$!
for _ in $(seq 20); do curl -s -o /dev/null "http://127.0.0.1:$httpport/index.html" 2>/dev/null && break; sleep 0.3; done
echo "  blocks: $(du -ch "$here"/blocks/nl-*.base.store | tail -1 | cut -f1) of base across four regions, paged"
# Two viewports ON a region seam (4.90°E and 5.80°E) and three away from one, because those fail
# differently. A seam viewport is the case three regions CREATE: it has to name both sides, and before
# F3 the app could only name one base store — measured, one region answers such a viewport with 13 946
# of its 25 862 features. The jumps to Den Haag and Rotterdam are the other axis: a pan re-uses the
# working set, a jump shares none of it and is what a search result or a shared link does.
#
# ⚠ EVERY WAYPOINT MUST BE A REAL MOVE. `ensureViewNow` loads only when the viewport leaves the box it
# last loaded, padded by 60% — about 0.0124° of longitude at z16 — so a nearer "pan" produces no view at
# all and the gate silently measures the same viewport twice. The first seam waypoint here was 0.004°
# from the start and did exactly that.
#
# ⚠ Read phase 2's F2 ratio with that in mind. The last third of this walk is the two jumps, so its
# per-viewport cost is dominated by how many bytes each viewport FETCHES, not by the size of the working
# set being re-exposed. Phase 1 is the clean measurement of the re-expose question: uniform pans, uniform
# fetch, one variable.
node "$here/browser/cdp_base_paged.mjs" "127.0.0.1:$dtport" "http://127.0.0.1:$httpport/index.html" \
  '{"mode":"paged","start":{"lat":52.22355,"lon":6.90427,"zoom":13.68},
    "waypoints":[{"lat":52.1000,"lon":5.4000},{"lat":52.0907,"lon":4.3007},
                 {"lat":51.9244,"lon":4.4777},{"lat":52.2200,"lon":5.9000},
                 {"lat":52.2215,"lon":6.8937}]}'
rc=$?
rm -rf "$root"
exit $rc
