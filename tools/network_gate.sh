#!/usr/bin/env bash
# Copyright (c) 2026 Jurjen Stellingwerff
# SPDX-License-Identifier: LGPL-3.0-or-later
#
# PLAN-RESTORE R3 — signposted walking / cycling / MTB networks are in the block, and the router prefers
# them without detouring.
#
# The old server-based client showed these as a Waymarkedtrails RASTER overlay: pretty, someone else's
# server, and invisible to routing. The data now lives in our own files, which is the whole point — the
# app fetches nothing external — so the block has to carry it and the router has to use it.
#
# Two halves, because either alone is satisfiable by a broken pipeline:
#
#   CONSERVATION — the shipped block actually carries RF_NET_* bits. A block generated before R3, or with
#     a sidecar built for another region, or from an export run without `-u type_id`, opens fine, routes
#     fine, and has every network bit clear. Only a count separates that from a working one.
#
#   BEHAVIOUR — an A/B on that same block, network bits stripped in memory for the control, over the
#     26-sketch corpus for every activity. It must move routes ONTO the network (a run that changed
#     nothing proves the wiring, not the feature) without opening a gap or straying unpaid, and it must
#     leave DRIVING bit-for-bit identical — driving follows no network, so it is the control that proves
#     the A/B measures the bonus rather than the rebuild.
#
#   tools/network_gate.sh
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
loft="${LOFT_BIN:-$(command -v loft || echo /usr/local/bin/loft)}"
src="$here/browser/stores/enschede.roads.store"
[ -f "$src" ] || { echo "SKIP: no roads store at $src"; exit 2; }

# PLAN-LAYERS §3 (L1) — the SIDECAR half, which runs before any block exists. It is checked from a small
# OPL fixture rather than from a PBF: the country extract is 1.4 GB and lives in nobody's checkout, and a
# gate that can only run where the data happens to be is a gate that does not run.
echo "== L1: the route sidecar carries routes, and the old reader is unharmed =="
python3 "$here/tools/route_sidecar_check.py" || exit 1

echo "== R3: curated networks in the block, and preferred by the router =="

bits="$("$loft" --native --lib "$here/lib" "$here/tools/network_probe.loft" "$src" 2>&1 | grep '^#N bits')" \
  || { echo "FAIL — the probe did not run"; exit 1; }
echo "  $bits"
walk="$(echo "$bits" | grep -oP 'walk=\K[0-9]+')"
cycle="$(echo "$bits" | grep -oP 'cycle=\K[0-9]+')"
mtb="$(echo "$bits" | grep -oP 'mtb=\K[0-9]+')"
# Region-specific floors, well under what this block holds (3109 / 1721 / 544) and well over zero. They
# are here to catch a block regenerated without the sidecar, which is the failure that leaves everything
# else in this gate green.
for chk in "walk:${walk:-0}:1000" "cycle:${cycle:-0}:500" "mtb:${mtb:-0}:100"; do
  IFS=: read -r name got floor <<<"$chk"
  [ "$got" -ge "$floor" ] || {
    echo "FAIL — the block carries $got $name-network roads (expected >= $floor)."
    echo "       Regenerate it: tools/build-blocks.sh must run tools/route_networks.py and pass the"
    echo "       sidecar to gen-tiles, and the osmium export must use -u type_id."
    exit 1; }
done

# One process per profile: the probe holds two full corridors of Ways per sketch and exhausts loft's
# 65535-store table part way through the fourth profile if they share one.
fail=0
for p in walking_paved walking_trail running_trail cycling_road cycling_gravel cycling_mtb driving_fastest; do
  out="$("$loft" --native --lib "$here/lib" "$here/tools/network_probe.loft" "$src" "$p" 2>&1)"
  echo "$out" | grep -E '^#N (profile|WORSE|FAIL)' | sed 's/^/  /'
  echo "$out" | grep -q "^#N PASS $p" || fail=1
done
[ "$fail" -eq 0 ] || { echo "FAIL — see the WORSE/FAIL lines above"; exit 1; }

echo "  R3 GATE PASSES"
