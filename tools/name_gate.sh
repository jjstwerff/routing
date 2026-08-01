#!/usr/bin/env bash
# Copyright (c) 2026 Jurjen Stellingwerff
# SPDX-License-Identifier: LGPL-3.0-or-later
#
# PLAN-RESTORE R4 — search our own names, and be honest when we do not know one.
#
# The old client sent `locate` to Nominatim. Nothing here leaves the machine: the names come from the same
# OSM extract the roads do, in a store of their own, and the whole Netherlands is 36 MB of it — 6% of the
# roads it ships beside.
#
# R4's original plan searched the BASE map's labels at load, which was right while the only region was a
# 20 MB city. It does not survive N3: the NL base map is 2.87 GB and stays on the release, so outside
# Enschede there would be nothing to search. Hence a store of its own.
#
# Both halves of the acceptance, because each alone is satisfiable by a broken search:
#   RESOLVES  — every fixture name lands within 2 km of where it really is, and a name that IS a place
#               resolves to the place rather than to a street that contains the word.
#   ADMITS IT — an unknown name returns NOTHING. A geocoder that always offers its nearest guess is
#               worse than one that says it does not know, because the map moves and you believe it.
#
#   tools/name_gate.sh
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
loft="${LOFT_BIN:-$(command -v loft || echo /usr/local/bin/loft)}"
src="$here/browser/stores/enschede.names.store"
[ -f "$src" ] || { echo "SKIP: no name store at $src (build: tools/gen-names.loft)"; exit 2; }

echo "== R4: the name store answers, and admits what it does not know =="
out="$("$loft" --native --lib "$here/lib" "$here/tools/name_probe.loft" "$src" 2>&1)" \
  || { echo "$out"; echo "FAIL — the probe did not run"; exit 1; }
echo "$out" | grep -E '^#R' | sed 's/^/  /'
echo "$out" | grep -q '^#R ALL PASS' || { echo "FAIL — see the lines above"; exit 1; }

# The COUNTRY store when it has been built. It is generated output (gitignored), so its absence is not a
# failure — but when it is there it is what actually ships, and a fixture set proven only against a city
# says nothing about 296 457 street names competing for the same query.
big="$here/blocks/nl.names.store"
if [ -f "$big" ]; then
  echo "  -- against the country store --"
  bout="$("$loft" --native --lib "$here/lib" "$here/tools/name_probe.loft" "$big" 2>&1)"
  echo "$bout" | grep -E '^#R' | sed 's/^/  /'
  echo "$bout" | grep -q '^#R ALL PASS' || { echo "FAIL — the country store does not satisfy the fixtures"; exit 1; }
fi

echo "  R4 GATE PASSES"
