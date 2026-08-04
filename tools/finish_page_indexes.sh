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
#   2. CHUNKING (`chunk_page_index.py`) — `nl-east.base`'s index is 7.9 MB whole; fetching that to
#      prefetch a 43 MB viewport is an 18% overhead that eats the win. Chunked, a viewport reads the
#      header plus one to four chunks.
#
# ⚠ SAFE TO RE-RUN WHILE GENERATION IS STILL GOING. It skips any index whose store is currently being
# generated (the .pages.json is written only at the end, so a missing one is simply not ready) and any
# that already has coordinates. Run it again when the rest land.
#
#   tools/finish_page_indexes.sh [--stage]      # --stage also copies .pagesx into _site/stores/
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
  python3 "$here/tools/chunk_page_index.py" "$idx" 2>&1 | sed 's/^/  /' || { echo "  FAIL: chunk"; continue; }
  if [ "$stage" = 1 ] && [ -f "$here/blocks/$name.pagesx" ]; then
    if [ -d "$here/_site/stores" ]; then
      cp "$here/blocks/$name.pagesx" "$here/_site/stores/$name.pagesx"
      echo "   staged -> _site/stores/$name.pagesx"
    else
      echo "   ⚠ no _site/stores — run node browser/build-site.mjs first"
    fi
  fi
  done_n=$((done_n+1))
done
echo
echo "== $done_n finished =="
du -ch "$here"/blocks/*.pagesx 2>/dev/null | tail -1 | sed 's/^/   chunked total: /'
