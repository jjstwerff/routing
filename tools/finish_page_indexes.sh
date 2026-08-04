#!/usr/bin/env bash
# Copyright (c) 2026 Jurjen Stellingwerff
# SPDX-License-Identifier: LGPL-3.0-or-later
#
# Take every raw page index to the form the browser can actually read, and stage it beside its store.
#
# `build_page_index.sh` emits `cell -> pages` keyed by loft's `tkey`. Two things stand between that and a
# browser that can use it, and this does both, idempotently:
#
#   1. SPATIAL KEYS (`add_cell_coords.sh`) — JS works in bounding boxes and never computes a tkey, so
#      without each cell's ox/oy the index is unusable from the only place that needs it.
#   2. ONE INDEX OVER EVERY STORE (`build_coverage_index.py`) — a viewport is answered by three scales
#      plus roads, so a per-store index made the browser open four of them to plan one screen. v3 is a
#      single quadtree over every coordinated store, read by range: a session pays ~1.4 kB of header and
#      root directory, then a sub-directory and a few chunks per screen.
#
# ⚠ SAFE TO RE-RUN WHILE GENERATION IS STILL GOING. It skips any index whose store is currently being
# generated (the .pages.json is written only at the end, so a missing one is simply not ready) and any
# that already has coordinates. Run it again when the rest land — the coverage index is rebuilt from
# whatever is coordinated at that moment, and a store that is not in it simply reads the old way.
#
#   tools/finish_page_indexes.sh [--stage]      # --stage also copies coverage.pagesx into _site/
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
stage=0; [ "${1:-}" = "--stage" ] && stage=1

shopt -s nullglob
idxs=("$here"/blocks/*.pages.json)
[ ${#idxs[@]} -gt 0 ] || { echo "no indexes yet — run tools/build_all_page_indexes.sh"; exit 2; }
echo "== finishing ${#idxs[@]} index(es) =="
done_n=0; skip=0
for idx in "${idxs[@]}"; do
  name="$(basename "$idx" .pages.json)"
  kind="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('record','PTile'))" "$idx" 2>/dev/null || echo PTile)"
  hasxy="$(python3 -c "import json,sys;d=json.load(open(sys.argv[1]));print(1 if d.get('xy') else 0)" "$idx" 2>/dev/null || echo 0)"
  printf '\n-- %s (%s)\n' "$name" "$kind"
  if [ "$hasxy" = "0" ]; then
    "$here/tools/add_cell_coords.sh" "$here/blocks/$name" "$kind" 2>&1 | sed 's/^/  /' || { echo "  FAIL: coords"; continue; }
  else
    echo "   coordinates already present"
  fi
  done_n=$((done_n+1))
done

# The index the browser actually reads, over every store that HAS coordinates by now. Rebuilt from
# scratch each time rather than appended to: it is a few seconds over the .pages.json files, and an index
# assembled incrementally is the one thing that could disagree with the data it names.
echo
echo "== one index over every coordinated store =="
( cd "$here" && python3 tools/build_coverage_index.py ) || { echo "  FAIL: coverage index"; exit 1; }
if [ "$stage" = 1 ]; then
  if [ -d "$here/_site" ]; then
    cp "$here/blocks/coverage.pagesx" "$here/_site/coverage.pagesx"
    echo "   staged -> _site/coverage.pagesx"
  else
    echo "   ⚠ no _site — run node browser/build-site.mjs first (it stages the index itself)"
  fi
fi
echo
echo "== $done_n coordinated =="
