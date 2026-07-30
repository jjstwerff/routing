#!/usr/bin/env bash
# Copyright (c) 2026 Jurjen Stellingwerff
# SPDX-License-Identifier: LGPL-3.0-or-later
#
# PLAN-SCALE S6 — the generator's STREAMING input path, gated by a round trip.
#
# `tools/gen-tiles.loft` used to read its whole input as one `text` value (`file(osm).content()`), which
# is fine for a city and impossible for a country: the document, and every way parsed out of it, is
# resident before the first tile is written. It now also reads `geojsonseq` line by line, holding one
# chunk whatever the file size.
#
# A reader is easy to write and easy to get subtly wrong — a dropped last line, a split multi-byte
# character, a lost tag. So this does not test the reader, it tests the RESULT:
#
#     shipped block → geojsonseq → gen-tiles (streaming) → block'      block' must ROUTE like the block
#
# Route identity is checked with the border probe's golden fingerprints — the same numbers the tile-border
# gate pins — because equal tile counts would not catch geometry that moved by a centimetre, and a route
# is what the data is FOR. The emitted input is reconstructed from the store itself (the original Overpass
# JSON is long gone), which is what makes the round trip closed.
#
#   tools/gen_stream_gate.sh
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
loft="${LOFT_BIN:-$(command -v loft || echo /usr/local/bin/loft)}"
src="$here/browser/stores/enschede.roads.store"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
[ -f "$src" ] || { echo "SKIP: no roads store at $src"; exit 2; }

echo "== S6: block → geojsonseq → streamed generator → block =="
emit="$("$loft" --native --lib "$here/lib" "$here/tools/tiles_to_geojsonseq.loft" "$src" "$work/rt.geojsonseq" 2>&1)" \
  || { echo "$emit"; echo "FAIL — could not emit geojsonseq"; exit 1; }
echo "  $(echo "$emit" | grep '^wrote' || true) ($(stat -c%s "$work/rt.geojsonseq") bytes)"

gen="$("$loft" --native --lib "$here/lib" "$here/tools/gen-tiles.loft" "$work/rt.store" "$work/rt.geojsonseq" 2>&1)" \
  || { echo "$gen"; echo "FAIL — the streaming generator did not run"; exit 1; }
echo "$gen" | grep -E '^streamed|^built' | sed 's/^/  /'
echo "$gen" | grep -q '^streamed' || { echo "FAIL — the .geojsonseq input did not take the STREAMING path"; exit 1; }

# Non-vacuity: a generator that produced nothing would sail through a fingerprint comparison of nothing.
tiles="$(echo "$gen" | grep -oP 'tiles=\K[0-9]+' | head -1)"
roads="$(echo "$gen" | grep -oP 'roads=\K[0-9]+' | head -1)"
[ "${tiles:-0}" -ge 50 ] && [ "${roads:-0}" -ge 10000 ] \
  || { echo "FAIL — the regenerated block is too small to prove anything (tiles=$tiles roads=$roads)"; exit 1; }

before="$("$loft" --native --lib "$here/lib" "$here/tools/tile_border_probe.loft" "$src" 2>&1 | grep -oP '^#B \[\d\].*fp=\K\d+' | tr '\n' ' ')"
after="$("$loft" --native --lib "$here/lib" "$here/tools/tile_border_probe.loft" "$work/rt.store" 2>&1 | grep -oP '^#B \[\d\].*fp=\K\d+' | tr '\n' ' ')"
echo "  routes before: $before"
echo "  routes after : $after"
[ -n "$before" ] || { echo "FAIL — no fingerprints from the shipped block"; exit 1; }
if [ "$before" != "$after" ]; then
  echo "FAIL — the regenerated block routes DIFFERENTLY; the streamed input is not equivalent"
  exit 1
fi
echo "PASS — a streamed input rebuilds the block and every route fingerprint is unchanged"
