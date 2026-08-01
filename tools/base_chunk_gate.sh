#!/usr/bin/env bash
# Copyright (c) 2026 Jurjen Stellingwerff
# SPDX-License-Identifier: LGPL-3.0-or-later
#
# PLAN-SCALE §6e step 1 — building a base map in N chunks loses nothing.
#
# This is the property Western Europe stands on. `build_store.loft` accumulates its whole store in memory
# (~350 bytes of RSS per feature), so a continent cannot be one store and a region sometimes cannot be
# either. Chunking is the answer — but only if the chunks are a PARTITION of the whole, and that is not
# obvious: `osmium extract` keeps whole ways, so a feature straddling a chunk edge lands in both
# neighbouring extracts and is binned by its first vertex to the same tile in both. `trim_base.loft` cuts
# each chunk to its own cell band; this proves the cut is exact.
#
# THE CONTROL IS n=1 THROUGH THE SAME SCRIPT, not a separately-built store. A hand-built reference differs
# by whatever else moved — the first attempt compared against the shipped Enschede block and came out 341
# features apart, which was OSM drift between two build dates and nothing to do with chunking. Same script,
# same inputs, same day: the only variable left is the number of chunks.
#
#   tools/base_chunk_gate.sh [region-id] [geofabrik-path] [bbox] [n]
#
# ⚠ SLOW BY NATURE — it builds the region twice (once whole, once in n chunks). Defaults to Enschede,
# which is ~4 minutes. It is not in `make test-native` for that reason; run it when the chunking, the
# trim, or the tiling changes.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
loft="${LOFT_BIN:-$(command -v loft || echo /usr/local/bin/loft)}"
id="${1:-enschede}"
src="${2:-europe/netherlands}"
bbox="${3:-6.82558,52.1707,6.9958,52.3230}"
n="${4:-2}"
command -v osmium >/dev/null || { echo "SKIP: osmium-tool not installed"; exit 2; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

extent() {  # $1 = store → "tiles features"
  "$loft" --native --lib "$here/lib" "$here/tools/store_extent.loft" "$1" base 2>/dev/null \
    | grep -oP '^EXTENT \K.*' | awk '{print $5" "$6}'
}
totals() {  # $1 = dir, $2 = id prefix → summed "tiles features"
  local t=0 f=0 e
  for b in "$1/$2"-c*.base.store; do
    [ -f "$b" ] || continue
    e="$(extent "$b")"; set -- $e
    t=$((t + $1)); f=$((f + $2))
  done
  echo "$t $f"
}

echo "== §6e: a base map built in $n chunks is the same map =="

echo "  building the CONTROL (n=1)…"
BLOCKS_OUT="$work/ref" "$here/tools/build-base-chunked.sh" "${id}ref" "$src" "$bbox" 1 >"$work/ref.log" 2>&1 \
  || { tail -5 "$work/ref.log"; echo "FAIL — the control build did not complete"; exit 1; }
read -r rt rf <<<"$(totals "$work/ref" "${id}ref")"
echo "    control : tiles=$rt features=$rf"

echo "  building in $n chunks…"
BLOCKS_OUT="$work/chunk" "$here/tools/build-base-chunked.sh" "$id" "$src" "$bbox" "$n" >"$work/chunk.log" 2>&1 \
  || { tail -5 "$work/chunk.log"; echo "FAIL — the chunked build did not complete"; exit 1; }
read -r ct cf <<<"$(totals "$work/chunk" "$id")"
grep -E '^  #T' "$work/chunk.log" | sed 's/^/    /'
echo "    chunked : tiles=$ct features=$cf"

# Non-vacuity first: two empty builds agree perfectly and prove nothing.
[ "${rt:-0}" -ge 100 ] && [ "${rf:-0}" -ge 10000 ] \
  || { echo "FAIL — the control is too small to prove anything (tiles=$rt features=$rf)"; exit 1; }
[ "$n" -ge 2 ] || { echo "FAIL — n=$n is not a chunked build"; exit 1; }
nchunks="$(ls -1 "$work/chunk/$id"-c*.base.store 2>/dev/null | wc -l)"
[ "$nchunks" = "$n" ] || { echo "FAIL — expected $n chunk stores, found $nchunks"; exit 1; }

rc=0
[ "$ct" = "$rt" ] || { echo "FAIL — tiles differ: $n chunks give $ct, whole gives $rt"; rc=1; }
[ "$cf" = "$rf" ] || { echo "FAIL — features differ: $n chunks give $cf, whole gives $rf ($((cf - rf)))"; rc=1; }
[ $rc -eq 0 ] || {
  echo "       A chunked build must be a PARTITION of the whole. More features than the whole means the"
  echo "       trim let a neighbour's tiles through (the margin is on an OUTER edge?); fewer means a band"
  echo "       boundary dropped tiles neither side claimed."
  exit 1; }

# …and the chunks must be DISJOINT, which equal totals alone do not prove: one chunk holding a tile twice
# while another misses it sums correctly. Cell-level disjointness is what `block_overlap` measures.
ov="$("$loft" --native --lib "$here/lib" "$here/tools/block_overlap.loft" "$work/chunk/$id"-c*.base.store 2>&1)" || true
if echo "$ov" | grep -q 'PARTIALLY overlap'; then
  echo "$ov" | grep -E '^#O' | sed 's/^/    /'
  echo "FAIL — the chunks share cells; they are not a partition"
  exit 1
fi

echo "  ✓ $n chunks == 1 whole: $ct tiles, $cf features, no shared cells"
echo "PASS — chunking the base map is lossless (PLAN-SCALE §6e step 1)"
