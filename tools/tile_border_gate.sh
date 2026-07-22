#!/usr/bin/env bash
# Copyright (c) 2026 Jurjen Stellingwerff
# SPDX-License-Identifier: LGPL-3.0-or-later
#
# PLAN-PERF §7a(2) — the acceptance gate for step 19b (persist the graph per tile), built BEFORE the
# format change so it can fail the day the change lands wrong.
#
# PLAN-TILES §268's own acceptance is "a corridor spanning >=2 tiles matches identically", and §7a calls
# 19b the riskiest row in the plan: a border-node merge that goes wrong changes a route across a tile
# edge, silently and plausibly. This locks the routes that cross those edges TODAY, and asserts the
# property the union depends on.
#
# Two halves, both of which must hold:
#   * NON-VACUITY — every corridor must span >=2 tiles AND its route must actually cross a tile boundary.
#     A green run over corridors that never touch a border would prove nothing.
#   * IDENTITY — the route fingerprints match the recorded goldens, and feeding the SAME ways in reversed
#     and rotated order yields the same route (so a union may renumber nodes freely).
#
#   tools/tile_border_gate.sh
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
loft="${LOFT_BIN:-$(command -v loft || echo /usr/local/bin/loft)}"
store="$here/_site/stores/enschede.roads.store"
[ -f "$store" ] || { echo "SKIP: no roads store at $store (build: node browser/build-site.mjs)"; exit 2; }

echo "== step 19b acceptance: routes across tile borders =="
out="$("$loft" --native --lib "$here/lib" "$here/tools/tile_border_probe.loft" "$store" 2>&1)" || {
  echo "$out"; echo "FAIL — probe did not run"; exit 1; }
echo "$out" | grep '^#B'

if ! echo "$out" | grep -q '^#B ALL PASS'; then
  echo "FAIL — a corridor changed route, stopped crossing borders, or became order-sensitive"
  exit 1
fi
echo "PASS — 4 corridors, each spanning >=2 tiles with border crossings, routes unchanged and order-insensitive"
