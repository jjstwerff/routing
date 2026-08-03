#!/usr/bin/env bash
# Copyright (c) 2026 Jurjen Stellingwerff
# SPDX-License-Identifier: LGPL-3.0-or-later
#
# BUILD THE DERIVED BLOCKS — the country overview and the middle zooms — from the regions (PLAN-SCALE
# §6i O1 / O3b).
#
# WHY IT IS A STEP AND NOT A FOOTNOTE. These two blocks are the map every zoom below 14 draws, and they
# are a FUNCTION of the regions. A refresh that rebuilds the regions and not these leaves the country
# view describing the previous snapshot while the routes underneath describe the new one — and nothing
# reports it: `publish-release.sh` uploads whatever `blocks/` holds that the manifest names, so a stale
# file is re-published looking current. That is the silent direction, which is the only reason this
# exists as its own script instead of two lines in a workflow.
#
# It also closes the gap that made this concrete: `data-refresh.yml` rebuilt `nl-overview` and never
# built `nl-mid` at all, so a run would have published fresh regions, a fresh overview, and middle zooms
# from whenever anyone last did it by hand.
#
#   tools/build-derived.sh <country-id>
#
# Which blocks, from which regions, and with which parameters all come from `data/coverage.toml`: a
# derived block is one that declares `build_zmax`, and its inputs are every region that names a `roads`
# store. Adding a third derived block is a manifest edit.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
loft="${LOFT_BIN:-$(command -v loft || echo /usr/local/bin/loft)}"
out="${BLOCKS_OUT:-$here/blocks}"
manifest="${COVERAGE_MANIFEST:-$here/data/coverage.toml}"

die() { echo "FAIL: $*" >&2; exit 1; }

# --- what the manifest asks for -------------------------------------------------------------------
# Same line-by-line read as `build_index.sh` and `cut-regions.sh`. ⚠ The glob-ordering trap applies:
# `build_zmax` and `build_min_tier` share no prefix with each other, but anything added here has to be
# checked against every key those two files already match.
sources=(); dids=(); dzmax=(); dtier=()
rid=""; rroads=""; rbase=""; rzmax=""; rtier=""
flush_region() {
  [ -n "$rid" ] || return 0
  # A region is an INPUT when it has roads (the spine comes from there and the base beside it); a block
  # is an OUTPUT when it declares how to build it. Nothing is both.
  if [ -n "$rzmax" ]; then
    dids+=("$rid"); dzmax+=("$rzmax"); dtier+=("${rtier:-0}")
  elif [ -n "$rroads" ]; then
    sources+=("$rid")
  fi
  rid=""; rroads=""; rbase=""; rzmax=""; rtier=""
}
while IFS= read -r line; do
  case "$line" in
    '[[region]]'*)      flush_region ;;
    build_zmax*=*)      rzmax="$(echo "$line" | tr -d ' "' | cut -d= -f2)" ;;
    build_min_tier*=*)  rtier="$(echo "$line" | tr -d ' "' | cut -d= -f2)" ;;
    roads*=*)           rroads="$(echo "$line" | cut -d'"' -f2)" ;;
    id*=*)              rid="$(echo "$line" | cut -d'"' -f2)" ;;
  esac
done < <(grep -v '^\s*#' "$manifest")
flush_region

[ "${#sources[@]}" -gt 0 ] || die "$manifest names no region with a roads store — nothing to derive from"
[ "${#dids[@]}" -gt 0 ]    || die "$manifest declares no block with build_zmax — nothing to build"

# The two comma-separated sets `build_overview.loft` takes. It reads a SET because no stage of the
# pipeline holds a country-wide base and a country-wide roads store at once — it holds the regions.
bases=""; roads=""
for s in "${sources[@]}"; do
  b="$out/$s.base.store"; r="$out/$s.roads.store"
  [ -f "$b" ] || die "no base block for $s at $b — run tools/cut-regions.sh first"
  [ -f "$r" ] || die "no roads block for $s at $r — run tools/cut-regions.sh first"
  bases="${bases:+$bases,}$b"; roads="${roads:+$roads,}$r"
done
echo "== deriving ${#dids[@]} block(s) from ${#sources[@]} regions: ${sources[*]} =="

for i in $(seq 0 $((${#dids[@]} - 1))); do
  d="${dids[$i]}"; dst="$out/$d.base.store"
  echo
  echo "########## $d — zmax ${dzmax[$i]}, min tier ${dtier[$i]} ##########"
  # ⚠ DELETE FIRST. `store_persist_bind` over an existing file ADOPTS the old image, writes none of the
  # new contents and returns TRUE, so a rebuild without this is exactly the stale-but-fresh-looking
  # artifact this script exists to prevent. build_overview refuses an existing target for the same
  # reason; the `rm` is what makes a re-run work rather than fail.
  rm -f "$dst" "$dst.dschema"
  log="$(mktemp)"
  # ⚠ It reports failure on STDOUT and exits ZERO — like every store tool here (see cut-regions.sh).
  "$loft" --native --lib "$here/lib" "$here/tools/build_overview.loft" \
    "$bases" "$roads" "$dst" "${dzmax[$i]}" "${dtier[$i]}" >"$log" 2>&1
  rc=$?
  if [ "$rc" != 0 ] || grep -q 'FAIL' "$log"; then
    grep -E 'FAIL|error' "$log" | head -5 | sed 's/^/  /'; rm -f "$log"; die "build_overview for $d"
  fi
  grep '^#O' "$log" | sed 's/^/  /'; rm -f "$log"
  [ -f "$dst" ] || die "$d produced no block"
  printf '  %-28s %s\n' "$(basename "$dst")" "$(numfmt --to=iec "$(stat -Lc%s "$dst")")"
done

echo
echo "  Derived. NOT published — see tools/refresh-region.sh step 6."
echo "  ⚠ Not compacted: a derived block is written fresh and has never been bound, so it carries the"
echo "    slack loft#730 sheds at bind (the region blocks lose ~half). Shrinking these changes published"
echo "    bytes, which is a decision of its own — tools/store_compact_probe.loft does it in place."
