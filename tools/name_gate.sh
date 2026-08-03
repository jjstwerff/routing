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
big="$here/blocks/coverage.names.store"
[ -f "$big" ] || big="$here/blocks/nl.names.store"
if [ -f "$big" ]; then
  echo "  -- against the country store --"
  bout="$("$loft" --native --lib "$here/lib" "$here/tools/name_probe.loft" "$big" 2>&1)"
  echo "$bout" | grep -E '^#R' | sed 's/^/  /'
  echo "$bout" | grep -q '^#R ALL PASS' || { echo "FAIL — the country store does not satisfy the fixtures"; exit 1; }
fi

# --- SEARCH MUST CROSS A BORDER (2026-08-03) ---------------------------------------------------------
#
# One country hid this completely. `NAMES` is resolved ONCE at boot from the CAMERA's block, and
# `store_load_url_trusted` adopts an image rather than adding to one — so search was single-block by
# construction, and a user in Breda searching "Turnhout" got Dutch streets NAMED AFTER the city and never
# the city itself, 18 km away. Same defect the base map had before §6f F3 made it a covering set.
#
# ⚠ THE CONTROL IS THE POINT. Each case is run against the coverage store AND the single-country one, and
# the gate demands the country store FAIL — otherwise it proves nothing about the fix, only that the query
# matches something. Measured: nl.names.store answers "turnhout" with Turnhoutstraat and Turnhoutseweg,
# both in the Netherlands, and never with Turnhout.
cov="$here/blocks/coverage.names.store"
if [ -f "$cov" ]; then
  echo "  -- search across a border --"
  # name | camera lat,lon | the place it must find, lat,lon | tolerance in degrees
  while IFS='|' read -r q cam want tol; do
    [ -n "$q" ] || continue
    cl="${cam%,*}"; co="${cam#*,}"
    wl="${want%,*}"; wo="${want#*,}"
    hit="$("$loft" --native --lib "$here/lib" "$here/tools/find_probe.loft" "$cov" "$cl" "$co" "$q" 5 2>&1 \
           | awk -v a="$wl" -v b="$wo" -v t="$tol" '/^FOUND / { split($2,c,","); \
               if ((c[1]-a)^2 + (c[2]-b)^2 < t*t) print "yes" }' | head -1)"
    if [ "$hit" != yes ]; then
      echo "  FAIL: \"$q\" from $cam did not find $want in the coverage store"; exit 1
    fi
    # The control: the single-country store must NOT find it, or this case is not testing the fix.
    if [ -f "$here/blocks/nl.names.store" ]; then
      ctl="$("$loft" --native --lib "$here/lib" "$here/tools/find_probe.loft" "$here/blocks/nl.names.store" "$cl" "$co" "$q" 5 2>&1 \
             | awk -v a="$wl" -v b="$wo" -v t="$tol" '/^FOUND / { split($2,c,","); \
                 if ((c[1]-a)^2 + (c[2]-b)^2 < t*t) print "yes" }' | head -1)"
      if [ "$ctl" = yes ]; then
        echo "  FAIL: the NL-only store also finds \"$q\" — this case does not test the covering set"; exit 1
      fi
    fi
    echo "  ✔ \"$q\" from $cam — found across the border, and NOT in the single-country store"
  done <<'CASES'
turnhout|51.5719,4.7683|51.3234,4.9485|0.02
echternach|50.8503,4.3517|49.8121,6.4215|0.02
CASES
fi

echo "  R4 GATE PASSES"
