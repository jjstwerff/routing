#!/usr/bin/env bash
# Copyright (c) 2026 Jurjen Stellingwerff
# SPDX-License-Identifier: LGPL-3.0-or-later
#
# ONE COMMAND for a whole region refresh — acquire → roads → networks → heights → names → base → cut →
# DERIVED → index.
#
# Every step here already existed as its own script; what did not exist was the ORDER, and the order is
# where the mistakes live. Doing it by hand on 2026-08-01 produced four of them, each of which passed the
# step that caused it and failed something later:
#
#   * the base map was rebuilt but its halves were never split, so `blocks/` held a 2 GB store the
#     manifest does not name and no halves that it does;
#   * the index was bumped to a new version while `data/coverage.toml` still published from the old tag
#     (caught by index_fresh_gate — two different files, nothing else would have noticed);
#   * `publish-release.sh` would have uploaded the un-split whole-country intermediates, 2.2 GB nobody
#     can resolve to;
#   * the RELEASE index came out EMPTY, because the rule deciding what belongs in it still assumed
#     hosting was per region.
#
# So this script's value is not that it saves typing. It is that the sequence is written down once, with
# the conservation checks between the steps rather than after all of them.
#
#   tools/refresh-region.sh <region-id> <geofabrik-path> [bbox]
#     --no-base    skip the base map (roads + names only — see the note on cost below)
#     --regions    cut into the regions data/coverage.toml names (tools/cut-regions.sh) — what you want
#     --split LON  cut in two at this longitude into <id>-west / <id>-east
#
# ⚠ `--split` PREDATES THE COVERAGE MODEL AND IS NOT WHAT SHIPS. The manifest has named FOUR regions cut
# at 4.70 / 5.40 / 5.90 since PLAN-SCALE §6f F3, and a two-way split produces blocks whose names nothing
# downstream asks for: `publish-release.sh` fails building the release index on the four the manifest
# does name — after uploading gigabytes. It is kept because splitting one block in two is still the
# cheapest way to manufacture a seam for a gate (S8), which is what it was written for. For a refresh
# that will be published, use `--regions`.
#
# ⚠ COST, measured on the Netherlands 2026-08-01, because it decides where this can run:
#     roads + names   ~6 min, ~3 GB peak disk, well inside a CI runner
#     base map        ~28 min, ~6 GB RSS and ~11.7 GB of intermediates — too big for a
#                     GitHub-hosted runner's ~14 GB disk once a checkout and toolchain are on it
#   That asymmetry is why `--no-base` exists and why the workflow uses it.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/.."
here="$(cd "$here" && pwd)"
loft="${LOFT_BIN:-$(command -v loft || echo /usr/local/bin/loft)}"
work="${BLOCKS_WORK:-$HOME/.cache/routing-blocks}"
out="${BLOCKS_OUT:-$here/blocks}"

id=""; src=""; bbox=""; do_base=1; split_lon=""; do_regions=0
while [ $# -gt 0 ]; do
  case "$1" in
    --no-base) do_base=0; shift ;;
    --regions) do_regions=1; shift ;;
    --split)   split_lon="${2:-}"; shift 2 ;;
    *) if [ -z "$id" ]; then id="$1"; elif [ -z "$src" ]; then src="$1"; else bbox="$1"; fi; shift ;;
  esac
done
[ "$do_regions" = 1 ] && [ -n "$split_lon" ] && { echo "FAIL: --regions and --split are two different cuts; pick one" >&2; exit 2; }
[ -n "$id" ] && [ -n "$src" ] || { sed -n '/^#   tools\/refresh-region.sh/,/^#   That asymmetry/p' "$0" | sed 's/^# \?//'; exit 2; }

step() { echo; echo "########## $* ##########"; }
die()  { echo "FAIL: $*" >&2; exit 1; }

step "1/8 roads — acquire, filter, export, join networks, generate"
"$here/tools/build-blocks.sh" "$id" "$src" ${bbox:+"$bbox"} || die "build-blocks"

step "2/8 heights — sample terrain into TStep.h (PLAN-RESTORE R2)"
# BEFORE the cut, deliberately: `split_block.loft` already carries `h` through, so sampling the country
# once gives all four regions their heights. Doing it after would be four passes over four terrain grids
# for the same answer.
#
# ⚠ NOT FATAL. Terrain is a third-party download and the rest of the dataset does not depend on it — a
# refresh that cannot reach the terrain service should still produce routable blocks, with `h` at 0 as it
# has been all along. It says so loudly rather than failing the run.
if [ "${SKIP_HEIGHTS:-0}" = "1" ]; then
  echo "  SKIPPED (SKIP_HEIGHTS=1)"
elif ! "$here/tools/bake-heights.sh" "$out/$id.roads.store" "${TERRAIN_ZOOM:-12}"; then
  echo "  ⚠ HEIGHTS NOT BAKED — the blocks are routable but carry h=0, so there is no elevation profile."
  echo "    Re-run on the built block when the terrain is reachable: tools/bake-heights.sh $out/$id.roads.store"
fi

step "3/8 names — street + place search index (PLAN-RESTORE R4)"
"$loft" --native-release --lib "$here/lib" "$here/tools/gen-names.loft" \
  "$out/$id.names.store" "$work/$id.geojsonseq" "$work/$id.places.geojsonseq" \
  || die "gen-names"

# The three-collection SEARCH INDEX over the store just written (docs/name-search-index.md §8). Without
# it the app reads the whole 21.4 MB names store before it can answer the first keystroke; with it the
# names store is not fetched at all — the vocabulary is 5.5 MB gzipped and the rest arrives by range.
#
# ⚠ NOT `die` ON FAILURE, unlike every step above it. The index is an accelerator with an exact
# fallback: a region without one scans, which is the behaviour that shipped for a year. Failing the
# whole refresh — and losing the roads and the base map with it — because an optimisation did not build
# would be the wrong trade. It says so loudly instead, the way bake-heights does.
if "$loft" --native-release --lib "$here/lib" "$here/tools/gen-names-index.loft" \
     "$out/$id.names.store" "$out/$id"; then
  :
else
  echo "  ⚠ SEARCH INDEX NOT BUILT — search still works, by reading the whole names store."
  echo "    Re-run on the built store: tools/gen-names-index.loft $out/$id.names.store $out/$id"
fi

if [ "$do_base" = 1 ]; then
  step "4/8 base map — landcover, buildings, lines, labels, pois"
  "$here/tools/build-base.sh" "$id" "$src" ${bbox:+"$bbox"} || die "build-base"
else
  step "4/8 base map — SKIPPED (--no-base)"
fi

if [ "$do_regions" = 1 ]; then
  step "5/8 cut into the regions data/coverage.toml names"
  # The cut, its bounds, its two opposite rules and its conservation checks all live in one place —
  # see the header of that script for why they may not live here as well.
  SKIP_BASE="$([ "$do_base" = 1 ] && echo 0 || echo 1)" "$here/tools/cut-regions.sh" "$id" || die "cut-regions"
elif [ -n "$split_lon" ]; then
  step "5/8 split at ${split_lon}°E"
  # ⚠ CONSERVATION IS CHECKED HERE, not at the end. A split that loses a tile produces two blocks that
  # each look fine and a country with a hole in it; the only moment the whole and the parts can be
  # compared is right now, while both exist.
  rm -f "$out/$id-west.roads.store" "$out/$id-east.roads.store"
  "$loft" --native --lib "$here/lib" "$here/tools/split_block.loft" \
    "$out/$id.roads.store" "$out/$id-west.roads.store" "$out/$id-east.roads.store" "$split_lon" \
    | grep -E '^split at|persist' | sed 's/^/  /' || die "split_block"
  if [ "$do_base" = 1 ] && [ -f "$out/$id.base.store" ]; then
    rm -f "$out/$id-west.base.store" "$out/$id-east.base.store"
    "$loft" --native --lib "$here/lib" "$here/tools/split_base.loft" \
      "$out/$id.base.store" "$out/$id-west.base.store" "$out/$id-east.base.store" "$split_lon" \
      | grep -E '^split at|persist' | sed 's/^/  /' || die "split_base"
  fi
  # The whole and the parts, compared. `census` is the same tool the conservation gate uses, so this is
  # the gate's own arithmetic applied one step earlier — where it can still say WHICH step lost the data.
  wh="$("$loft" --native --lib "$here/lib" "$here/tools/census.loft" roads "$out/$id.roads.store" 2>/dev/null | grep -oP '^count roads.ways \K[0-9]+')"
  we="$("$loft" --native --lib "$here/lib" "$here/tools/census.loft" roads "$out/$id-west.roads.store" 2>/dev/null | grep -oP '^count roads.ways \K[0-9]+')"
  ea="$("$loft" --native --lib "$here/lib" "$here/tools/census.loft" roads "$out/$id-east.roads.store" 2>/dev/null | grep -oP '^count roads.ways \K[0-9]+')"
  echo "  conservation: $we + $ea = $((we + ea)) against $wh whole"
  [ "$((we + ea))" = "$wh" ] || die "the split lost $((wh - we - ea)) ways — do not publish this"
fi

# ⚠ THE DERIVED BLOCKS WERE MISSING FROM THIS SEQUENCE ENTIRELY, and only `data-refresh.yml` built them
# (it calls `build-derived.sh netherlands` as its own step). So a refresh run BY HAND produced fresh
# regions and left the overview and the middle zooms describing the previous snapshot — the exact silent
# staleness `build-derived.sh`'s own header exists to prevent, one level up, and nothing reported it
# because `publish-release.sh` uploads whatever `blocks/` holds that the manifest names.
#
# It goes BEFORE the index, and that ordering is not cosmetic: `build_index.sh` opens every block the
# manifest names to read its real extent, so a derived block that does not exist yet fails the index.
if [ "$do_base" = 1 ]; then
  step "6/8 derived blocks — the overview and the middle zooms"
  # Scoped to this country: the blocks it feeds get rebuilt, the ones it does not are left alone, and
  # the overview is rebuilt either way because it reads every region (tools/derived_scope_gate.sh).
  "$here/tools/build-derived.sh" "$id" || die "build-derived"
else
  # ⚠ NOT a silent skip. A derived block is a function of the region BASE stores, so with --no-base there
  # is nothing new to derive from and rebuilding would only re-persist the previous snapshot under a
  # fresh mtime. That is what the workflow does deliberately — it runs --no-base here and builds the base
  # and the derived blocks in a later job, where the disk for them exists.
  step "6/8 derived blocks — SKIPPED (--no-base); run tools/build-derived.sh $id after the base map"
fi

step "7/8 index"
# The version and the release tag are ONE decision. Set them apart and index_fresh_gate rejects the
# result — which is right, and is why this takes the tag rather than inventing a date.
ver="${DATASET_VERSION:-v$(date -u +%Y-%m-%d)}"
if grep -q 'base_url_base\|url_base' "$here/data/coverage.toml"; then
  sed -i -E "s|(url_base = \"https://github.com/[^\"]*/download/)data-v[0-9-]+\"|\\1data-$ver\"|g" "$here/data/coverage.toml"
fi
DATASET_VERSION="$ver" "$here/tools/build_index.sh" || die "build_index"

step "8/8 what is left, and why it is not automatic"
cat <<EOF
  Built into $out. NOT published — publishing replaces data other people may be reading, so it stays a
  deliberate act:

    tools/publish-release.sh data-$ver      # upload, verify each asset answers a Range request, index LAST

  Then commit browser/coverage.json (its sha256s changed) and run the gates:

    make test-native && make test-map
EOF
