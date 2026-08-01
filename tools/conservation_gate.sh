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
[ -f "$roads_store" ] || { echo "SKIP: no roads block at $roads_store (build it first)"; exit 2; }
# The base map is checked when there IS one. A country's roads land a rung before its base map
# (PLAN-SCALE N2 before N5), and a gate that refuses to run until both exist would be useless for
# exactly the step it was written for.
base_ok=1
[ -f "$base_store" ] || { base_ok=0; }

echo "== N0: does the block still hold every category the source offers? =="

census() { "$loft" --native --lib "$here/lib" "$here/tools/census.loft" "$1" "$2" 2>/dev/null | grep '^count '; }
have="$(census roads "$roads_store"; [ "$base_ok" = 1 ] && census base "$base_store")"
[ -n "$have" ] || { echo "  FAIL: the census produced nothing — the gate is blind"; exit 1; }
get() { echo "$have" | awk -v k="$1" '$2==k{print $3}'; }

# --- the source side ---------------------------------------------------------------------------------
# Counted from the layer exports the generator itself consumed where the filter is not category-specific
# (roads: one `w/highway` pass covers every class), and from the RAW extract where it is — a filter that
# never selected `amenity` cannot be caught by counting its own output.
seq="$work/$id.geojsonseq"
src_roads=0
# ⚠ LINESTRINGS ONLY. The export carries the barrier NODES too (`w/highway n/barrier`), and a great many
# of those carry a highway tag of their own — `highway=crossing`, `traffic_signals`. Counting every
# feature with a highway tag charges the block for 206,300 nodes it was never meant to hold, and reads as
# a 6.9% loss: the Netherlands block scored 93.1% while holding 2,784,366 of 2,784,366 source WAYS, which
# is everything. A source count that counts the wrong things is not a floor, it is a false alarm.
if [ -s "$seq" ]; then
  src_roads="$(grep '"LineString"' "$seq" 2>/dev/null | grep -c '"highway"' || echo 0)"
fi

if [ "$base_ok" = 1 ]; then
  echo "  block: $(get roads.ways) ways · $(get roads.barriers) barriers · $(get base.areas) areas · $(get base.buildings) buildings · $(get base.lines) lines"
else
  echo "  block: $(get roads.ways) ways · $(get roads.barriers) barriers"
fi

# --- 1. nothing the block should carry may be ZERO ----------------------------------------------------
# A category at zero in a real region is the signature of every defect this gate exists for. Listed
# explicitly rather than derived, so ADDING a category to the pipeline means adding it here — the pair is
# the point, and a category nobody asserts is a category that can vanish.
must=(roads.ways roads.barriers
      class.motorway class.trunk_primary class.secondary class.tertiary_unclassified class.residential
      class.service class.cycleway class.path class.footway class.track class.steps
      # Signposted route networks (PLAN-RESTORE R3). These come from a JOIN against route relations, not
      # from a way's own tags, so they have a failure mode none of the classes above has: the join can
      # silently match nothing — a sidecar built for another region, or an export run without
      # `-u type_id` — and every one of these goes to zero while the block stays perfectly valid.
      network.walk network.cycle network.mtb
      )
if [ "$base_ok" = 1 ]; then
  must+=(base.areas base.buildings base.lines base.labels base.pois
         cover.water cover.forest cover.grass cover.heath cover.scrub cover.park cover.farmland
         cover.residential cover.industrial cover.reserve cover.site
         line.stream line.ditch line.railway line.hedge line.fence line.runway line.taxiway
         line.border line.powerline poi.tree poi.pylon
         label.street label.park label.sports label.cemetery label.site)
else
  echo "  · no base map at $base_store — roads only (a country's roads land a rung before its base map)"
fi
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
# ⚠ ONLY WHEN BOTH SIDES ARE KNOWN TO DESCRIBE THE SAME GROUND. A count against a different bbox is not a
# measurement in EITHER direction: too high says the block is wider than the export (49613 vs 34670, a
# cheerful 143%), too low says the export is wider than the block (49613 vs 52790, an alarming 94%) — and
# neither says anything about whether roads were lost. The first version guarded only the high side, which
# is worse than guarding neither: it failed loudly on the ambiguous case having passed quietly on it.
#
# So the check runs only when the block's own recorded box (written by build-blocks.sh) matches the clip
# the export came from. Until a block is rebuilt with that provenance it reports why it is skipped.
# The source count recorded WHEN THE BLOCK WAS BUILT is the only one that means anything: a block held
# against a later export is measured against a different day's OSM. The shipped block reads 94.6% of
# today's extract and has lost nothing at all — the extract is simply two days newer.
built_src="$(cat "$roads_store.srccount" 2>/dev/null | tr -dc '0-9')"
[ -n "$built_src" ] && src_roads="$built_src"
blk_box="$(cat "$roads_store.bbox" 2>/dev/null)"
src_box="$(cat "$work/$id.clip.osm.pbf.bbox" 2>/dev/null)"
# ⚠ ONLY the build-time count will do. A matching bbox proves the two describe the same GROUND, not the
# same DAY: the shipped block and today's extract agree on the box and disagree by 2837 highways purely
# because the extract is two days newer, which read as 94.6% and a failure. Same ground, different
# snapshot, nothing lost. So a bbox match is necessary and not sufficient, and the fallback that used it
# is gone rather than loosened.
if [ -n "$built_src" ]; then
  blk="$(get roads.ways)"
  pct="$(python3 -c "print(f'{100*$blk/$src_roads:.1f}')")"
  if [ "$(python3 -c "print(1 if $blk >= 0.95*$src_roads else 0)")" = "1" ]; then
    ok "roads: $blk of $src_roads source highways kept (${pct}%)${built_src:+, counted at build time}"
  else
    bad "roads: only $blk of $src_roads source highways reached the block (${pct}%, floor 95%)"
  fi
elif [ "$src_roads" -gt 0 ]; then
  echo "  · roads ratio SKIPPED — no build-time source count beside this block (<store>.srccount)."
  echo "           Its box '${blk_box:-unrecorded}' and the export's '${src_box:-unrecorded}' may even agree;"
  echo "           that proves the same GROUND, not the same DAY. A block must be held against the export"
  echo "           that built it, or OSM drift reads as loss."
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
if [ "$base_ok" = 1 ]; then
  bld="$(get base.buildings)"
  [ "$bld" -gt 1000 ] && ok "buildings: $bld (relations included — a w/-only pipeline loses those silently)" \
    || bad "buildings: only $bld"
fi

[ "$fail" -eq 0 ] || { echo "FAIL — a category the source offers is missing from the block"; exit 1; }
echo "PASS — every category the source offers survives into the block"
