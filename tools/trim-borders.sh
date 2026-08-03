#!/usr/bin/env bash
# Copyright (c) 2026 Jurjen Stellingwerff
# SPDX-License-Identifier: LGPL-3.0-or-later
#
# MAKE A SET OF PER-COUNTRY ROAD BLOCKS DISJOINT — @51 phase C, the border trim.
#
# THE PROBLEM, measured rather than assumed. Geofabrik's per-country extracts deliberately carry
# cross-border data, and a block keys a way at its FIRST VERTEX — so two neighbours each hold clipped
# fragments of the other. Belgium against the four live Netherlands regions: 377 shared cells, and NOT in
# one direction. 200 cells where Belgium holds more (22 635 ways against 5 428) and 170 where the
# Netherlands does (23 294 against 5 441).
#
# ⚠ SO THE OBVIOUS TRIM IS WRONG, and `plans/51-coverage-past-nl` specified it: "the neighbour needs its
# roads trimmed to cells the live index does not already own". Dropping all 377 from Belgium deletes
# 22 635 Belgian ways along the northern border and leaves a 5 428-way fragment in their place — a hole
# exactly where a cross-border route goes, which is the one thing the C3 rung exists to prove. It would
# pass `block_overlap_gate` and fail the rung.
#
# THE RULE THIS USES INSTEAD: every shared cell goes to whichever block actually holds more of it, and a
# tie goes to the higher-priority block. Priority is the order below — LIVE regions first, so nothing
# published is touched unless the neighbour genuinely holds more.
#
# ⚠ IT IS NOT LOSSLESS, and cannot be. `TRoad` carries no way id, so two blocks' versions of a cell
# cannot be merged and deduplicated — there is no key to dedupe on. Assigning by majority loses whatever
# the minority side held that the winner did not: measured at 14 137 ways of 4 405 797 (0.32%), against
# ~28 500 lost one-sidedly by the naive trim. If `TRoad` ever gains a way id, this becomes a merge.
#
#   tools/trim-borders.sh [out-dir]        # default blocks/trim
#   KEEP_WORK=1 tools/trim-borders.sh      # keep the per-pair drop lists for inspection
#
# It writes a TRIMMED COPY of every block and never touches the originals — the live NL blocks are
# published, and their replacement is a dataset decision, not this script's.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
loft="${LOFT_BIN:-$(command -v loft || echo /usr/local/bin/loft)}"
blocks="${BLOCKS_OUT:-$here/blocks}"
manifest="${COVERAGE_MANIFEST:-$here/data/coverage.toml}"
out="${1:-$blocks/trim}"
work="${TMPDIR:-/tmp}/trim-borders-$$"
mkdir -p "$out" "$work"
[ "${KEEP_WORK:-0}" = 1 ] || trap 'rm -rf "$work"' EXIT
die() { echo "FAIL: $*" >&2; exit 1; }

# --- priority order: live regions first, then staged ones in manifest order ---------------------------
# A live region's block is already published and resolvable; a staged one is not. Ties therefore go to
# the live side, so the published dataset moves only where the newcomer genuinely holds more.
live=(); staged=()
rid=""; rroads=""; rstg=""
flush() {
  [ -n "$rid" ] && [ -n "$rroads" ] && {
    if [ "${rstg:-false}" = "true" ]; then staged+=("$rid"); else live+=("$rid"); fi
  }
  rid=""; rroads=""; rstg=""
}
while IFS= read -r line; do
  case "$line" in
    '[[region]]'*) flush ;;
    roads*=*)      rroads="$(echo "$line" | cut -d'"' -f2)" ;;
    staged*=*)     rstg="$(echo "$line" | tr -d ' "' | cut -d= -f2)" ;;
    id*=*)         rid="$(echo "$line" | cut -d'"' -f2)" ;;
  esac
done < <(grep -v '^\s*#' "$manifest")
flush
[ ${#live[@]} -gt 0 ] || die "$manifest names no live region with roads"
order=("${live[@]}" "${staged[@]}")
echo "== border trim: ${#live[@]} live + ${#staged[@]} staged =="
echo "   priority: ${order[*]}"

# Every block starts as itself; drop lists accumulate per block and are applied once at the end, so a
# block compared in two pairs cannot lose a cell twice or have one pair's result hide another's.
declare -A drops
for r in "${order[@]}"; do
  [ -f "$blocks/$r.roads.store" ] || die "no roads block for $r"
  : >"$work/$r.drop"
done

# --- pairwise assignment ------------------------------------------------------------------------------
# `cell_diff` reads a REFERENCE against a set of PARTS, so the lower-priority block is the reference and
# the higher-priority one the part. Then:
#   SHORT  the reference holds more  -> the PART (higher priority) gives the cell up
#   OVER   the part holds more       -> the REFERENCE gives it up
#   MATCH  equal                     -> the reference gives it up (ties to the higher priority)
n=${#order[@]}
for ((i = 0; i < n; i++)); do
  for ((j = i + 1; j < n; j++)); do
    hi="${order[$i]}"; lo="${order[$j]}"
    d="$work/$lo-vs-$hi.txt"
    "$loft" --native --lib "$here/lib" "$here/tools/cell_diff.loft" --matches \
      "$blocks/$lo.roads.store" "$blocks/$hi.roads.store" >"$d" 2>&1
    sh=$(grep -c '^#C SHORT' "$d"); ov=$(grep -c '^#C OVER' "$d"); mt=$(grep -c '^#C MATCH' "$d")
    [ $((sh + ov + mt)) -eq 0 ] && { printf '   %-12s vs %-12s disjoint\n' "$lo" "$hi"; continue; }
    grep '^#C SHORT' "$d" | grep -oP 'cell \K[0-9]+' >>"$work/$hi.drop"
    { grep '^#C OVER' "$d"; grep '^#C MATCH' "$d"; } | grep -oP 'cell \K[0-9]+' >>"$work/$lo.drop"
    printf '   %-12s vs %-12s %s shared — %s to %s, %s to %s\n' \
      "$lo" "$hi" "$((sh + ov + mt))" "$sh" "$lo" "$((ov + mt))" "$hi"
  done
done

# --- apply -------------------------------------------------------------------------------------------
echo "== applying =="
for r in "${order[@]}"; do
  sort -u "$work/$r.drop" -o "$work/$r.drop"
  dst="$out/$r.roads.store"
  rm -f "$dst" "$dst.dschema"
  if [ ! -s "$work/$r.drop" ]; then
    # Nothing to drop: copy rather than skip, so the output directory is always a COMPLETE set. A
    # half-populated one is the shape that gets published by accident.
    cp "$blocks/$r.roads.store" "$dst"
    cp "$blocks/$r.roads.store.dschema" "$dst.dschema" 2>/dev/null || true
    printf '   %-12s unchanged\n' "$r"
    continue
  fi
  o="$("$loft" --native --lib "$here/lib" "$here/tools/trim_cells.loft" \
        "$blocks/$r.roads.store" "$dst" "$work/$r.drop" 2>&1)"
  echo "$o" | grep -q '#T ALL PASS' || { echo "$o" | grep '^#T' | sed 's/^/     /'; die "trim_cells for $r"; }
  echo "$o" | grep '^#T in' | sed "s/^/   $(printf '%-12s' "$r")/"
done

# --- prove it ----------------------------------------------------------------------------------------
# The whole point, and it is checked on the RESULT rather than argued from the drop lists: a set that is
# almost disjoint is exactly the shape that survives review.
echo "== the result, checked =="
paths=(); for r in "${order[@]}"; do paths+=("$out/$r.roads.store"); done
res="$("$loft" --native --lib "$here/lib" "$here/tools/block_overlap.loft" "${paths[@]}" 2>&1)"
echo "$res" | grep -E '^  block |^#O' | sed 's/^/  /'
echo "$res" | grep -q '^#O ALL PASS' || die "the trimmed set is still not disjoint"
echo
echo "  Trimmed copies in $out — the originals are untouched and still what the index resolves to."
echo "  Publishing these is a dataset decision: it changes four PUBLISHED Netherlands blocks."
exit 0
