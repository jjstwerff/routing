#!/usr/bin/env bash
# Copyright (c) 2026 Jurjen Stellingwerff
# SPDX-License-Identifier: LGPL-3.0-or-later
#
# PLAN-SCALE S8 — a route across a BLOCK seam is the route the whole region gives.
#
# At C2 the map is many blocks and a corridor near a border draws cells from more than one. That property
# is usually discovered late, over real data, with nothing to compare against. Here the seam is
# MANUFACTURED from the block we ship — split by cell, so no way is cut and no coordinate moves — and the
# reference is the same corridor against the unsplit block. Both routes are computed in one run, so there
# is no golden to drift.
#
# The seam is genuine in the way that matters: a per-region generation also cuts on cell boundaries, and
# the two halves are separate files the working set has to be filled from in turn.
#
# Nothing is committed but the tools: the split is rebuilt every run, so it cannot go stale against the
# block, and a re-keyed or regenerated block is re-split automatically.
#
#   tools/cross_block_gate.sh
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
loft="${LOFT_BIN:-$(command -v loft || echo /usr/local/bin/loft)}"
src="$here/browser/stores/enschede.roads.store"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
[ -f "$src" ] || { echo "SKIP: no roads store at $src"; exit 2; }

echo "== S8: a corridor across a block seam =="
split="$("$loft" --native --lib "$here/lib" "$here/tools/split_block.loft" \
         "$src" "$work/west.store" "$work/east.store" 6.88 2>&1)" \
  || { echo "$split"; echo "FAIL — could not split the block"; exit 1; }
echo "$split" | grep -E '^split at' | sed 's/^/  /'
echo "$split" | grep -q 'FAIL' && { echo "$split"; exit 1; }

out="$("$loft" --native --lib "$here/lib" "$here/tools/cross_block_probe.loft" \
       "$src" "$work/west.store" "$work/east.store" 2>&1)" \
  || { echo "$out"; echo "FAIL — the cross-block probe did not run"; exit 1; }
echo "$out" | grep '^#X' | sed 's/^/  /'

if ! echo "$out" | grep -q '^#X ALL PASS'; then
  echo "FAIL — a route across a block seam is not the route the whole region gives."
  echo "       Every multi-block rung (C2 onwards) stands on this; fix it before generating blocks."
  exit 1
fi
echo "PASS — a working set filled from two blocks routes identically to the single block"
