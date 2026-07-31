#!/usr/bin/env bash
# Copyright (c) 2026 Jurjen Stellingwerff
# SPDX-License-Identifier: LGPL-3.0-or-later
#
# PLAN-SCALE N0 — DID A WHOLE CATEGORY GO MISSING?
#
# Counts what the OSM extract offers, counts what the block ended up holding, and fails when a category
# the source has is absent or far below its floor from the block.
#
# ⚠ THIS IS THE STEP THAT MAKES A COUNTRY POSSIBLE, and it is not a formality. Every map defect found here
# in the week before it was written was A WHOLE CATEGORY SILENTLY AT OR NEAR ZERO:
#
#   * `service` roads had a style but no place in the draw order — 10651 ways in this block, invisible;
#   * multipolygon RELATIONS were dropped by the geometry parser and never selected by the `w/` filters —
#     including a 70615 m² hospital and 297 terrain relations;
#   * `amenity=` was in no area filter at all, so hospital and campus sites did not exist;
#   * `natural=heath` and `scrub` were classified as grass — 3535 polygons drawn as lawn.
#
# Every one reached the live map, and every one was caught by a person who happens to know the city. That
# does not scale to the Netherlands and it certainly does not scale to Western Europe: nobody can eyeball
# a country. All four are trivially visible as a count against the source, which is what this does.
#
# WHAT IT DOES NOT DO: assert equality. Filters drop things legitimately — a ring under 3 points, a way
# under 2, an unclassified tag — so each category carries a FLOOR, and the floors are set from a measured
# healthy block rather than from hope. The hard failure is a category the source HAS and the block does
# not: that is never legitimate.
#
#   tools/conservation_gate.sh [region-id] [work-dir]
#     region-id   default: enschede    (matches the intermediates tools/build-*.sh leave behind)
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
loft="${LOFT_BIN:-$(command -v loft || echo /usr/local/bin/loft)}"
id="${1:-enschede}"
work="${2:-${BLOCKS_WORK:-$HOME/.cache/routing-blocks}}"
roads_store="${ROADS_STORE:-$here/browser/stores/$id.roads.store}"
base_store="${BASE_STORE:-$here/browser/stores/$id.layout.store}"
[ -f "$base_store" ] || base_store="$here/blocks/$id.base.store"
fail=0
ok()  { printf '  \342\234\223 %s\n' "$1"; }
bad() { printf '  FAIL: %s\n' "$1"; fail=1; }

command -v python3 >/dev/null || { echo "SKIP: python3 not found"; exit 2; }
for f in "$roads_store" "$base_store"; do
  [ -f "$f" ] || { echo "SKIP: no block at $f (build it first)"; exit 2; }
done

echo "== N0: does the block still hold every category the source offers? =="

census() { "$loft" --native --lib "$here/lib" "$here/tools/census.loft" "$1" "$2" 2>/dev/null | grep '^count '; }
have="$(census roads "$roads_store"; census base "$base_store")"
[ -n "$have" ] || { echo "  FAIL: the census produced nothing — the gate is blind"; exit 1; }
get() { echo "$have" | awk -v k="$1" '$2==k{print $3}'; }

# --- the source side ---------------------------------------------------------------------------------
# Counted from the layer exports the generator itself consumed where the filter is not category-specific
# (roads: one `w/highway` pass covers every class), and from the RAW extract where it is — a filter that
# never selected `amenity` cannot be caught by counting its own output.
seq="$work/$id.geojsonseq"
src_roads=0
if [ -s "$seq" ]; then src_roads="$(grep -c '"highway"' "$seq" 2>/dev/null || echo 0)"; fi

echo "  block: $(get roads.ways) ways · $(get roads.barriers) barriers · $(get base.areas) areas · $(get base.buildings) buildings · $(get base.lines) lines"

# --- 1. nothing the block should carry may be ZERO ----------------------------------------------------
# A category at zero in a real region is the signature of every defect this gate exists for. Listed
# explicitly rather than derived, so ADDING a category to the pipeline means adding it here — the pair is
# the point, and a category nobody asserts is a category that can vanish.
must=(roads.ways roads.barriers
      class.motorway class.trunk_primary class.secondary class.tertiary_unclassified class.residential
      class.service class.cycleway class.path class.footway class.track class.steps
      base.areas base.buildings base.lines base.labels base.pois
      cover.water cover.forest cover.grass cover.heath cover.scrub cover.park cover.farmland
      cover.residential cover.industrial cover.reserve cover.site
      line.stream line.ditch line.railway line.hedge line.fence line.runway line.taxiway
      label.street label.park label.sports label.cemetery label.site)
zero=""
for k in "${must[@]}"; do
  v="$(get "$k")"
  [ -n "$v" ] || v=0
  [ "$v" -gt 0 ] || zero="$zero $k"
done
if [ -n "$zero" ]; then
  bad "these categories are EMPTY in the block:$zero"
  echo "         a category the region certainly contains, holding nothing, is how every"
  echo "         silent-loss defect in this pipeline has looked."
else
  ok "${#must[@]} categories, none empty"
fi

# --- 2. roads: the block must hold nearly every highway the source offered ----------------------------
if [ "$src_roads" -gt 0 ]; then
  blk="$(get roads.ways)"
  pct="$(python3 -c "print(f'{100*$blk/$src_roads:.1f}')")"
  # ⚠ A RATIO ABOVE 100% MEANS THE TWO ARE NOT THE SAME REGION, not that the block did well. The export
  # left in the work dir is from whatever bbox was built last, and the shipped roads block was cut with an
  # earlier, wider one — 49613 ways against 34670, a cheerful 143% that says only that the comparison is
  # invalid. Reporting that as a pass is precisely the failure this gate exists to prevent, so it refuses
  # to draw a conclusion instead.
  if [ "$(python3 -c "print(1 if $blk > 1.05*$src_roads else 0)")" = "1" ]; then
    echo "  · roads: block $blk vs export $src_roads (${pct}%) — the export is from a DIFFERENT bbox,"
    echo "           so no ratio is meaningful. Rebuild both from one box (PLAN-SCALE N2) to enable this check."
  elif [ "$(python3 -c "print(1 if $blk >= 0.95*$src_roads else 0)")" = "1" ]; then
    ok "roads: $blk of $src_roads source highways kept (${pct}%)"
  else
    bad "roads: only $blk of $src_roads source highways reached the block (${pct}%, floor 95%)"
  fi
else
  echo "  · no $id.geojsonseq to compare roads against — run tools/build-blocks.sh for a source count"
fi

# --- 3. the proportions that have actually gone wrong -------------------------------------------------
# `service` and `track` are here by name because both have been lost: service had no draw order, track was
# folded into path. A block where they are a rounding error is a block where that happened again.
svc="$(get class.service)"; trk="$(get class.track)"; ways="$(get roads.ways)"
svc_pct="$(python3 -c "print(f'{100*$svc/max($ways,1):.1f}')")"
[ "$(python3 -c "print(1 if $svc >= 0.02*$ways else 0)")" = "1" ] \
  && ok "service is ${svc_pct}% of ways ($svc) — the class is present, not collapsed" \
  || bad "service is only ${svc_pct}% of ways ($svc); it was 21% when healthy"
[ "$trk" -gt 100 ] && ok "track is its own class ($trk), not folded into path" \
  || bad "track holds $trk ways — it was folded into path once and drew at the wrong zoom for months"

# --- 4. relations: the base map must hold more than its tagged closed ways ----------------------------
# Buildings are the sharpest probe for the relation bug: a multipolygon relation has no tagged way, so a
# `w/`-only pipeline loses it with no other symptom. 130k buildings here, 116 of them from relations.
bld="$(get base.buildings)"
[ "$bld" -gt 1000 ] && ok "buildings: $bld (relations included — a w/-only pipeline loses those silently)" \
  || bad "buildings: only $bld"

[ "$fail" -eq 0 ] || { echo "FAIL — a category the source offers is missing from the block"; exit 1; }
echo "PASS — every category the source offers survives into the block"
