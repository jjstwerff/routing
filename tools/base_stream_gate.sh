#!/usr/bin/env bash
# Copyright (c) 2026 Jurjen Stellingwerff
# SPDX-License-Identifier: LGPL-3.0-or-later
#
# PLAN-SCALE S6, base half — the presentation-store builder streams its input, and streaming bins exactly
# what whole-file binning does.
#
# `client/basemap/build_store.loft` read SIX Overpass documents with `file().content()`, so a country's
# base map was six whole documents plus every parsed element, resident at once. It now reads `.geojsonseq`
# layers line by line (one chunk, whatever the file) and shares one set of `bin_*` functions with the
# whole-file path, so the two cannot drift.
#
# The gate proves that sharing rather than assuming it: the SAME fixtures are converted to geojsonseq and
# built both ways, and every layer count must match. Counts are the right assertion here — the base map has
# no route to fingerprint, and a per-layer count catches a lost tag, a dropped geometry kind or a
# mis-binned tile all the same.
#
#   tools/base_stream_gate.sh
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
loft="${LOFT_BIN:-$(command -v loft || echo /usr/local/bin/loft)}"
fx="$here/client/basemap/fixtures"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
[ -f "$fx/real_stretch_areas.json" ] || { echo "SKIP: no basemap fixtures"; exit 2; }

layers="areas buildings places streets lines pois"
echo "== S6 (base): whole-file vs streamed =="
for l in $layers; do
  python3 "$here/tools/overpass_to_geojsonseq.py" "$fx/real_stretch_$l.json" "$work/$l.geojsonseq" >/dev/null \
    || { echo "  FAIL: could not convert $l"; exit 1; }
done

counts() {  # prints "tiles=… areas=… buildings=… labels=… lines=… pois=…" from a build
  "$1" 2>&1 | grep -oP '^tiles=\K.*' | head -1
}
whole="$("$loft" --native --lib "$here/lib" "$here/client/basemap/build_store.loft" \
          "$fx/real_stretch_areas.json" "$fx/real_stretch_buildings.json" "$fx/real_stretch_places.json" \
          "$fx/real_stretch_streets.json" "$fx/real_stretch_lines.json" "$fx/real_stretch_pois.json" \
          2>&1 | grep -oP '^tiles=\K[^|]*' | head -1)"
stream="$("$loft" --native --lib "$here/lib" "$here/client/basemap/build_store.loft" \
          "$work/areas.geojsonseq" "$work/buildings.geojsonseq" "$work/places.geojsonseq" \
          "$work/streets.geojsonseq" "$work/lines.geojsonseq" "$work/pois.geojsonseq" \
          2>&1 | grep -oP '^tiles=\K[^|]*' | head -1)"
echo "  whole-file: $whole"
echo "  streamed  : $stream"

[ -n "$whole" ] || { echo "FAIL — the whole-file build produced no counts"; exit 1; }
# Non-vacuity: an empty fixture set would make both sides agree on nothing.
echo "$whole" | grep -qE 'buildings=[0-9]{4,}' || { echo "FAIL — the fixtures are too small to prove anything"; exit 1; }
if [ "$whole" != "$stream" ]; then
  echo "FAIL — streamed binning differs from whole-file binning"
  exit 1
fi
echo "PASS — a streamed base map bins exactly what the whole-file reader bins"
