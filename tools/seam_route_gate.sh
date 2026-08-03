#!/usr/bin/env bash
# Copyright (c) 2026 Jurjen Stellingwerff
# SPDX-License-Identifier: LGPL-3.0-or-later
#
# @51 PHASE D — a route across the NETHERLANDS/BELGIUM border is the route one block would give.
#
# THIS IS THE RUNG'S ENTRY CONDITION, not a regression check. @51 states it plainly: the rung "is not
# entered when the data is published; it is entered when a route crosses the seam and is the route the
# whole region gives". Everything before this — the trim, the derived blocks, the staged manifest — is
# setup for the question asked here.
#
# ⚠ HOW IT DIFFERS FROM `cross_block_gate`, which asks the same thing one country in. That gate
# MANUFACTURES its seam by splitting a block it already has, so the unsplit original is the reference for
# free. At a real border there is no original: the two blocks came from different Geofabrik extracts and
# no file has ever held both. The reference is built here by MERGING them — which is only meaningful
# because `tools/trim-borders.sh` made them a partition first, and `merge_blocks.loft` refuses inputs
# that are not one. So this gate silently depends on the trim being right, and would fail loudly if it
# were not.
#
#   tools/seam_route_gate.sh
#
# Runs against `blocks/trim/`, which is NOT what the index resolves to — publishing those changes four
# published Netherlands blocks. That is deliberate: the rung can be proven before it is paid for.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
loft="${LOFT_BIN:-$(command -v loft || echo /usr/local/bin/loft)}"
trim="${TRIM_DIR:-$here/blocks/trim}"
be="$trim/belgium.roads.store"
work="${TMPDIR:-/tmp}/seam-route-$$"

for f in "$trim/nl-west.roads.store" "$trim/nl-midwest.roads.store" "$be"; do
  [ -f "$f" ] || { echo "SKIP: no trimmed block at $f (build: tools/trim-borders.sh)"; exit 2; }
done
mkdir -p "$work"
trap 'rm -rf "$work"' EXIT

echo "== @51 D: a route across the NL/BE border =="

fails=0; ran=0

# ⚠ A CROSSING MUST BE TESTED AGAINST THE BLOCK THAT ACTUALLY HOLDS ITS DUTCH SIDE, and getting this
# wrong is how the gate was first written. The Netherlands is cut at 4.70 / 5.40 / 5.90°E, so a sketch at
# lon 4.29 — Bergen op Zoom to Antwerpen, the busiest crossing in Benelux — lies in `nl-west`, not
# `nl-midwest`. Paired with the wrong block it drew 0 cells from the Dutch side and the probe reported it
# VACUOUS. That is the non-vacuity check earning its place: paired wrongly, a border test proves nothing
# and looks exactly like a pass.
run_pair() {   # $1 = NL block id, then name|trace pairs
  nlid="$1"; shift
  nl="$trim/$nlid.roads.store"
  ref="$work/ref-$nlid.store"
  rm -f "$ref" "$ref.dschema"
  # Rebuilt per run, never kept: a stale merge is a reference describing blocks that have since moved, and
  # every comparison against it would pass for the wrong reason. Same rule cross_block_gate follows.
  m="$("$loft" --native --lib "$here/lib" "$here/tools/merge_blocks.loft" "$ref" "$nl" "$be" 2>&1)"
  if ! echo "$m" | grep -q '^#M ALL PASS'; then
    echo "  ✘ $nlid + belgium: reference could not be built"
    echo "$m" | grep '^#M FAIL' | sed 's/^/      /'
    echo "      If it says 'not a partition', the TRIM is what is wrong, not this gate."
    fails=$((fails + 1)); return
  fi
  printf '  %s + belgium — reference %s\n' "$nlid" "$(echo "$m" | grep -oP '^#M out \K.*· persist' | sed 's/ · persist//')"
  for entry in "$@"; do
    nm="${entry%%|*}"; tr="${entry#*|}"
    ran=$((ran + 1))
    out="$("$loft" --native --lib "$here/lib" "$here/tools/cross_block_probe.loft" "$ref" "$nl" "$be" "$tr" 2>&1)"
    line="$(echo "$out" | grep '^#X split' || true)"
    if echo "$out" | grep -q '^#X ALL PASS'; then
      printf '    ✔ %-32s %s NL + %s BE cells · %s pts · identical\n' "$nm" \
        "$(echo "$line" | grep -oP 'west_keys=\K[0-9]+')" \
        "$(echo "$line" | grep -oP 'east_keys=\K[0-9]+')" \
        "$(echo "$line" | grep -oP 'route_pts=\K[0-9]+')"
    else
      printf '    ✘ %-32s\n' "$nm"
      echo "$out" | grep '^#X' | sed 's/^/        /'
      fails=$((fails + 1))
    fi
  done
}

# THE CORPUS — crossings at four longitudes across two Dutch blocks, because one seam point is one
# accident. Every sketch must genuinely STRADDLE: @51's negative control is "a sketch that straddles the
# cut, not one that merely nears it", and the probe enforces it rather than this script asserting it.
run_pair nl-west \
  "Bergen op Zoom → Antwerpen|51.4900,4.2900;51.4100,4.3600;51.3300,4.4200"
run_pair nl-midwest \
  "Breda → Turnhout|51.5200,4.8000;51.4400,4.8500;51.3600,4.9000" \
  "Baarle, through the enclaves|51.4800,4.9300;51.4300,4.9300;51.3800,4.9300" \
  "Reusel → Arendonk|51.4000,5.1000;51.3400,5.1000;51.2800,5.1000"

echo
[ "$fails" = 0 ] || { echo "FAIL — $fails of $ran border routes differ from the single-block route."; exit 1; }
echo "PASS — all $ran routes across the NL/BE border are the route one block covering both would give."
exit 0
