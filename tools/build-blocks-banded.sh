#!/usr/bin/env bash
# Copyright (c) 2026 Jurjen Stellingwerff
# SPDX-License-Identifier: LGPL-3.0-or-later
#
# BUILD A ROADS BLOCK IN LONGITUDE BANDS, so memory tracks the BAND and not the country.
#
# `gen-tiles` accumulates its whole `hash<TTile[tkey]>` before persisting — ~350 bytes/feature, so a
# country is GBs of RSS and a continent is 130–270 (PLAN-SCALE §6e). That is not a property of tiling: a
# tile is a bounded unit and should be writable once and forgotten. It is a property of loft's store,
# which keeps its image resident until persist and cannot release a finished record.
#
# ⚠ MEASURED, because the obvious fixes do not work. Binning 400 000 features into 40 000 tiles:
#
#     scattered keys, bind LAST   59 MB RSS      ordered keys, bind LAST    59 MB
#     scattered keys, bind FIRST 266 MB RSS      ordered keys, bind FIRST  266 MB
#
# Binding the store first is 4.5x WORSE, and feeding the input in key order changes nothing — there is no
# way to say "this tile is done". Filed as loft-lang/loft#747. Until that lands, the only thing that
# bounds memory is building less at a time, which is what this does.
#
# `tools/build-base-chunked.sh` already does exactly this for the base map; roads had no equivalent, which
# is why `gen-tiles` still holds a country. Same subtlety, same fix: `osmium extract` keeps whole ways, so
# a way whose first vertex sits just inside a band can extend past its edge and lands in BOTH neighbouring
# extracts. Trimming each band to its own CELLS leaves every way in exactly one — the rule the tiling
# already rests on (a feature is keyed at its first vertex).
#
#   tools/build-blocks-banded.sh <region-id> <geofabrik-path> <W,S,E,N> <edges|n>
#     edges   comma-separated longitudes INCLUDING both outer bounds: 2.38,4.00,5.40,7.32
#     n       a count — the band edges are then even in WIDTH, which is rarely even in COST;
#             `tools/tiling_probe.py` prints even-COST cuts and those are the ones worth passing
#     LOCAL_SOURCE=1   the extract is one we made (a merge), so do not check it against upstream
#
# Output: `<id>-b<k>.roads.store` per band, disjoint by cell. They are the REGIONS — there is no
# reassembly step and deliberately so: a country-wide block is the thing we cannot afford to hold.
set -euo pipefail   # -u: an unset variable is an error, not an empty string that globs to `*`
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
loft="${LOFT_BIN:-$(command -v loft || echo /usr/local/bin/loft)}"
out="${BLOCKS_OUT:-$here/blocks}"

id="${1:-}"; src="${2:-}"; bbox="${3:-}"; spec="${4:-}"
[ -n "$spec" ] || { sed -n '/^#   tools\/build-blocks-banded.sh/,/^# Output:/p' "$0" | sed 's/^# \?//'; exit 2; }
IFS=, read -r bw bs be bn <<<"$bbox"
die() { echo "FAIL: $*" >&2; exit 1; }

edges=()
if [[ "$spec" == *,* ]]; then
  IFS=, read -r -a edges <<<"$spec"
  # The outer edges ARE the region. A mismatch silently builds a different map than the bbox claims —
  # the same trap build-base-chunked.sh guards, and for the same reason.
  [ "${edges[0]}" = "$bw" ] && [ "${edges[$(( ${#edges[@]} - 1 ))]}" = "$be" ] \
    || die "edges must start at $bw and end at $be (got ${edges[0]}..${edges[$(( ${#edges[@]} - 1 ))]})"
else
  n="$spec"
  for ((k = 0; k <= n; k++)); do
    edges+=("$(awk -v a="$bw" -v b="$be" -v k="$k" -v n="$n" 'BEGIN{ printf "%.4f", a + (b - a) * k / n }')")
  done
  echo "  ⚠ $n EVEN-WIDTH bands. Even width is rarely even cost — tools/tiling_probe.py prints the"
  echo "    even-COST cuts, and passing those keeps one band from becoming the whole build."
fi
nb=$(( ${#edges[@]} - 1 ))

# The margin is not politeness: a way whose first vertex is just inside this band may reach past the edge,
# and osmium must see the WHOLE way or the geometry is cut. It is trimmed back off by cell afterwards.
margin="${BAND_MARGIN:-0.15}"
echo "== $id in $nb band(s): ${edges[*]} =="

total=0
for ((k = 0; k < nb; k++)); do
  lo="${edges[$k]}"; hi="${edges[$((k + 1))]}"
  # ⚠ THE OUTER EDGES ARE NOT SEAMS. A margin and a trim belong at an INTERNAL edge, where a way must be
  # seen whole and then assigned to exactly one side. At the region's own bounds there is no other side:
  # trimming there drops the cell that CONTAINS the bound, and extracting past there adds ground the
  # region does not claim. Measured before this guard existed: 3 bands summed to 1 480 754 ways over
  # 10 372 cells against the whole-country block's 1 480 755 over 10 374 — two cells and one way, all at
  # the eastern bound, where "keep west of hi" ate the cell holding hi itself.
  first=0; last=0
  [ "$k" = 0 ] && first=1
  [ "$k" = "$((nb - 1))" ] && last=1
  xlo="$lo"; xhi="$hi"
  [ "$first" = 1 ] || xlo="$(awk -v v="$lo" -v m="$margin" 'BEGIN{ printf "%.4f", v - m }')"
  [ "$last"  = 1 ] || xhi="$(awk -v v="$hi" -v m="$margin" 'BEGIN{ printf "%.4f", v + m }')"
  bid="$id-b$k"
  echo
  echo "-- band $k  [$lo, $hi)   extract $xlo..$xhi"
  LOCAL_SOURCE="${LOCAL_SOURCE:-0}" MIN_TILES="${BAND_MIN_TILES:-10}" \
    "$here/tools/build-blocks.sh" "$bid" "$src" "$xlo,$bs,$xhi,$bn" >"/tmp/band-$bid.log" 2>&1 \
    || { tail -4 "/tmp/band-$bid.log"; die "band $k build"; }
  raw="$out/$bid.roads.store"
  [ -f "$raw" ] || die "band $k produced no block"

  # Trim the overhang to THIS band's cells: split at lo and keep the east, then at hi and keep the west.
  # Cutting by cell is what makes the bands disjoint — the same guarantee cut-regions.sh relies on.
  keep="$raw"
  if [ "$first" = 0 ]; then                          # internal WEST seam: drop what belongs to band k-1
    t1w="$out/$bid.t1w.store"; t1e="$out/$bid.t1e.store"
    rm -f "$t1w" "$t1w.dschema" "$t1e" "$t1e.dschema"
    "$loft" --native --lib "$here/lib" "$here/tools/split_block.loft" "$keep" "$t1w" "$t1e" "$lo" >/dev/null 2>&1 || true
    [ -f "$t1e" ] && keep="$t1e"
  fi
  final="$keep"
  if [ "$last" = 0 ]; then                           # internal EAST seam: drop what belongs to band k+1
    t2w="$out/$bid.t2w.store"; t2e="$out/$bid.t2e.store"
    rm -f "$t2w" "$t2w.dschema" "$t2e" "$t2e.dschema"
    "$loft" --native --lib "$here/lib" "$here/tools/split_block.loft" "$keep" "$t2w" "$t2e" "$hi" >/dev/null 2>&1 || true
    [ -f "$t2w" ] && final="$t2w"
  fi

  if [ "$final" != "$raw" ]; then
    rm -f "$raw" "$raw.dschema"
    mv -f "$final" "$raw"; mv -f "$final.dschema" "$raw.dschema" 2>/dev/null || true
  fi
  # ⚠ NEVER `rm -f "$var"*` — an UNSET var makes that `rm -f *`, and this script runs in the repo root.
  # It deleted 37 tracked files there before this line was written: after the outer-edge fix, t1w/t1e are
  # only assigned inside the internal-seam branch, so band 0 left them unset and the glob became bare `*`.
  # Recovered because all 37 were tracked and `rm -f` without `-r` cannot reach subdirectories — luck on
  # both counts. Delete named paths, never a glob built from a variable that may be empty.
  for tmp in "$out/$bid.t1w.store" "$out/$bid.t1e.store" "$out/$bid.t2w.store" "$out/$bid.t2e.store"; do
    rm -f "$tmp" "$tmp.dschema"
  done

  ways="$("$loft" --native --lib "$here/lib" "$here/tools/census.loft" roads "$raw" 2>/dev/null \
          | grep -oP '^count roads.ways \K[0-9]+')"
  [ -n "$ways" ] || die "band $k census read nothing"
  peak="$(grep -oP 'Maximum resident set size \(kbytes\): \K[0-9]+' "/tmp/band-$bid.log" || true)"
  printf '   %-22s %10s ways  %8s%s\n' "$(basename "$raw")" "$ways" \
    "$(numfmt --to=iec "$(stat -c%s "$raw")")" "${peak:+  peak $((peak / 1024)) MB}"
  total=$((total + ways))
done

echo
echo "== $nb band(s), $total ways total =="
echo "   ⚠ Conservation is NOT asserted here: the bands are built from separate extracts, so there is no"
echo "     whole-country block to compare against — that is the point. Check the sum against the source's"
echo "     own count (\`<block>.srccount\`), and prove disjointness with tools/block_overlap_gate.sh."
