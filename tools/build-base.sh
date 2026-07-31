#!/usr/bin/env bash
# Copyright (c) 2026 Jurjen Stellingwerff
# SPDX-License-Identifier: LGPL-3.0-or-later
#
# Generate a BASE MAP block (the presentation store) from OpenStreetMap — the companion to
# `tools/build-blocks.sh`, which makes the routing block (PLAN-SCALE §7 R1–R5, D1).
#
# The base map is six layers, each a separate osmium pass, because they select on different tags and the
# generator bins them differently:
#
#   areas      w/landuse w/natural w/leisure     landcover polygons
#   buildings  w/building                        footprints
#   places     n/place                           point labels, ranked
#   streets    (reuses the ROADS export)         named centrelines, DP-simplified
#   lines      w/waterway w/railway w/barrier    stroked lines
#   pois       n/natural n/amenity n/tourism …   point icons
#
# All six stream (`.geojsonseq`, PLAN-SCALE S6 base half), so memory is one chunk per layer whatever the
# country. What is NOT bounded is the OUTPUT: the store is built in memory before it is persisted, and a
# base map is ~6x the routing block for the same ground (§1). Check the estimate before a continent.
#
#   tools/build-base.sh <region-id> <geofabrik-path> [bbox]
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
loft="${LOFT_BIN:-$(command -v loft || echo /usr/local/bin/loft)}"
id="${1:-}"; src="${2:-}"; bbox="${3:-}"
[ -n "$id" ] && [ -n "$src" ] || { echo "usage: tools/build-base.sh <region-id> <geofabrik-path> [bbox]"; exit 2; }
command -v osmium >/dev/null || { echo "FAIL: osmium-tool not installed"; exit 1; }

work="${BLOCKS_WORK:-$HOME/.cache/routing-blocks}"
out="${BLOCKS_OUT:-$here/blocks}"
mkdir -p "$work" "$out"
pbf="$work/$(basename "$src")-latest.osm.pbf"
[ -s "$pbf" ] || { echo "FAIL: no source extract at $pbf — run tools/build-blocks.sh first (it acquires it)"; exit 1; }
base_pbf="$pbf"
newer() { [ -s "$1" ] && [ "$1" -nt "$2" ]; }

# ⚠ EVERY CACHE HERE IS KEYED ON ITS RECIPE, NOT JUST ON MTIMES — the defect tools/build-blocks.sh was
# fixed for on 2026-07-30, which lived on in this file until 2026-07-31. These steps skip when the output
# is newer than the input, so changing a layer's tags-filter (or the bbox) silently reused an export built
# by the PREVIOUS recipe: over there it produced a "successfully regenerated" country block with zero
# barriers in it. Here it would mean a base map quietly missing a whole class of feature — the same shape
# as the dirt road that was in the data and invisible on the map (PR #30).
#
# `stale_by_recipe <cache-file> <recipe>` is the one chokepoint: it discards the cache when the recipe
# moved, and the caller stamps the recipe only AFTER the rebuild succeeds — a run that dies mid-osmium
# must not leave a stamp claiming an export that was never written.
stale_by_recipe() {  # $1 = cache file, $2 = recipe → discards $1 when its recorded recipe differs
  local fp="$1.recipe"
  [ -f "$fp" ] && [ "$(cat "$fp" 2>/dev/null)" = "$2" ] && return 1
  [ -s "$1" ] && echo "  recipe changed — discarding $(basename "$1")"
  rm -f "$1" "$fp"
  return 0
}

if [ -n "$bbox" ]; then
  clip="$work/$id.clip.osm.pbf"
  stale_by_recipe "$clip" "$bbox"      # a different bbox is a different clip, whatever the mtimes say
  if ! newer "$clip" "$pbf"; then
    osmium extract --bbox "$bbox" --overwrite -o "$clip" "$pbf" || exit 1
    printf '%s' "$bbox" > "$clip.recipe"
  fi
  base_pbf="$clip"
fi

# One osmium pass per layer: filter, then export the form the generator streams.
layer() {  # $1 = layer name, $2… = tags-filter expressions
  local name="$1"; shift
  local fpbf="$work/$id.$name.osm.pbf" seq="$work/$id.$name.geojsonseq"
  local recipe="$*"
  stale_by_recipe "$seq" "$recipe" && rm -f "$fpbf"
  if newer "$seq" "$base_pbf"; then echo "  $name: up to date ($(du -h "$seq" | cut -f1))"; return 0; fi
  osmium tags-filter --overwrite -o "$fpbf" "$base_pbf" "$@" || return 1
  osmium export "$fpbf" -f geojsonseq --overwrite -o "$seq" || return 1
  printf '%s' "$recipe" > "$seq.recipe"
  echo "  $name: $(du -h "$seq" | cut -f1), $(wc -l < "$seq") features"
}

echo "== base layers for $id =="
layer areas     w/landuse w/natural w/leisure || exit 1
layer buildings w/building                    || exit 1
layer places    n/place                       || exit 1
layer lines     w/waterway w/railway w/barrier || exit 1
layer pois      n/natural n/amenity n/tourism n/man_made n/historic n/leisure n/highway || exit 1
# Streets reuse the ROADS export: the generator selects `highway` + a name/ref itself, so a second pass
# over the same ways would only duplicate work and disk.
streets="$work/$id.geojsonseq"
[ -s "$streets" ] || { echo "FAIL: no roads export at $streets — run tools/build-blocks.sh $id $src first"; exit 1; }
echo "  streets: reusing the roads export ($(du -h "$streets" | cut -f1))"

store="$out/$id.base.store"
echo "== generate =="
time "$loft" --native-release --lib "$here/lib" "$here/client/basemap/build_store.loft" \
  "$work/$id.areas.geojsonseq" "$work/$id.buildings.geojsonseq" "$work/$id.places.geojsonseq" \
  "$streets" "$work/$id.lines.geojsonseq" "$work/$id.pois.geojsonseq" "$store" \
  || { echo "FAIL: build_store"; exit 1; }
echo "  block: $(du -h "$store" | cut -f1)"

echo "== verify =="
"$loft" --native --lib "$here/lib" "$here/tools/store_extent.loft" "$store" base 2>/dev/null \
  | grep -oP '^EXTENT \K.*' | awk '{printf "  extent lat %.4f..%.4f lon %.4f..%.4f · tiles=%s features=%s\n", $1/1e7, $3/1e7, $2/1e7, $4/1e7, $5, $6}'
