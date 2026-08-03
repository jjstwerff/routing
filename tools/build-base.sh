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
  # ⚠ THE CLIP IS SHARED WITH tools/build-blocks.sh, and its provenance must be too. Each script used to
  # record the box in its OWN sidecar — build-blocks in `<clip>.bbox`, build-base in `<clip>.recipe` — so
  # each saw its own record match, trusted a clip the other had rewritten, and silently built a different
  # REGION. Measured: a base block asked for 6.82558,52.1707,6.9958,52.3230 came out with the roads box's
  # extent (mnlo 6.5837 against 6.7762), 1748 tiles against 1098, 51% more buildings — and every count
  # looked plausible, because a bigger region really does have more of everything.
  #
  # One file, one sidecar, both scripts.
  cbox="$clip.bbox"
  if [ ! -f "$cbox" ] || [ "$(cat "$cbox" 2>/dev/null)" != "$bbox" ]; then
    [ -s "$clip" ] && echo "  bbox changed — discarding the cached clip"
    rm -f "$clip" "$cbox"
  fi
  if ! newer "$clip" "$pbf"; then
    osmium extract --bbox "$bbox" --overwrite -o "$clip" "$pbf" || exit 1
    printf '%s' "$bbox" > "$cbox"
  fi
  base_pbf="$clip"
fi

# One osmium pass per layer: filter, then export the form the generator streams.
#
# ⚠ EACH LAYER NAMES ITS GEOMETRY TYPE, and the area-shaped layers ask for `polygon` ONLY. osmium emits a
# closed tagged way TWICE — once as a LineString, once as the assembled area — so the default (everything)
# hands the generator each footprint two ways. That was survivable only because `feature_pts` silently
# dropped one of them; now that it parses MultiPolygon, taking both would bin every area twice.
#
# ⚠ AND `r/` IS AS IMPORTANT AS `w/`. `w/building` matches ways only; a multipolygon RELATION carries its
# tags on the relation and leaves its member ways bare, so nothing selected it and nothing could. That is
# how a 70615 m² `building=hospital` — Medisch Spectrum Twente — had no outline on the map. This block
# holds 122 building relations and 297 terrain relations.
layer() {  # $1 = layer name, $2 = osmium --geometry-types, $3… = tags-filter expressions
  local name="$1" gtypes="$2"; shift 2
  local fpbf="$work/$id.$name.osm.pbf" seq="$work/$id.$name.geojsonseq"
  # ⚠ THE BBOX IS PART OF EVERY LAYER'S RECIPE. Keyed on the tags-filter alone, a layer export survives a
  # change of REGION: the clip was correctly re-made for a new box and the five layer exports were reused
  # from the old one, so the block came out with the previous region's extent while every count looked
  # plausible. A cached artifact must name every input that can change it, and the region is one.
  local recipe="$bbox | $gtypes | $*"
  stale_by_recipe "$seq" "$recipe" && rm -f "$fpbf"
  if newer "$seq" "$base_pbf"; then echo "  $name: up to date ($(du -h "$seq" | cut -f1))"; return 0; fi
  osmium tags-filter --overwrite -o "$fpbf" "$base_pbf" "$@" || return 1
  osmium export "$fpbf" -f geojsonseq --geometry-types="$gtypes" --overwrite -o "$seq" || return 1
  printf '%s' "$recipe" > "$seq.recipe"
  echo "  $name: $(du -h "$seq" | cut -f1), $(wc -l < "$seq") features"
}

# `amenity` is filtered to SITE values only. The key also covers benches, parking and restaurants, and
# pulling all of those in as areas would recreate the slab problem it is here to fix.
SITES="hospital,school,university,college,kindergarten"
# Amenity values collected as AREAS: the site designations above, plus `grave_yard` — the churchyard
# spelling of `landuse=cemetery`, which is landcover rather than a site and is classified as such.
AMENITY_AREAS="$SITES,grave_yard"

echo "== base layers for $id =="
# ⚠ `historic` IS HERE FOR ITS NAME, not its fill. `area_use` gives a castle no cover, so it adds no
# polygon — what it adds is a rank-3 LABEL (basemap::area_label_kind). Without it a castle reaches the
# store only when it also carries `building=`, and 97 of the Netherlands' 971 named castle/manor polygons
# do not — Warmelo, Kasteel Doorwerth and the Citadel van 's-Hertogenbosch were absent from the map
# entirely, while the other 874 drew as ordinary house names.
layer areas     polygon    w/landuse w/natural w/leisure "w/amenity=$AMENITY_AREAS" w/aeroway=aerodrome w/historic \
                           r/landuse r/natural r/leisure "r/amenity=$AMENITY_AREAS" r/aeroway=aerodrome r/historic || exit 1
layer buildings polygon    w/building r/building         || exit 1
layer places    point      n/place                       || exit 1
layer lines     linestring w/waterway w/railway w/barrier w/aeroway=runway,taxiway \
                           w/boundary=administrative w/power=line \
                           r/waterway r/railway r/boundary=administrative || exit 1
layer pois      point      n/natural n/amenity n/tourism n/man_made n/historic n/leisure n/highway \
                           n/power=tower || exit 1
# Streets reuse the ROADS export: the generator selects `highway` + a name/ref itself, so a second pass
# over the same ways would only duplicate work and disk.
streets="$work/$id.geojsonseq"
[ -s "$streets" ] || { echo "FAIL: no roads export at $streets — run tools/build-blocks.sh $id $src first"; exit 1; }
# ⚠ THE STREETS LAYER COMES FROM build-blocks.sh, SO IT CARRIES ITS BBOX, NOT OURS. Reused across a change
# of region it silently widens the block: a base build asked for one box produced a store whose extent was
# partly the ROADS box's, because the street labels came from there. Every count looked plausible.
#
# The two boxes are allowed to differ (they were cut separately and are recorded separately in
# data/coverage.toml) — but then the roads export must be REGENERATED for this box first, and only its
# .geojsonseq is wanted; the roads block that run produces is a by-product.
# `clip` exists only when a bbox was given — a whole-extract build has no clip to compare against.
if [ -n "${clip:-}" ] && [ -f "$clip.bbox" ] && [ "$(cat "$clip.bbox" 2>/dev/null)" != "$bbox" ]; then
  echo "FAIL: the cached roads export was built for box $(cat "$clip.bbox")"
  echo "      and this base build asked for $bbox — its street labels would come from a different region."
  echo "      Run: tools/build-blocks.sh $id $src $bbox      (then re-run this)"
  exit 1
fi
if [ -n "${clip:-}" ] && [ "$clip" -nt "$streets" ]; then
  echo "FAIL: $streets predates the clip it should have come from — it is another region's export."
  echo "      Run: tools/build-blocks.sh $id $src $bbox      (then re-run this)"
  exit 1
fi
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
