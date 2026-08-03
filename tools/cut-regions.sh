#!/usr/bin/env bash
# Copyright (c) 2026 Jurjen Stellingwerff
# SPDX-License-Identifier: LGPL-3.0-or-later
#
# CUT A COUNTRY INTO THE REGIONS THE MANIFEST NAMES — roads and base, by the two opposite rules
# (PLAN-SCALE §6f F3).
#
# WHY THIS EXISTS AS A SCRIPT. F3's cut was performed by hand on 2026-08-01 and again on 2026-08-02, and
# it was never written down anywhere a machine reads. `data/coverage.toml` has named FOUR regions since
# F3 while `data-refresh.yml` still merged the base into the TWO halves that preceded it and split the
# roads with `--split 5.40` — so the workflow could not run at all: `publish-release.sh` fails building
# the release index on blocks nobody produced, AFTER uploading gigabytes. A recipe that lives in one
# person's shell history is not a pipeline, and duplicating it into YAML is how the two drifted apart.
#
# THE TWO RULES ARE OPPOSITE, and getting them the wrong way round produces a dataset that publishes
# cleanly and is wrong:
#
#   roads   a PARTITION, no margin. The client stitches road blocks across a seam (S8), and a way
#           delivered twice is not a slower match but a DIFFERENT one — `block_overlap_gate.sh` is the
#           gate that says so. `split_block.loft` cuts by CELL, so no way is ever cut in half.
#   base    a COVER, every internal side widened by $BASE_MARGIN. A region's base map is hosted ALONE and a
#           viewer loads one of them, so each has to be a complete map of its own ground: a motorway
#           keyed just across the cut must appear in both. Without the margin, a z14 viewport centred on
#           a cut was answered with 54% of itself — measured, F3.
#
# So the two stores of one region deliberately do NOT describe the same ground.
#
#   tools/cut-regions.sh <country-id>
#     BASE_MARGIN=0.10   degrees added to every internal side of a base band (see above)
#     SKIP_BASE=1        cut the roads only — what a CI runner does, where the base arrives as chunks
#
# The cut bounds are per-region keys in `data/coverage.toml` (`cut_lon_min` / `cut_lon_max`, absent =
# unbounded), because that manifest is already the single place a region enters coverage. The MARGIN is
# not there: it is one policy shared by every region, not a fact about any one of them.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
loft="${LOFT_BIN:-$(command -v loft || echo /usr/local/bin/loft)}"
out="${BLOCKS_OUT:-$here/blocks}"
manifest="${COVERAGE_MANIFEST:-$here/data/coverage.toml}"
margin="${BASE_MARGIN:-0.10}"

id="${1:-}"
[ -n "$id" ] || { sed -n '/^#   tools\/cut-regions.sh/,/^#     SKIP_BASE/p' "$0" | sed 's/^# \?//'; exit 2; }

die() { echo "FAIL: $*" >&2; exit 1; }
step() { echo; echo "########## $* ##########"; }

# --- what the manifest asks for ------------------------------------------------------------------
# Read the same way `tools/build_index.sh` reads it: line by line, no TOML parser. ⚠ The same
# glob-ordering trap applies — `cut_lon_min*=*` and `cut_lon_max*=*` share no prefix with each other or
# with any key that file already matches, but anything added here must be checked against both lists.
ids=(); los=(); his=()
rid=""; rlo=""; rhi=""
flush_region() {
  [ -n "$rid" ] || return 0
  # Only regions that DECLARE a band are cut. `nl-overview` and `nl-mid` are derived blocks built from
  # the regions by `build_overview.loft`, not slices of the country, and they carry no bounds.
  if [ -n "$rlo" ] || [ -n "$rhi" ]; then
    ids+=("$rid"); los+=("${rlo:--999}"); his+=("${rhi:--999}")
  fi
  rid=""; rlo=""; rhi=""
}
while IFS= read -r line; do
  case "$line" in
    '[[region]]'*)   flush_region ;;
    cut_lon_min*=*)  rlo="$(echo "$line" | tr -d ' "' | cut -d= -f2)" ;;
    cut_lon_max*=*)  rhi="$(echo "$line" | tr -d ' "' | cut -d= -f2)" ;;
    id*=*)           rid="$(echo "$line" | cut -d'"' -f2)" ;;
  esac
done < <(grep -v '^\s*#' "$manifest")
flush_region

n=${#ids[@]}
[ "$n" -ge 2 ] || die "$manifest declares $n region(s) with cut bounds — nothing to cut"

# The base band is the roads band widened by the margin on its INTERNAL sides only. An unbounded side
# (-999) stays unbounded: there is no neighbour out there to carry an edge of.
widen() { awk -v v="$1" -v m="$2" 'BEGIN{ if (v == -999) print "-999"; else printf "%.4f", v + m }'; }

echo "== $n regions from $(basename "$manifest") =="
for i in $(seq 0 $((n - 1))); do
  printf '   %-12s roads [%s, %s)   base [%s, %s)\n' "${ids[$i]}" "${los[$i]}" "${his[$i]}" \
    "$(widen "${los[$i]}" "-$margin")" "$(widen "${his[$i]}" "$margin")"
done

# ⚠ The bands must be CONTIGUOUS and in order, or the "partition" claim is a wish. A gap between two
# regions is ground the roads store simply loses; an overlap is the duplicate-way defect the gate exists
# to catch. Both are silent at publish time, so they are checked here, where the numbers are known.
for i in $(seq 1 $((n - 1))); do
  prev_hi="${his[$((i - 1))]}"; cur_lo="${los[$i]}"
  [ "$prev_hi" = "$cur_lo" ] || die "regions ${ids[$((i-1))]} and ${ids[$i]} do not meet: $prev_hi vs $cur_lo"
done
[ "${los[0]}" = "-999" ] || die "the first region ${ids[0]} declares a lower bound — the west end must be unbounded"
[ "${his[$((n - 1))]}" = "-999" ] || die "the last region ${ids[$((n-1))]} declares an upper bound — the east end must be unbounded"

ways_in() {   # count roads.ways in a block — the same arithmetic `conservation_gate.sh` uses
  "$loft" --native --lib "$here/lib" "$here/tools/census.loft" roads "$1" 2>/dev/null \
    | grep -oP '^count roads.ways \K[0-9]+'
}

# ⚠ THESE TOOLS REPORT FAILURE ON STDOUT AND EXIT ZERO. `split_block`, `trim_base` and `merge_base` each
# print `FAIL:` or `#PERSIST FAIL` and then `return` from main — which is a normal exit — so a caller
# written as `tool … || die` is blind to every failure they have. That is not hypothetical: the
# `#PERSIST FAIL` guard exists precisely because a re-run over an existing file kept the OLD image and
# reported success, and a `||` caller would sail straight past the guard that catches it.
#
# So run them through here: non-zero exit OR a FAIL line is a failure, and only the lines worth reading
# reach the log (loft prints pages of compile advice to stderr on every --native invocation).
run_tool() {
  local what="$1" keep="$2"; shift 2
  local log; log="$(mktemp)"
  "$@" >"$log" 2>&1
  local rc=$?
  if [ "$rc" != 0 ] || grep -q 'FAIL' "$log"; then
    grep -E 'FAIL|error' "$log" | head -5 | sed 's/^/     /'
    rm -f "$log"; die "$what"
  fi
  grep -E "$keep" "$log" | sed 's/^/     /'
  rm -f "$log"
}

hsize() { numfmt --to=iec "$(stat -Lc%s "$1")"; }   # -L: the blocks may be symlinks into a staging dir

# --- roads: a plain partition --------------------------------------------------------------------
if [ "${SKIP_ROADS:-0}" = "1" ]; then
step "roads — SKIPPED (SKIP_ROADS=1)"
echo "  the base is cut below; the roads were produced by an earlier job."
else
step "roads — $n regions, cut by cell, no margin"
src="$out/$id.roads.store"
[ -f "$src" ] || die "no country roads block at $src (run tools/build-blocks.sh first)"
whole="$(ways_in "$src")"
[ -n "$whole" ] || die "census read no ways from $src"
echo "  country: $whole ways"

# `split_block.loft` is a TWO-way cut, so N regions are N-1 cuts applied left to right: each one peels
# the westernmost region off and leaves the rest as a temporary for the next. The temporaries are named
# and removed here rather than left in `blocks/`, where an index could be pointed at one.
rest="$src"; tmpn=0; produced=()
for i in $(seq 0 $((n - 2))); do
  cut="${his[$i]}"
  west="$out/${ids[$i]}.roads.store"
  if [ "$i" = "$((n - 2))" ]; then east="$out/${ids[$((n - 1))]}.roads.store"; else east="$out/$id.cut$tmpn.roads.store"; fi
  rm -f "$west" "$west.dschema" "$east" "$east.dschema"
  run_tool "split_block at $cut" '^split at' \
    "$loft" --native --lib "$here/lib" "$here/tools/split_block.loft" "$rest" "$west" "$east" "$cut"
  [ -f "$west" ] && [ -f "$east" ] || die "the split at $cut produced no blocks"
  produced+=("$west")
  [ "$rest" = "$src" ] || rm -f "$rest" "$rest.dschema"
  rest="$east"; tmpn=$((tmpn + 1))
done
produced+=("$out/${ids[$((n - 1))]}.roads.store")

# COMPACTION — the step that was only ever a sentence in HANDOFF, and it halves the file.
#
# loft 2026.8.0 (#730) sheds the slack a store's vectors grew to when the store is BOUND, so a block
# shrinks by being opened and re-persisted: nl-east 166.0 -> 84.2 MB, content identical. A freshly cut
# block has never been bound, so it is the raw size — which is what the four blocks came out at until
# this pass existed, and twice what the published ones cost.
#
# `store_compact_probe.loft` is the compaction: it binds the store in place. There is no read-only form
# of it (binding IS the rewrite), and giving the same code a second name would just be two things to keep
# in step. What makes it safe to use as a pipeline step rather than a probe is the check below — the ways
# are counted again AFTER, so a compaction that ever lost a record fails here instead of shipping.
sum=0
for b in "${produced[@]}"; do
  raw="$(stat -c%s "$b")"
  run_tool "compact $(basename "$b")" '^#C bytes' \
    "$loft" --native --lib "$here/lib" "$here/tools/store_compact_probe.loft" "$b"
  c="$(ways_in "$b")"; [ -n "$c" ] || die "census read no ways from $b after compaction"
  printf '  %-28s %10s ways  %s -> %s\n' "$(basename "$b")" "$c" \
    "$(numfmt --to=iec "$raw")" "$(numfmt --to=iec "$(stat -c%s "$b")")"
  sum=$((sum + c))
done

# CONSERVATION over the whole cut. A cut that loses a tile produces N blocks that each look fine and a
# country with a hole in it, and this is the last moment the whole and the parts both exist.
echo "  conservation: $sum against $whole whole"
[ "$sum" = "$whole" ] || die "the cut lost $((whole - sum)) ways — do not publish this"
fi

# --- base: a cover, with the margin ----------------------------------------------------------------
if [ "${SKIP_BASE:-0}" = "1" ]; then
  step "base — SKIPPED (SKIP_BASE=1)"
  echo "  the roads are cut; the base arrives as chunks and is assembled by the caller."
  exit 0
fi

step "base — $n regions, cover, ${margin}° margin on every internal side"

# TWO SOURCES, one recipe. A workstation holds the whole country base; a CI runner never does — it builds
# bands on separate runners (§6e) — so the chunks are the input there. `cover` is a per-tile predicate on
# a tile's own sealed extent, and every tile lives in exactly ONE chunk (the chunks are a partition, which
# `base_chunk_gate.sh` counts), so trimming each chunk to a band and merging gives the same tile set as
# trimming the assembled country. Filter-then-merge and merge-then-filter agree over a partition; what
# they do NOT agree on is memory, and only one of them fits a runner.
country="$out/$id.base.store"
chunks=()
for c in "$out/$id"-c[0-9][0-9].base.store; do [ -f "$c" ] && chunks+=("$c"); done
if [ -f "$country" ]; then
  echo "  source: the country block $(basename "$country") ($(hsize "$country"))"
elif [ "${#chunks[@]}" -gt 0 ]; then
  echo "  source: ${#chunks[@]} chunks"
else
  die "no base block at $country and no $id-cNN.base.store chunks — nothing to cut"
fi

for i in $(seq 0 $((n - 1))); do
  rid="${ids[$i]}"
  blo="$(widen "${los[$i]}" "-$margin")"
  bhi="$(widen "${his[$i]}" "$margin")"
  dst="$out/$rid.base.store"
  rm -f "$dst" "$dst.dschema"
  echo "  -- $rid  [$blo, $bhi)"
  if [ -f "$country" ]; then
    run_tool "trim_base for $rid" '^#T' \
      "$loft" --native --lib "$here/lib" "$here/tools/trim_base.loft" "$country" "$dst" "$blo" "$bhi" cover
  else
    # One trimmed piece per chunk, then merged. `merge_base.loft` REFUSES overlapping inputs, so if a
    # chunk boundary ever stopped being a partition this fails loudly instead of doubling a tile.
    pieces=()
    for c in "${chunks[@]}"; do
      p="$out/$rid.$(basename "$c" .base.store).piece.store"
      rm -f "$p" "$p.dschema"
      run_tool "trim_base $(basename "$c") for $rid" '^#T' \
        "$loft" --native --lib "$here/lib" "$here/tools/trim_base.loft" "$c" "$p" "$blo" "$bhi" cover
      # A chunk that contributes NOTHING to this band is normal and is reported rather than assumed:
      # coarse tiles are 256 km across, so which chunks reach a band is a property of the data.
      if [ -f "$p" ]; then pieces+=("$p"); else echo "     $(basename "$c" .base.store): no tiles in this band"; fi
    done
    [ "${#pieces[@]}" -gt 0 ] || die "$rid got no tiles from any chunk"
    if [ "${#pieces[@]}" = 1 ]; then
      mv -f "${pieces[0]}" "$dst"; mv -f "${pieces[0]}.dschema" "$dst.dschema" 2>/dev/null || true
    else
      run_tool "merge_base for $rid" '^#M' \
        "$loft" --native --lib "$here/lib" "$here/tools/merge_base.loft" "$dst" "${pieces[@]}"
      rm -f "${pieces[@]}"; for p in "${pieces[@]}"; do rm -f "$p.dschema"; done
    fi
  fi
  [ -f "$dst" ] || die "$rid produced no base block"
  printf '     %-28s %s\n' "$(basename "$dst")" "$(hsize "$dst")"
done

step "done"
echo "  Cut into $n regions. NOT published — see tools/refresh-region.sh step 6."
echo "  The disjointness of the ROADS blocks is a gate, not a comment: tools/block_overlap_gate.sh"
