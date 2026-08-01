#!/usr/bin/env bash
# Copyright (c) 2026 Jurjen Stellingwerff
# SPDX-License-Identifier: LGPL-3.0-or-later
#
# PLAN-SCALE D3's standing gate: loft's WORKING-SET loader is our whole read path for Western Europe
# (no codec of our own — a gap there is a loft bug, not something this repo routes around). So the claim
# that a paged load returns exactly what a whole load returns has to be checked on OUR two real tile
# shapes, on every run, not measured once in a design session:
#
#   TTile  (roads)  — vector<TRoad> / vector<TStep>, flat structs of scalars
#   PTile  (layout) — vector<Area> where Area{cover: text, ring: vector<Coord>}: text AND a nested vector,
#                     the shape loft's relocator is documented to refuse in its `vector<vector>` form
#
# A refusal returns false, which is exactly what an ABSENT KEY looks like (loft#632), so silence here
# reads as missing data. The probe therefore compares the RICHEST tile both ways and refuses to pass on an
# empty one.  LOFT_LOADER_STATS=1 also shows bytes_fetched vs file size — the working-set claim itself.
#
#   tools/paged_gate.sh
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
loft="${LOFT_BIN:-$(command -v loft || echo /usr/local/bin/loft)}"
layout="$here/browser/stores/enschede.layout.store"
roads="$here/browser/stores/enschede.roads.store"
for f in "$layout" "$roads"; do
  [ -f "$f" ] || { echo "SKIP: no store at $f"; exit 2; }
done

echo "== PLAN-SCALE D3: paged (working-set) load == whole load =="
out="$(LOFT_LOADER_STATS=1 "$loft" --native --lib "$here/lib" "$here/tools/paged_probe.loft" "$layout" "$roads" 2>&1)" || {
  echo "$out"; echo "FAIL — probe did not run"; exit 1; }
echo "$out" | grep -E '^  (whole|paged) load|^  store_load_key|^store_load_keys|^layout:|^roads:|✓|⛔'

if ! echo "$out" | grep -q '^#P ALL PASS'; then
  echo "$out" | grep '^#P FAIL' || true
  echo "FAIL — a paged load no longer reproduces the whole load (or the sample tile went empty)."
  echo "       This is the WE read path (PLAN-SCALE §2/D3): report it upstream with this probe as the"
  echo "       reproducer rather than working around it here."
  exit 1
fi
echo "PASS — both tile shapes page in identically, from a fraction of the file"

# --- PLAN-SCALE §6f F1: what the base map's FETCH WINDOW misses --------------------------------------
#
# Paging the layout is sound only to the extent that `map_kernel::LAYOUT_PAD` covers how far a feature
# reaches beyond the cell it is keyed in — and a feature is keyed by its first vertex and never clipped,
# so some reach much further (PLAN-PERF §7g). A whole load draws them anyway; a paged load cannot,
# because a tile it never fetched has no extent to consult.
#
# That residual is a property of the DATA, not of the code: a regeneration that adds a wider feature
# class moves it, and nothing else in the suite would notice — the map still renders, the route is
# unaffected, there is simply less on the screen. Same reason `tools/tile_overhang.loft` exists.
#
# The box is the app's own first viewport at its default z16 camera; the bound is the measured 7 plus
# one. Raising it is a decision about how much of the map may go missing, so it belongs in a diff.
echo "== PLAN-SCALE §6f F1: the paged base map's fetch window =="
vout="$("$loft" --native --lib "$here/lib" "$here/tools/layout_page_probe.loft" "$layout" \
        verify 52.213446,6.870097,52.229554,6.917303 1 8 2>&1)" || {
  echo "$vout"; echo "FAIL — layout_page_probe did not run"; exit 1; }
echo "$vout" | grep -E '^#L'
if ! echo "$vout" | grep -q '^#L PASS'; then
  echo "FAIL — a one-cell fetch window now drops more of the base map than it did when LAYOUT_PAD was set."
  echo "       Do NOT just raise the pad: exactness needs 11 cells at z16 and 50 at z14 (PLAN-SCALE §6f)."
  echo "       The fix is to bound a feature's reach at GENERATION — re-bin into containing tiles (F3)."
  exit 1
fi
echo "PASS — the base map's one-cell fetch window still covers what it covered"
