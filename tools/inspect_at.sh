#!/usr/bin/env bash
# Copyright (c) 2026 Jurjen Stellingwerff
# SPDX-License-Identifier: LGPL-3.0-or-later
#
# INSPECT THE MAP WHERE SOMEONE IS LOOKING — from the app's own URL.
#
# The app writes its camera into the URL fragment (`#zoom/lat/lon`, browser/store-app.mjs), so a report
# about the map can be a LINK rather than a description. Paste it here and this prints what the shipped
# blocks actually hold there: roads by class and whether the router may use them, landcover by cover,
# buildings, labels and pois.
#
# That matters because a "the map is wrong here" report has at least four different causes, and they need
# opposite fixes: the feature is absent from OSM (needs an OSM edit), present in OSM but dropped by our
# pipeline (a filter or parser bug), present in the block but not drawn (a missing style), or present and
# drawn but mis-classified (a classifier bug). Only the data can say which.
#
#   tools/inspect_at.sh 'https://jjstwerff.github.io/routing/#16/52.2159/6.8919'
#   tools/inspect_at.sh '#16/52.2159/6.8919'
#   tools/inspect_at.sh 52.2159 6.8919 [radius_m]
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
loft="${LOFT_BIN:-$(command -v loft || echo /usr/local/bin/loft)}"
roads="${ROADS_STORE:-$here/browser/stores/enschede.roads.store}"
base="${BASE_STORE:-$here/browser/stores/enschede.layout.store}"

usage() { sed -n '5,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 2; }
[ $# -ge 1 ] || usage

if [ $# -ge 2 ] && [ -z "${1##*[0-9]*}" ] && [ -z "${2##*[0-9]*}" ] && [ "${1#*/}" = "$1" ]; then
  lat="$1"; lon="$2"; rad="${3:-150}"
else
  # Everything after the LAST '#'. A pasted app URL carries the origin and path in front of it, and the
  # fragment is `zoom/lat/lon` — the same order the app writes, which is OSM's, not lat/lon-first.
  frag="${1##*#}"
  zoom="${frag%%/*}"; rest="${frag#*/}"
  lat="${rest%%/*}"; lon="${rest#*/}"; lon="${lon%%/*}"
  rad="${2:-150}"
  case "$lat$lon" in *[!0-9.-]*|"") echo "FAIL: could not read '#zoom/lat/lon' out of: $1"; usage ;; esac
  echo "(from the app URL: zoom $zoom)"
fi

for f in "$roads" "$base"; do
  [ -s "$f" ] || { echo "FAIL: no store at $f (override with ROADS_STORE= / BASE_STORE=)"; exit 1; }
done

"$loft" --native --lib "$here/lib" "$here/tools/inspect_at.loft" "$roads" "$base" "$lat" "$lon" "$rad" \
  2>/dev/null | grep -vE '^\s*$'
