#!/usr/bin/env bash
# Copyright (c) 2026 Jurjen Stellingwerff
# SPDX-License-Identifier: LGPL-3.0-or-later
#
# A way OSM says is closed must not be routed over — and a `track` must stay a track.
#
# WHY IT EXISTS. Reported from the map: "there are paths that are blocked (fences) and not allowed for
# public walking, but they show up as normal paths and are probably used for routing too." They were.
# A stored road is three bytes (class, flags, vertex count) and `append_tile_ways` rebuilt every way
# with `access: ""` / `bicycle: ""` / `svc: ""`, so `bike_never` and `foot_never` — which do test those —
# could never fire on a tile-sourced way. 43 ways tagged `access=private`/`no` in one 1.8 × 3.6 km box
# near Enschede were all stored as ordinary open ways. The check that would have caught it is this one:
# not "does the store load" but "does a route obey what the store says".
#
# THE FIXTURE IS THE POINT. Real data cannot prove this: a route that avoids a private path might be
# avoiding it for a dozen unrelated reasons, so the gate would pass either way. Here the SHORTEST line
# between the two endpoints is the private one — 680 m against a 1120 m public detour — so a router
# that ignores `access` provably takes it. Verified to fail: with the RF_ACCESS_NO bit stripped from
# the fixture (`--negative`), the route drops to the short way and `restricted_m` goes positive.
#
# Both halves run against the same fixture:
#   1. cycling  — `access=private` shortcut must be refused (the reported bug)
#   2. walking  — `access=no` + `foot=yes` must be ALLOWED (the over-blocking the fix must not cause;
#                 3 of those 43 ways are tagged exactly that way, meaning "closed to cars, walkers ok")
#   3. class    — the fixture's `highway=track` must land in class 12, not folded into `path`
#   4. real data — the shipped block must carry a non-zero count of each, so a regeneration that
#                 silently drops the tags fails here rather than on someone's screen
#
#   tools/access_gate.sh
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
loft="${LOFT_BIN:-$(command -v loft || echo /usr/local/bin/loft)}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
rc=0

# --- the fixture ------------------------------------------------------------------------------
# A ── private path ── B      680 m, the straight line between the endpoints
#  \                  /
#   public detour ───┘        1120 m via residential roads, 220 m north
#
# Plus a track (for the class check) and an access=no + foot=yes path (for the walking check), both
# well away from the A→B corridor so they cannot influence that route.
# 0x1E is the RFC 8142 record separator `osmium export -f geojsonseq` writes and the reader expects.
mk_fixture() {  # $1 = out, $2 = "private" | "open"
  local acc=',"access":"private"'
  [ "$2" = "open" ] && acc=''
  python3 - "$1" "$acc" <<'PY'
import sys, json
out, acc = sys.argv[1], sys.argv[2]
def feat(props, coords):
    return "\x1e" + json.dumps({"type": "Feature", "properties": props,
                                "geometry": {"type": "LineString", "coordinates": coords}},
                               separators=(",", ":")) + "\n"
A, B = [6.8500, 52.2000], [6.8600, 52.2000]
NW, NE = [6.8500, 52.2020], [6.8600, 52.2020]
rows = []
# The shortcut — private unless the negative run strips it. `residential`, NOT `path`: for a cycling
# profile a path is dismount-tier, so a path shortcut loses to the detour on cost alone and the gate
# would pass without ever testing `access` (the first version did exactly that). A private ROAD is
# also the reported case — Viekerweg is a way you may not use, not a way that is unpleasant to ride.
p = {"highway": "residential"}
if acc: p["access"] = "private"
rows.append(feat(p, [A, B]))
# the public detour, in three residential legs
rows.append(feat({"highway": "residential"}, [A, NW]))
rows.append(feat({"highway": "residential"}, [NW, NE]))
rows.append(feat({"highway": "residential"}, [NE, B]))
# a dirt road, for the class check
rows.append(feat({"highway": "track", "surface": "ground"}, [[6.8700, 52.2100], [6.8750, 52.2100]]))
# closed to traffic, walkers explicitly welcome
rows.append(feat({"highway": "path", "access": "no", "foot": "yes"},
                 [[6.8700, 52.2200], [6.8750, 52.2200]]))
open(out, "w").write("".join(rows))
PY
}

echo "== a way tagged closed must not be routed over =="
for variant in private open; do
  mk_fixture "$work/$variant.geojsonseq" "$variant"
  rm -f "$work/$variant.store"
  "$loft" --native --lib "$here/lib" "$here/tools/gen-tiles.loft" "$work/$variant.store" \
    "$work/$variant.geojsonseq" >/dev/null 2>&1 \
    || { echo "  FAIL: could not build the $variant fixture"; exit 1; }
done

TRACE="52.2000,6.8500;52.2000,6.8550;52.2000,6.8600"
run() { "$loft" --native --lib "$here/lib" "$here/tools/access_probe.loft" "$@" 2>/dev/null | grep '^#A'; }

# 1. the reported bug — the private shortcut must be refused, so the route takes the long way round
got="$(run route "$work/private.store" "$TRACE")"
len="$(echo "$got"  | sed 's/.*len_m=\([0-9.]*\).*/\1/')"
bad="$(echo "$got"  | sed 's/.*restricted_m=\([0-9.]*\).*/\1/')"
echo "  cycling over the private shortcut: len=${len} m restricted=${bad} m"
awk -v b="$bad" 'BEGIN{exit !(b < 0.5)}' \
  || { echo "  FAIL: the route used ${bad} m of a way tagged access=private"; rc=1; }
awk -v l="$len" 'BEGIN{exit !(l > 900)}' \
  || { echo "  FAIL: len=${len} m — that is the 680 m shortcut, not the 1120 m public detour"; rc=1; }

# 2. the control that makes it a test: same geometry, tag removed → the short way IS taken.
#    If this does not shorten, the fixture never tempted the router and (1) proves nothing.
got_open="$(run route "$work/open.store" "$TRACE")"
len_open="$(echo "$got_open" | sed 's/.*len_m=\([0-9.]*\).*/\1/')"
echo "  same fixture, tag removed:         len=${len_open} m   (the shortcut is only taken when legal)"
awk -v l="$len_open" 'BEGIN{exit !(l < 800)}' \
  || { echo "  FAIL: not discriminating — the untagged shortcut was not taken either (len=${len_open} m)"; rc=1; }

# 3. closed to traffic, walkers signed in — must stay walkable
WTRACE="52.2200,6.8700;52.2200,6.8750"
gotw="$(run route "$work/private.store" "$WTRACE" walking_paved)"
wlen="$(echo "$gotw" | sed 's/.*len_m=\([0-9.]*\).*/\1/')"
echo "  walking an access=no + foot=yes path: len=${wlen} m"
awk -v l="$wlen" 'BEGIN{exit !(l > 100)}' \
  || { echo "  FAIL: over-blocked — OSM signs this one foot=yes, it must stay walkable"; rc=1; }

# 4. the class split
cnt="$(run count "$work/private.store")"
echo "  fixture: $cnt"
echo "$cnt" | grep -q "track=1" || { echo "  FAIL: highway=track did not land in class 12"; rc=1; }
echo "$cnt" | grep -q "access_no=2" || { echo "  FAIL: the access bits are not in the store"; rc=1; }

# 5. real data — the shipped block must actually carry these, or the pipeline regressed
block="$here/browser/stores/enschede.roads.store"
if [ -f "$block" ]; then
  real="$(run count "$block")"
  echo "  shipped block: $real"
  for field in track access_no; do
    n="$(echo "$real" | sed "s/.*$field=\([0-9]*\).*/\1/")"
    [ "${n:-0}" -gt 0 ] || { echo "  FAIL: the shipped block has $field=0 — it predates the fix (regenerate it)"; rc=1; }
  done
else
  echo "  (no shipped block — real-data check skipped)"
fi

[ $rc -eq 0 ] && echo "PASS — closed ways are refused, signed-open ways are kept, tracks are tracks" \
              || echo "FAIL — a routing-legality check did not hold"
exit $rc
