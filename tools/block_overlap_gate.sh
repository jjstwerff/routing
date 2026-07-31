#!/usr/bin/env bash
# Copyright (c) 2026 Jurjen Stellingwerff
# SPDX-License-Identifier: LGPL-3.0-or-later
#
# PLAN-SCALE C2 — within one index, no two road blocks may hold the same cell.
#
# WHY IT IS A GATE. A corridor names every block whose extent it touches and reads the same cell window
# from each, so a cell held by two blocks it can name together delivers its roads TWICE. That is not a
# slower match, it is a different one — it survived once only because `build_graph` dedups nodes by coordinate (Enschede listed
# inside the Netherlands turned 7,138 ways into 9,438 for an identical route, which is luck, not design).
#
# The index cannot check this: it stores extents, and extents legitimately overlap because a feature is
# keyed by its first vertex and never clipped. Only the cell sets settle it, and only the blocks
# themselves have those.
#
# ⚠ THE INVARIANT IS PER RESOLVABLE SET, not per manifest. A region is reachable from exactly one index —
# the site index (blocks that ship beside the app) or a release index (blocks published under a
# `url_base`) — and a corridor can only ever name blocks from the index it resolved against. Two blocks in
# DIFFERENT indexes can never be read together, so they may overlap: the Enschede block that ships with
# the app sits inside the Netherlands regions and shares 84 cells with nl-east, which is correct and
# harmless. The first version of this gate compared everything to everything and failed on exactly that —
# a real ambiguity in the model, and the reason the rule is now stated this precisely.
#
# It matters most for the step that has not happened yet. Blocks cut from ONE extract on cell boundaries
# are disjoint by construction; blocks taken from per-country Geofabrik extracts are not, because those
# deliberately include cross-border data. Western Europe is many files, and this is the check that says
# which kind they are — before a continent is generated on top of the wrong one.
#
#   tools/block_overlap_gate.sh
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
loft="${LOFT_BIN:-$(command -v loft || echo /usr/local/bin/loft)}"
manifest="$here/data/coverage.toml"
[ -f "$manifest" ] || { echo "SKIP: no manifest"; exit 2; }

# Read the manifest into (url_base, roads-path) pairs — the url_base IS the index a region belongs to —
# resolving each block wherever it actually lives: beside the app (committed, small) or in blocks/
# (generated, published).
declare -A group_paths
missing=()
ubase=""; roads=""
flush() {
  [ -n "$roads" ] || return 0
  local key="${ubase:-__site__}" found=""
  for cand in "$here/_site/$roads" "$here/browser/$roads" "$here/blocks/$(basename "$roads")"; do
    [ -f "$cand" ] && { found="$cand"; break; }
  done
  if [ -n "$found" ]; then group_paths[$key]="${group_paths[$key]:-} $found"; else missing+=("$roads"); fi
  ubase=""; roads=""
}
while IFS= read -r line; do
  case "$line" in
    '[[region]]'*) flush ;;
    *roads*=*)     roads="$(echo "$line" | cut -d'"' -f2)" ;;
    # ⚠ `base_url_base` says where the BASE MAP lives and must be IGNORED here — this gate is about road
    # blocks, and hosting is per store since NL split (its roads ship on Pages, its base map does not).
    # Left to the glob below it would have matched `*url_base*`, filed both NL halves under the release,
    # and reported "the site index: 1 block" — a pass by not looking.
    *base_url_base*=*) ;;
    *url_base*=*)  ubase="$(echo "$line" | cut -d'"' -f2)" ;;
  esac
done < <(grep -v '^\s*#' "$manifest")
flush

echo "== C2: within one index, no cell is held by two road blocks =="
[ ${#missing[@]} -eq 0 ] || printf '  (not present locally, skipped: %s)\n' "${missing[*]}"

rc=0; checked=0
for key in "${!group_paths[@]}"; do
  read -r -a paths <<< "${group_paths[$key]}"
  label="$key"; [ "$key" = "__site__" ] && label="the site index"
  if [ ${#paths[@]} -lt 2 ]; then
    echo "  $label: ${#paths[@]} block — nothing to compare"
    continue
  fi
  checked=$((checked + 1))
  echo "  $label:"
  out="$("$loft" --native --lib "$here/lib" "$here/tools/block_overlap.loft" "${paths[@]}" 2>&1)" \
    || { echo "$out"; echo "FAIL — the overlap probe did not run"; exit 1; }
  echo "$out" | grep -E '^  block |^#O' | sed 's/^/    /'
  echo "$out" | grep -q '^#O ALL PASS' || rc=1
done

# …and prove the check can still FAIL, on every run. Since nesting became an allowed outcome (a city block
# inside a country block shares all its cells by design), "no partial overlap" is a verdict this gate can
# reach by not looking hard enough — so it manufactures a pair it MUST reject. Two splits of the same
# block at DIFFERENT longitudes: each half holds cells the other lacks, plus a shared band between the
# cuts. That is the real defect's exact shape, built from data already in the repo.
src="$here/browser/stores/enschede.roads.store"
if [ -f "$src" ]; then
  t="$(mktemp -d)"
  "$loft" --native --lib "$here/lib" "$here/tools/split_block.loft" "$src" "$t/a_w" "$t/a_e" 6.85 >/dev/null 2>&1
  "$loft" --native --lib "$here/lib" "$here/tools/split_block.loft" "$src" "$t/b_w" "$t/b_e" 6.92 >/dev/null 2>&1
  self="$("$loft" --native --lib "$here/lib" "$here/tools/block_overlap.loft" "$t/a_e" "$t/b_w" 2>&1)"
  rm -rf "$t"
  if echo "$self" | grep -q '^#O FAIL — blocks 0 and 1 PARTIALLY overlap'; then
    echo "  self-check: a manufactured partial overlap IS rejected ($(echo "$self" | grep -oP 'PARTIALLY overlap: \K[0-9]+') shared cells)"
  else
    echo "FAIL — the gate no longer detects a partial overlap it was handed on purpose:"
    echo "$self" | grep -E '^#O' | sed 's/^/       /'
    exit 1
  fi
fi

if [ "$checked" -eq 0 ]; then
  echo "SKIP — no index has two blocks present locally"
  exit 2
fi
if [ $rc -ne 0 ]; then
  echo "FAIL — two blocks in ONE index share cells. A corridor there reads those roads twice and matches"
  echo "       a different route. Cut regions on cell boundaries from one extract (tools/split_block.loft)"
  echo "       rather than from per-country extracts, which overlap at every border."
  exit 1
fi
echo "PASS — every index's road blocks are disjoint by cell"
