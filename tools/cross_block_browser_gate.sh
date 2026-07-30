#!/usr/bin/env bash
# Copyright (c) 2026 Jurjen Stellingwerff
# SPDX-License-Identifier: LGPL-3.0-or-later
#
# PLAN-SCALE C2 — the BROWSER half of the cross-block proof.
#
# S8 proves the library property (a working set filled from two blocks routes like one) and map.test.mjs
# proves the app names the right covering set. Between them sat a hole: the browser only ever ran a set of
# ONE, because only one block exists. That hole would have been filled by the first real multi-block
# dataset — which is exactly when it is most expensive to find a fault.
#
# So the seam is manufactured: the shipped block is split beside itself in _site, the page's own coverage
# index is swapped for one naming both halves, and the SAME sketch is matched twice — against the whole
# block, and across the seam. The routes must agree, and the split run must genuinely name two blocks.
#
# The halves are temporary. They are built here and removed at exit, so nothing about the deployed site
# changes and the fixture cannot drift from the block it was split from.
#
#   tools/cross_block_browser_gate.sh
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
loft="${LOFT_BIN:-$(command -v loft || echo /usr/local/bin/loft)}"
chromium="${CHROMIUM_BIN:-chromium}"
dtport="${DTPORT:-9241}"
httpport="${HTTPPORT:-8141}"
site="$here/_site"
command -v node >/dev/null || { echo "SKIP: node not found"; exit 2; }
command -v "$chromium" >/dev/null || { echo "SKIP: chromium not found"; exit 2; }
[ -f "$site/stores/enschede.roads.store" ] || { echo "SKIP: no built site (run tools/map_render_gate.sh first)"; exit 2; }
# Self-sufficient on purpose: `build-site.mjs` REMOVES _site and rebuilds it, so the coverage index is
# gone whenever the site was rebuilt since the last index build. A gate that depends on another gate
# having just run is a gate that fails for the wrong reason.
"$here/tools/build_index.sh" >/dev/null || { echo "  FAIL: could not build the coverage index"; exit 1; }

srv=""; chr=""
cleanup() { kill "$chr" "$srv" 2>/dev/null; rm -f "$site/stores/west.roads.store"* "$site/stores/east.roads.store"*; }
trap cleanup EXIT

echo "== C2: the app across a block seam (browser) =="
"$loft" --native --lib "$here/lib" "$here/tools/split_block.loft" \
    "$site/stores/enschede.roads.store" "$site/stores/west.roads.store" "$site/stores/east.roads.store" 6.90 \
    2>&1 | grep -E '^split at' | sed 's/^/  /'
[ -f "$site/stores/west.roads.store" ] && [ -f "$site/stores/east.roads.store" ] \
  || { echo "  FAIL: the split produced no halves"; exit 1; }

rm -rf "$here/scratch/chromium-$dtport"; mkdir -p "$here/scratch"
# Range, because the split blocks are read paged — python's own http.server would answer every page
# request with a whole file and the gate would be grading something else entirely.
python3 "$here/tools/range_server.py" "$httpport" "$site" /dev/null >/dev/null 2>&1 &
srv=$!
"$chromium" --headless=new --disable-gpu --no-sandbox --window-size=1000,700 \
  --user-data-dir="$here/scratch/chromium-$dtport" --remote-debugging-port="$dtport" about:blank >/dev/null 2>&1 &
chr=$!
sleep 4

node "$here/browser/cdp_cross_block.mjs" "127.0.0.1:$dtport" "http://127.0.0.1:$httpport/index.html"
