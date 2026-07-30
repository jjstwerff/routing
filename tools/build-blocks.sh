#!/usr/bin/env bash
# Copyright (c) 2026 Jurjen Stellingwerff
# SPDX-License-Identifier: LGPL-3.0-or-later
#
# Generate a routing block from OpenStreetMap (PLAN-SCALE §7 R1–R5).
#
# This is the pipeline the plan calls the recurring cost: acquire → filter → export → generate → verify.
# It is written to be run again and again, which is the only way a dataset stays current, so every step is
#
#   RESUMABLE   each step skips when its output is newer than its input, so a run interrupted anywhere
#               continues instead of restarting. A country takes long enough that this is not a luxury.
#   AUDIBLE     every step prints what it produced. A pipeline whose middle is silent is one you cannot
#               debug at 2 GB.
#   VERIFIED    the block is opened, measured and spot-checked before it is offered to the index. A block
#               that generated "successfully" but lost its western half is the failure this catches.
#
#   tools/build-blocks.sh <region-id> <geofabrik-path> [bbox]
#     region-id       e.g. netherlands            (names the outputs)
#     geofabrik-path  e.g. europe/netherlands     (without -latest.osm.pbf)
#     bbox            optional W,S,E,N to clip    (osmium extract; omit for the whole extract)
#
#   e.g. tools/build-blocks.sh netherlands europe/netherlands
#        tools/build-blocks.sh gelderland  europe/netherlands 5.0,51.7,6.9,52.5
#
# Needs: osmium-tool (apt install osmium-tool), curl, and the loft on PATH.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
loft="${LOFT_BIN:-$(command -v loft || echo /usr/local/bin/loft)}"
id="${1:-}"; src="${2:-}"; bbox="${3:-}"
[ -n "$id" ] && [ -n "$src" ] || { sed -n '/^#   tools\/build-blocks.sh/,/^#$/p' "$0" | sed 's/^# \?//'; exit 2; }
command -v osmium >/dev/null || { echo "FAIL: osmium-tool not installed (apt install osmium-tool)"; exit 1; }

# Everything lives outside the repo: a 1.4 GB extract and its intermediates are not source.
work="${BLOCKS_WORK:-$HOME/.cache/routing-blocks}"
# Generated blocks live in a gitignored `blocks/` — `_site` is WIPED and rebuilt by build-site.mjs,
# so a 322 MB block written there disappears at the next gate run.
out="${BLOCKS_OUT:-$here/blocks}"
mkdir -p "$work" "$out"
pbf="$work/$(basename "$src")-latest.osm.pbf"
clip="$work/$id.clip.osm.pbf"
roads="$work/$id.roads.osm.pbf"
seq="$work/$id.geojsonseq"
store="$out/$id.roads.store"
newer() { [ -s "$1" ] && [ "$1" -nt "$2" ]; }   # $1 exists and is newer than $2

# --- R1 · acquire, resumably ----------------------------------------------------------------------
url="https://download.geofabrik.de/$src-latest.osm.pbf"
echo "== R1 acquire =="
if [ -s "$pbf" ]; then
  echo "  have $(basename "$pbf") ($(du -h "$pbf" | cut -f1)) — checking it is still current"
  remote="$(curl -sIL "$url" | grep -i '^content-length' | tail -1 | tr -dc '0-9')"
  local_sz="$(stat -c%s "$pbf")"
  if [ -n "$remote" ] && [ "$remote" != "$local_sz" ]; then
    echo "  upstream changed ($local_sz → $remote) — re-fetching"
    curl -# -L -o "$pbf" -C - "$url" || { echo "FAIL: download"; exit 1; }
  fi
else
  echo "  downloading $url"
  curl -# -L -o "$pbf" -C - "$url" || { echo "FAIL: download"; exit 1; }
fi
# Geofabrik publishes an md5 beside every extract; a truncated download is otherwise a mystery three
# steps later, where it looks like a data problem rather than a transfer one.
if curl -sfL "$url.md5" -o "$work/$(basename "$pbf").md5"; then
  want="$(cut -d' ' -f1 "$work/$(basename "$pbf").md5")"
  have="$(md5sum "$pbf" | cut -d' ' -f1)"
  # Compare the HASH, not the filename: geofabrik's .md5 names the DATED file (netherlands-260729…), so
  # `md5sum -c` would look for a name that does not exist here and fail for the wrong reason.
  if [ "$want" != "$have" ]; then
    echo "FAIL: md5 mismatch ($(stat -c%s "$pbf") bytes)"
    echo "      want $want"
    echo "      have $have"
    echo "      delete $pbf and re-run"
    exit 1
  fi
  echo "  md5 ok ($(du -h "$pbf" | cut -f1))"
fi

# --- R2 · per-region osmium passes ----------------------------------------------------------------
echo "== R2 extract + filter =="
if [ -n "$bbox" ]; then
  if newer "$clip" "$pbf"; then echo "  clip up to date"; else
    echo "  osmium extract --bbox $bbox"
    osmium extract --bbox "$bbox" --overwrite -o "$clip" "$pbf" || { echo "FAIL: osmium extract"; exit 1; }
  fi
  base_pbf="$clip"
else
  base_pbf="$pbf"
fi
if newer "$roads" "$base_pbf"; then echo "  roads filter up to date"; else
  echo "  osmium tags-filter w/highway"
  osmium tags-filter --overwrite -o "$roads" "$base_pbf" w/highway || { echo "FAIL: osmium tags-filter"; exit 1; }
fi
echo "  roads pbf: $(du -h "$roads" | cut -f1)"

# --- R2b · export the form the generator streams ---------------------------------------------------
# geojsonseq, one Feature per line — which `gen-tiles` reads directly (PLAN-SCALE S6). The older recipe
# converted this to Overpass-shaped JSON first; streaming removed that step entirely.
echo "== R2b export geojsonseq =="
if newer "$seq" "$roads"; then echo "  geojsonseq up to date"; else
  osmium export "$roads" -f geojsonseq --geometry-types=linestring --overwrite -o "$seq" \
    || { echo "FAIL: osmium export"; exit 1; }
fi
echo "  geojsonseq: $(du -h "$seq" | cut -f1), $(wc -l < "$seq") features"

# --- R4 · generate ---------------------------------------------------------------------------------
echo "== R4 generate =="
if newer "$store" "$seq"; then echo "  block up to date"; else
  rm -f "$store" "$store.dschema"
  time "$loft" --native-release --lib "$here/lib" "$here/tools/gen-tiles.loft" "$store" "$seq" \
    || { echo "FAIL: gen-tiles"; exit 1; }
fi
echo "  block: $(du -h "$store" | cut -f1)"

# --- R5 · verify BEFORE it is offered to anything --------------------------------------------------
echo "== R5 verify =="
ext="$("$loft" --native --lib "$here/lib" "$here/tools/store_extent.loft" "$store" roads 2>/dev/null | grep -oP '^EXTENT \K.*')"
[ -n "$ext" ] || { echo "FAIL: the block does not open"; exit 1; }
set -- $ext
echo "  extent lat $(python3 -c "print(f'{$1/1e7:.4f}..{$3/1e7:.4f}')") lon $(python3 -c "print(f'{$2/1e7:.4f}..{$4/1e7:.4f}')") · tiles=$5 roads=$6"
[ "$5" -ge 100 ] || { echo "FAIL: only $5 tiles — the block is empty or the filter dropped everything"; exit 1; }
# A paged spot check: the read path the client uses, on the block it will actually read.
LOFT_LOADER_STATS=1 "$loft" --native --lib "$here/lib" "$here/tools/page_locality_probe.loft" "$store" 2>&1 \
  | grep -E '^store_load_keys|^asked' | sed 's/^/  /'

cat <<EOF

Block ready: $store
Next:
  1. add it to data/coverage.toml   (id = "$id", roads = "stores/$(basename "$store")")
     — build-site.mjs copies blocks/ into _site/stores/, so the URL stays "stores/…"
  2. tools/build_index.sh           (re-derives extents, sizes and hashes)
  3. tools/cross_block_browser_gate.sh + make test-map
EOF
