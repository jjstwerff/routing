#!/usr/bin/env bash
# Copyright (c) 2026 Jurjen Stellingwerff
# SPDX-License-Identifier: LGPL-3.0-or-later
#
# Build a region's BASE MAP in N longitude chunks (PLAN-SCALE §6e step 1).
#
# WHY. `client/basemap/build_store.loft` streams its INPUT but accumulates the whole store in memory —
# measured ~350 bytes of RSS per feature, so the Netherlands needs ~6 GB and Western Europe would need
# 130–270 GB. Nothing tunes out of that, and the answer is not a bigger machine: it is to never build a
# store that big. C4/C5 already specify 25–45 base blocks, so one region at a time IS the plan; chunking
# is how a region that is still too large becomes several that are not.
#
# It is also what makes the base map buildable in CI at all. NL needs ~11.7 GB of intermediates against a
# GitHub-hosted runner's ~14 GB, which is why `data-refresh.yml` runs `--no-base` today. In N chunks each
# needs ~11.7/N, and the chunks are INDEPENDENT — a matrix job, wall-clock ~28/N minutes.
#
# THE ONE SUBTLETY, which is what `trim_base.loft` is for: `osmium extract` keeps whole ways, so a feature
# straddling a chunk edge appears in BOTH neighbouring extracts and is binned by its first vertex to the
# same tile in both. Trimming each chunk to its own cell band leaves every feature in exactly one chunk.
# That is a property worth asserting rather than believing, so this prints the totals and
# `tools/base_chunk_gate.sh` compares them against a whole-region build.
#
#   tools/build-base-chunked.sh <region-id> <geofabrik-path> <W,S,E,N> <n-chunks>
#
# Each chunk is built as a WHOLE REGION — roads then base — because the base map's street labels come from
# the roads export for the same box. So a chunk yields `<id>-cNN.roads.store` and `<id>-cNN.base.store`,
# which is exactly the per-region pair C4/C5 describe.
#
# Chunks are cut on LONGITUDE only. Longitude is the axis both existing splits use (`split_base`,
# `split_block` at 5.40°E) and the one along which Europe's regions are conventionally cut; adding a
# latitude axis would double the seam count for no measured benefit.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
loft="${LOFT_BIN:-$(command -v loft || echo /usr/local/bin/loft)}"
out="${BLOCKS_OUT:-$here/blocks}"

id="${1:-}"; src="${2:-}"; bbox="${3:-}"; n="${4:-4}"
# CHUNKS ARE INDEPENDENT, so they can run at once — and until this existed they did not, which threw away
# the other half of chunking's value. Every loft generator here is SINGLE-THREADED (measured: NL's base
# build is `real 26m25s / user 26m10s`, i.e. 0.99 cores of the 24 on this box), so the parallelism has to
# come from running whole chunks side by side rather than from inside them.
#
# Bounded by MEMORY, not by cores: `build_store` peaks around 6 GB for a country-sized chunk, so 4 jobs
# want ~24 GB. Default 1 keeps the old behaviour for anyone who does not ask; CI runs one chunk per
# runner and wants 1 anyway.
jobs="${CHUNK_JOBS:-1}"
[ -n "$id" ] && [ -n "$src" ] && [ -n "$bbox" ] \
  || { echo "usage: build-base-chunked.sh <region-id> <geofabrik-path> <W,S,E,N> <n-chunks>"; exit 2; }

IFS=, read -r bw bs be bn <<<"$bbox"
# The chunk edges, and a MARGIN on the extract. The margin is not politeness: a feature whose first vertex
# sits just inside this band may extend past the edge, and `osmium extract` must see the whole way for the
# geometry to survive. 0.15° is comfortably over the ~0.09° overhang §7g measured, and costs only extract
# time — the trim removes whatever the margin dragged in.
MARGIN=0.15
edges=()
for ((i = 0; i <= n; i++)); do
  edges+=("$(python3 -c "print(f'{$bw + ($be - $bw) * $i / $n:.6f}')")")
done

echo "== base map for $id in $n chunk(s), $bw..$be, $jobs at a time =="

# ⚠ ACQUIRE ONCE, BEFORE ANY PARALLELISM. `build-blocks.sh` fetches the source extract itself, and four
# copies of it racing on the same `.part` sidecar is precisely the cache-destroying shape its own header
# warns about. So chunk 0 runs alone first — it downloads if needed — and the rest may then share the
# cached extract read-only.
pbf="${BLOCKS_WORK:-$HOME/.cache/routing-blocks}/$(basename "$src")-latest.osm.pbf"
if [ "$jobs" -gt 1 ] && [ ! -s "$pbf" ]; then
  echo "  (source extract not cached — chunk 0 runs alone first to fetch it)"
fi

one_chunk() {  # $1 = index
  local i="$1"
  local lo hi xlo xhi cid tlo thi raw
  lo="${edges[$i]}"; hi="${edges[$((i + 1))]}"
  # ⚠ THE MARGIN GOES ON INTERIOR SEAMS ONLY. Applied to the outer edges too — which is what this did
  # first — each end chunk extracts further out than the region itself, and its unbounded trim band then
  # KEEPS that overshoot. Measured on Enschede: 355 554 features against the whole-region build's
  # 209 932, i.e. the chunks were a strictly larger map, not a partition of the same one.
  #
  # The region's own bbox is the outer boundary. Inside it the union of the extracts must equal the
  # whole-region extract exactly; outside it, neither should reach.
  xlo="$(python3 -c "print(f'{max($lo - $MARGIN, $bw):.6f}')")"
  xhi="$(python3 -c "print(f'{min($hi + $MARGIN, $be):.6f}')")"
  [ "$i" = "0" ] && xlo="$bw"
  [ "$i" = "$((n - 1))" ] && xhi="$be"
  cid="$(printf '%s-c%02d' "$id" "$i")"
  echo
  echo "-- chunk $i/$n: band [$lo, $hi)  extract [$xlo, $xhi]"
  # The FIRST and LAST chunk are unbounded on their outer side, so nothing outside the region's own bbox
  # can fall through the cracks between "what the extract caught" and "what the band claims".
  tlo="$lo"; thi="$hi"
  [ "$i" = "0" ] && tlo=-999
  [ "$i" = "$((n - 1))" ] && thi=999
  # ROADS FIRST, for the same box. A chunk is a whole REGION, not a base map on its own: the base
  # build's street labels come from the roads export (`$id.geojsonseq`), and build-base.sh refuses to
  # run without one cut from the same bbox — correctly, since labels from another box would be a
  # different city's streets. This also produces the chunk's roads block, which is what C4/C5's
  # "roads blocks + base map per region" wants anyway.
  # A chunk is a slice, so build-blocks' 100-tile non-vacuity floor does not apply — but it is lowered,
  # not disabled: an EMPTY chunk is still a failure and 10 tiles still catches it.
  # ⚠ `return`, never `exit`. In the parallel branch this runs as a background subshell, where `exit`
  # ends only that subshell — the parent sails on and reports totals for stores that were never built.
  # And the log is KEPT rather than sent to /dev/null: a chunk that fails at 03:00 in a matrix job is
  # unfixable without it.
  local clog="${TMPDIR:-/tmp}/chunk-$cid.log"
  MIN_TILES="${CHUNK_MIN_TILES:-10}" \
  "$here/tools/build-blocks.sh" "$cid" "$src" "$xlo,$bs,$xhi,$bn" >"$clog" 2>&1 \
    || { echo "  FAIL: build-blocks for $cid — last lines of $clog:"; tail -4 "$clog" | sed 's/^/      /'; return 1; }
  "$here/tools/build-base.sh" "$cid" "$src" "$xlo,$bs,$xhi,$bn" >>"$clog" 2>&1 \
    || { echo "  FAIL: build-base for $cid — last lines of $clog:"; tail -4 "$clog" | sed 's/^/      /'; return 1; }
  raw="$out/$cid.base.store"
  [ -f "$raw" ] || { echo "  FAIL: $cid produced no store"; return 1; }
  "$loft" --native --lib "$here/lib" "$here/tools/trim_base.loft" \
    "$raw" "$out/$cid.trimmed.store" "$tlo" "$thi" 2>&1 | grep '^#T' | sed 's/^/  /' \
    || { echo "  FAIL: trim for $cid"; return 1; }
  mv -f "$out/$cid.trimmed.store" "$raw"
  rm -f "$out/$cid.trimmed.store.dschema"
  # No value on stdout: the caller already knows the path, and returning it here would force a redirect
  # that also swallowed the `#T` trim lines — which are the ones base_chunk_gate.sh reads.
}

built=()
running=0
# ⚠ EVERY CHUNK WRITES ITS EXIT STATUS TO A FILE, and the parent reads them all at the end.
#
# The obvious `wait || exit 1` does NOT work and silently passed a broken run: bare `wait` waits for all
# children and returns ZERO regardless of what they did (POSIX). So a chunk that failed was reported only
# by its own message scrolling past, and the script went on to sum extents of stores that did not exist.
# A status file per chunk is unambiguous and survives the subshell.
stat="$(mktemp -d)"
trap 'rm -rf "$stat"' EXIT
for ((i = 0; i < n; i++)); do
  cid="$(printf '%s-c%02d' "$id" "$i")"
  built+=("$out/$cid.base.store")
  if [ "$jobs" -le 1 ] || { [ "$i" = "0" ] && [ ! -s "$pbf" ]; }; then
    one_chunk "$i"; echo "$?" > "$stat/$i"     # serial, and the acquire happens here
  else
    ( one_chunk "$i"; echo "$?" > "$stat/$i" ) &
    running=$((running + 1))
    if [ "$running" -ge "$jobs" ]; then wait -n 2>/dev/null || true; running=$((running - 1)); fi
  fi
done
wait
bad=0
for ((i = 0; i < n; i++)); do
  [ "$(cat "$stat/$i" 2>/dev/null || echo 1)" = "0" ] || { echo "  chunk $i FAILED"; bad=1; }
done
[ "$bad" = "0" ] || { echo "FAIL — $n chunk(s) requested, at least one did not build"; exit 1; }

echo
echo "== totals =="
tot_t=0; tot_f=0
for b in "${built[@]}"; do
  e="$("$loft" --native --lib "$here/lib" "$here/tools/store_extent.loft" "$b" base 2>/dev/null | grep -oP '^EXTENT \K.*')"
  set -- $e
  printf "  %-34s tiles=%-8s features=%s\n" "$(basename "$b")" "$5" "$6"
  tot_t=$((tot_t + $5)); tot_f=$((tot_f + $6))
done
echo "  TOTAL tiles=$tot_t features=$tot_f"
echo
echo "Compare against a whole-region build to prove the chunking is lossless:"
echo "  tools/base_chunk_gate.sh $id"
