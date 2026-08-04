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
profile="$here/scratch/chromium-cross_block_browser"
httpport="${HTTPPORT:-8141}"
site="$here/_site"
command -v node >/dev/null || { echo "SKIP: node not found"; exit 2; }
command -v "$chromium" >/dev/null || { echo "SKIP: chromium not found"; exit 2; }
[ -f "$site/stores/enschede.roads.store" ] || { echo "SKIP: no built site (run tools/map_render_gate.sh first)"; exit 2; }
# Self-sufficient on purpose: `build-site.mjs` REMOVES _site and rebuilds it, so the coverage index is
# gone whenever the site was rebuilt since the last index build. A gate that depends on another gate
# having just run is a gate that fails for the wrong reason.
# ⚠ INTO _site, NOT THE TREE. `build_index.sh` defaults to the COMMITTED browser/coverage.json, so a gate
# calling it bare REWRITES the file it is meant to be checking — the defect 8c47628 fixed once already.
# And the manifest is the FIXTURE one: Enschede is no longer coverage (data/coverage.toml says why), and
# this gate exists to split that block in two.
COVERAGE_MANIFEST="$here/data/coverage-fixture.toml" "$here/tools/build_index.sh" "$site/coverage.json" \
  >/dev/null || { echo "  FAIL: could not build the coverage index"; exit 1; }

srv=""
cleanup() { kill "$srv" 2>/dev/null; rm -f "$site/stores/west.roads.store"* "$site/stores/east.roads.store"*; }
trap cleanup EXIT

echo "== C2: the app across a block seam (browser) =="
"$loft" --native --lib "$here/lib" "$here/tools/split_block.loft" \
    "$site/stores/enschede.roads.store" "$site/stores/west.roads.store" "$site/stores/east.roads.store" 6.90 \
    2>&1 | grep -E '^split at' | sed 's/^/  /'
[ -f "$site/stores/west.roads.store" ] && [ -f "$site/stores/east.roads.store" ] \
  || { echo "  FAIL: the split produced no halves"; exit 1; }

rm -rf "$profile"; mkdir -p "$here/scratch"
# Range, because the split blocks are read paged — python's own http.server would answer every page
# request with a whole file and the gate would be grading something else entirely.
python3 "$here/tools/range_server.py" "$httpport" "$site" /dev/null >/dev/null 2>&1 &
srv=$!
# ⚠ THIS SCRIPT NO LONGER LAUNCHES A BROWSER, and that is the point. It used to start Chromium on a
# debugging PORT and take it down from `trap cleanup EXIT` — correct for every way this script ends, and
# useless for the way it actually dies (a timeout or an interrupted turn kills the shell, no trap runs,
# and a detached browser owned by nobody runs for days). The driver now owns it over a CDP pipe, so the
# browser cannot outlive `node` on any OS and there is nothing here to clean up. See browser/cdp_transport.mjs.
CHROMIUM_BIN="$chromium" node "$here/browser/cdp_cross_block.mjs" "$profile" "http://127.0.0.1:$httpport/index.html"
