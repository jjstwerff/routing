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
#   tools/build-derived.sh [country-id]
#
# Which blocks, from which regions, and with which parameters all come from `data/coverage.toml`: a
# derived block is one that declares `build_zmax`. Adding another derived block is a manifest edit.
#
# WHICH REGIONS FEED WHICH BLOCK — `derive_from`, and why it had to exist before a second country could.
# Until 2026-08-03 every derived block was built from EVERY region with a roads store, which is right
# while the dataset is one country and wrong the moment it is two: the middle-zoom blocks are read PAGED
# and accumulate across a covering set, so they want to stay per-country (a viewport fetches only the
# cells it needs, and adding Belgium must not rebuild the Netherlands' 305 MB block). The OVERVIEW is the
# opposite — it is read `whole`, more than one whole store in a covering set forces the kernel to page
# them (`client/web_basemap_kernel.loft`), and the resident floor is a single block by construction — so
# it must span the whole coverage. One flag expresses both:
#
#   derive_from absent      every source region — what the overview wants
#   derive_from = "belgium" the regions of that country only
#
# A source region MATCHES `derive_from` when its own `id` equals it OR its `cut_from` does. That second
# half is what makes this survive: Belgium is one block today and becomes `be-west`/`be-east` at @51
# phase C, and those will carry `cut_from = "belgium"`, so `be-mid` keeps working untouched.
#
# THE ARGUMENT IS A FILTER, and it used to be ignored entirely. `build-derived.sh belgium` rebuilds the
# derived blocks a refresh of Belgium can have INVALIDATED — which is `be-mid` and also the overview,
# because the overview reads Belgium's regions too. Passing nothing builds them all.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
loft="${LOFT_BIN:-$(command -v loft || echo /usr/local/bin/loft)}"
out="${BLOCKS_OUT:-$here/blocks}"
manifest="${COVERAGE_MANIFEST:-$here/data/coverage.toml}"
only="${1:-}"          # a country id, or empty for every derived block

die() { echo "FAIL: $*" >&2; exit 1; }

# --- what the manifest asks for -------------------------------------------------------------------
# Same line-by-line read as `build_index.sh` and `cut-regions.sh`. ⚠ The glob-ordering trap applies:
# `build_zmax` and `build_min_tier` share no prefix with each other, but anything added here has to be
# checked against every key those two files already match.
sources=(); sgroup=(); dids=(); dzmax=(); dtier=(); dfrom=()
rid=""; rroads=""; rbase=""; rzmax=""; rtier=""; rcut=""; rderive=""
flush_region() {
  [ -n "$rid" ] || return 0
  # A region is an INPUT when it has roads (the spine comes from there and the base beside it); a block
  # is an OUTPUT when it declares how to build it. Nothing is both.
  if [ -n "$rzmax" ]; then
    dids+=("$rid"); dzmax+=("$rzmax"); dtier+=("${rtier:-0}"); dfrom+=("$rderive")
  elif [ -n "$rroads" ]; then
    # A region with no `cut_from` is its own group — it IS the country, the shape Belgium has before
    # @51 phase C cuts it. That is what lets `derive_from` name a country either way.
    sources+=("$rid"); sgroup+=("${rcut:-$rid}")
  fi
  rid=""; rroads=""; rbase=""; rzmax=""; rtier=""; rcut=""; rderive=""
}
while IFS= read -r line; do
  # ⚠ THE GLOB-ORDERING TRAP. These are globs and the FIRST match wins, so a key added here has to be
  # checked against every pattern already listed — `build_index.sh` lost a whole `names` field to
  # exactly this. `cut_from` and `derive_from` share a prefix with nothing below, and `cut_from` must
  # not be written as `cut*` or it would swallow `cut_lon_min`/`cut_lon_max`.
  case "$line" in
    '[[region]]'*)      flush_region ;;
    build_zmax*=*)      rzmax="$(echo "$line" | tr -d ' "' | cut -d= -f2)" ;;
    build_min_tier*=*)  rtier="$(echo "$line" | tr -d ' "' | cut -d= -f2)" ;;
    derive_from*=*)     rderive="$(echo "$line" | cut -d'"' -f2)" ;;
    cut_from*=*)        rcut="$(echo "$line" | cut -d'"' -f2)" ;;
    roads*=*)           rroads="$(echo "$line" | cut -d'"' -f2)" ;;
    id*=*)              rid="$(echo "$line" | cut -d'"' -f2)" ;;
  esac
done < <(grep -v '^\s*#' "$manifest")
flush_region

[ "${#sources[@]}" -gt 0 ] || die "$manifest names no region with a roads store — nothing to derive from"
[ "${#dids[@]}" -gt 0 ]    || die "$manifest declares no block with build_zmax — nothing to build"

# The regions feeding ONE derived block, as the comma-separated pair `build_overview.loft` takes. It
# reads a SET because no stage of the pipeline holds a country-wide base and a country-wide roads store
# at once — it holds the regions.
sel_ids=""; sel_bases=""; sel_roads=""; sel_groups=""
select_sources() {          # $1 = derive_from ("" = all)
  sel_ids=""; sel_bases=""; sel_roads=""; sel_groups=""
  for j in "${!sources[@]}"; do
    keep=0
    if [ -z "$1" ]; then keep=1; else
      IFS=',' read -ra want <<<"$1"
      for w in "${want[@]}"; do
        w="${w// /}"
        [ "$w" = "${sources[$j]}" ] || [ "$w" = "${sgroup[$j]}" ] && { keep=1; break; }
      done
    fi
    [ "$keep" = 1 ] || continue
    b="$out/${sources[$j]}.base.store"; r="$out/${sources[$j]}.roads.store"
    [ -f "$b" ] || die "no base block for ${sources[$j]} at $b — run tools/cut-regions.sh first"
    [ -f "$r" ] || die "no roads block for ${sources[$j]} at $r — run tools/cut-regions.sh first"
    sel_ids="${sel_ids:+$sel_ids }${sources[$j]}"
    sel_bases="${sel_bases:+$sel_bases,}$b"; sel_roads="${sel_roads:+$sel_roads,}$r"
    # The COUNTRIES this block ends up reading, which is what the CLI filter is asked about. Both the
    # region id and its group count, so `build-derived.sh nl-east` works as well as `… netherlands`.
    case " $sel_groups " in *" ${sgroup[$j]} "*) ;; *) sel_groups="${sel_groups:+$sel_groups }${sgroup[$j]}" ;; esac
    case " $sel_groups " in *" ${sources[$j]} "*) ;; *) sel_groups="$sel_groups ${sources[$j]}" ;; esac
  done
}

echo "== deriving from ${#sources[@]} source region(s): ${sources[*]} =="
[ -n "$only" ] && echo "   limited to blocks a refresh of '$only' can have invalidated"

built=0
for i in $(seq 0 $((${#dids[@]} - 1))); do
  d="${dids[$i]}"; dst="$out/$d.base.store"
  select_sources "${dfrom[$i]}"
  # A `derive_from` that matches nothing is a TYPO, and the silent failure it would otherwise cause is
  # the worst one available here: a block built from no regions persists as an empty map that publishes
  # looking finished. Same family as the paged spot check that passed while fetching nothing.
  [ -n "$sel_ids" ] || die "$d: derive_from='${dfrom[$i]}' matches no region with a roads store"
  # The filter: skip a block only when the refreshed country is not among the regions it reads. The
  # overview reads every region, so it is never skipped — which is correct, and is the case that would
  # have been got wrong by filtering on `derive_from` alone.
  # An EXACT set test, not a substring or `grep -w` one: `-w` treats `-` as a non-word character, so
  # searching for "west" would have matched `nl-west` and a country named after any region suffix would
  # have selected blocks it has nothing to do with.
  if [ -n "$only" ]; then
    case " $sel_groups " in
      *" $only "*) ;;
      *) echo; echo "########## $d — SKIPPED, reads no region of '$only' (sources: $sel_ids) ##########"
         continue ;;
    esac
  fi
  built=$((built + 1))
  echo
  echo "########## $d — zmax ${dzmax[$i]}, min tier ${dtier[$i]}, from: $sel_ids ##########"
  # Print the plan and build nothing. The scoping above is the kind of thing that is only ever exercised
  # by a full build, which is an hour of CPU — so it gets a way to be checked in a second.
  [ "${DRY_RUN:-0}" = 1 ] && { echo "  DRY_RUN — would build $dst"; continue; }
  # ⚠ DELETE FIRST. `store_persist_bind` over an existing file ADOPTS the old image, writes none of the
  # new contents and returns TRUE, so a rebuild without this is exactly the stale-but-fresh-looking
  # artifact this script exists to prevent. build_overview refuses an existing target for the same
  # reason; the `rm` is what makes a re-run work rather than fail.
  rm -f "$dst" "$dst.dschema"
  log="$(mktemp)"
  # ⚠ It reports failure on STDOUT and exits ZERO — like every store tool here (see cut-regions.sh).
  "$loft" --native --lib "$here/lib" "$here/tools/build_overview.loft" \
    "$sel_bases" "$sel_roads" "$dst" "${dzmax[$i]}" "${dtier[$i]}" >"$log" 2>&1
  rc=$?
  if [ "$rc" != 0 ] || grep -q 'FAIL' "$log"; then
    grep -E 'FAIL|error' "$log" | head -5 | sed 's/^/  /'; rm -f "$log"; die "build_overview for $d"
  fi
  grep '^#O' "$log" | sed 's/^/  /'; rm -f "$log"
  [ -f "$dst" ] || die "$d produced no block"
  printf '  %-28s %s\n' "$(basename "$dst")" "$(numfmt --to=iec "$(stat -Lc%s "$dst")")"
done

echo
# A filter that matched nothing is almost certainly a mistyped country, and it looks exactly like a
# successful run — the one outcome this script exists to prevent.
[ "$built" -gt 0 ] || die "no derived block reads any region of '$only' — is that a country in $manifest?"
echo "  Derived $built of ${#dids[@]} block(s). NOT published — see tools/refresh-region.sh step 6."
echo "  ⚠ Not compacted: a derived block is written fresh and has never been bound, so it carries the"
echo "    slack loft#730 sheds at bind (the region blocks lose ~half). Shrinking these changes published"
echo "    bytes, which is a decision of its own — tools/store_compact_probe.loft does it in place."
