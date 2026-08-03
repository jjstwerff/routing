#!/usr/bin/env bash
# Copyright (c) 2026 Jurjen Stellingwerff
# SPDX-License-Identifier: LGPL-3.0-or-later
#
# GIVE A ROADS BLOCK ITS HEIGHTS — extent → terrain → pack → sample (PLAN-RESTORE R2).
#
# The three tools underneath each do one thing and none of them knows where the block is; this is the
# order, which is the part that is easy to get wrong. It is a separate script from `refresh-region.sh`
# for the same reason `cut-regions.sh` is: the recipe has to be runnable on ONE block by hand, or the
# only way to re-sample after a terrain change is to regenerate a country.
#
#   tools/bake-heights.sh <block.roads.store> [zoom]
#
# The bounding box comes from the BLOCK, via `store_extent.loft`, never from the manifest — the manifest
# deliberately declares no extents, and a box that outran the data would fetch terrain for ground the
# block does not have while missing ground it does.
#
# ⚠ IDEMPOTENT, and cheap to repeat. The terrain cache is only refilled for tiles it lacks, the pack is
# rebuilt from it, and sampling the same grid writes the same heights. Terrain does not change between OSM
# snapshots, so a refresh pays the download once, ever.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
loft="${LOFT_BIN:-$(command -v loft || echo /usr/local/bin/loft)}"
tdir="${TERRAIN_DIR:-$HOME/.cache/routing-terrain}"

block="${1:-}"
zoom="${2:-${TERRAIN_ZOOM:-12}}"
[ -n "$block" ] || { sed -n '/^#   tools\/bake-heights.sh/,/^# ⚠ IDEMPOTENT/p' "$0" | sed 's/^# \?//'; exit 2; }
[ -f "$block" ] || { echo "FAIL: no block at $block" >&2; exit 1; }

die() { echo "FAIL: $*" >&2; exit 1; }

# --- 1. what ground does this block actually hold? -------------------------------------------------
ext="$("$loft" --native --lib "$here/lib" "$here/tools/store_extent.loft" "$block" roads 2>/dev/null \
       | grep -oP '^EXTENT \K.*')"
[ -n "$ext" ] || die "store_extent read no extent from $block"
read -r mnla mnlo mxla mxlo _tiles _feat <<<"$ext"
bbox="$(awk -v a="$mnlo" -v b="$mnla" -v c="$mxlo" -v d="$mxla" \
  'BEGIN { printf "%.5f,%.5f,%.5f,%.5f", a/1e7, b/1e7, c/1e7, d/1e7 }')"
echo "== heights for $(basename "$block") =="
echo "   extent $bbox  (from the block, not the manifest)"

# --- 2. terrain, once ------------------------------------------------------------------------------
TERRAIN_DIR="$tdir" "$here/tools/fetch-terrain.sh" "$bbox" "$zoom" "$tdir" | sed 's/^/   /' \
  || die "fetch-terrain"

# --- 3. pack, then sample --------------------------------------------------------------------------
grid="${BLOCKS_WORK:-$HOME/.cache/routing-blocks}/$(basename "$block" .roads.store).z$zoom.hgt"
mkdir -p "$(dirname "$grid")"
rm -f "$grid"                     # pack_terrain refuses an existing target, and a stale one is worse
python3 "$here/tools/pack_terrain.py" "$tdir" "$zoom" "$bbox" "$grid" | sed 's/^/   /' || die "pack_terrain"

before="$(stat -c%s "$block")"
out="$("$loft" --native --lib "$here/lib" "$here/tools/gen_heights.loft" "$block" "$grid" 2>&1)"
grep '^#H' <<<"$out" | sed 's/^/   /'
# ⚠ It reports failure on STDOUT and exits ZERO, like every store tool here (tools/cut-regions.sh).
grep -q '#H FAIL' <<<"$out" && die "gen_heights"

steps="$(grep -oP '^#H tiles=\d+ steps=\K[0-9]+' <<<"$out")"
filled="$(grep -oP '^#H tiles=\d+ steps=\d+ filled=\K[0-9]+' <<<"$out")"
[ -n "$steps" ] && [ -n "$filled" ] || die "gen_heights printed no counts"
# A partly-sampled block is the silent failure: it publishes looking finished and draws a profile with
# holes in it. Terrarium covers the whole land surface, so anything short of every step means the grid is
# wrong, not that the terrain is missing.
[ "$filled" = "$steps" ] || die "only $filled of $steps steps got a height — the grid does not cover this block"

after="$(stat -c%s "$block")"
[ "$after" = "$before" ] || die "the block changed size: $before -> $after (h was already in the schema)"
echo "   ✔ every step sampled, block unchanged at $before bytes"
