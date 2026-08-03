#!/usr/bin/env bash
# Copyright (c) 2026 Jurjen Stellingwerff
# SPDX-License-Identifier: LGPL-3.0-or-later
#
# FILL THE TERRAIN CACHE for a bounding box — terrarium PNGs, fetched ONCE on the build machine
# (PLAN-RESTORE R2).
#
# This is the only place in the pipeline that talks to a terrain service, and it is deliberately a
# separate step from the sampler: `tools/gen_heights.loft` never reaches the network, so a block either
# has the terrain it needs on disk or reports how many tiles it was missing. The app never fetches
# terrain at all — that was the old server's model, and it is what R2 replaces.
#
#   tools/fetch-terrain.sh <min_lon,min_lat,max_lon,max_lat> [zoom] [dir]
#
# ZOOM — the one parameter worth thinking about, and it is cheaper to change than it looks:
#
#   z12   ~23.5 m per sample at 52°N    the Netherlands is ~3 950 tiles, ~0.3 GB
#   z13   ~11.8 m per sample            ~15 800 tiles, ~1.3 GB
#
# ⚠ THE BLOCK IS THE SAME SIZE EITHER WAY. `TStep.h` already exists and already costs its four bytes, so
# the resolution trades GENERATION time against how sharp a gradient the router can see — it does not
# trade against what a visitor downloads. PLAN-RESTORE §5 lists the choice as the maintainer's; z12 is the
# default because it is ten minutes instead of an hour and the Netherlands has no 12% ramps to miss.
# A hillier country is the reason to raise it.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

bbox="${1:-}"
zoom="${2:-${TERRAIN_ZOOM:-12}}"
dir="${3:-${TERRAIN_DIR:-$HOME/.cache/routing-terrain}}"
url="${TERRAIN_URL:-https://s3.amazonaws.com/elevation-tiles-prod/terrarium}"
jobs="${TERRAIN_JOBS:-8}"

[ -n "$bbox" ] || { sed -n '/^#   tools\/fetch-terrain.sh/,/^# A hillier/p' "$0" | sed 's/^# \?//'; exit 2; }

IFS=, read -r mnlo mnla mxlo mxla <<<"$bbox"
[ -n "${mxla:-}" ] || { echo "FAIL: bbox must be min_lon,min_lat,max_lon,max_lat" >&2; exit 2; }

# Slippy-map tile range for the box. Same arithmetic as routing_kernel's tile_xf/tile_yf — y grows SOUTH,
# so the northernmost latitude gives the SMALLEST row.
read -r x0 x1 y0 y1 <<<"$(awk -v mnlo="$mnlo" -v mxlo="$mxlo" -v mnla="$mnla" -v mxla="$mxla" -v z="$zoom" '
  function tx(lon, n) { return int((lon + 180.0) / 360.0 * n) }
  function ty(lat, n,   r) { r = lat * 3.14159265358979 / 180.0
                             return int((1.0 - log((sin(r)/cos(r)) + (1.0/cos(r))) / 3.14159265358979) / 2.0 * n) }
  BEGIN { n = 2 ^ z; print tx(mnlo, n), tx(mxlo, n), ty(mxla, n), ty(mnla, n) }')"

cols=$((x1 - x0 + 1)); rows=$((y1 - y0 + 1)); want=$((cols * rows))
echo "== terrain z$zoom for $bbox =="
echo "   x $x0..$x1 ($cols)  y $y0..$y1 ($rows)  =  $want tiles  ->  $dir/$zoom"
mkdir -p "$dir/$zoom"

# Only what is not already on disk. A refresh re-runs this and pays for nothing it already has — terrain
# does not change between OSM snapshots, which is the whole reason this cache is worth keeping.
todo="$(mktemp)"
for x in $(seq "$x0" "$x1"); do
  mkdir -p "$dir/$zoom/$x"
  for y in $(seq "$y0" "$y1"); do
    [ -s "$dir/$zoom/$x/$y.png" ] || printf '%s\t%s\n' "$x" "$y" >> "$todo"
  done
done
n="$(wc -l < "$todo")"
echo "   $((want - n)) already cached, $n to fetch"

if [ "$n" -gt 0 ]; then
  # ⚠ `-f` so a 4xx becomes a failure instead of an HTML error page saved as a .png, and the partial file
  # is removed — `gen_heights` would otherwise read it as a corrupt tile forever. `--retry` covers the
  # transient S3 5xx that shows up a few times in a run of thousands.
  export dir zoom url
  # shellcheck disable=SC2016
  if ! xargs -P "$jobs" -n2 -a "$todo" sh -c '
        out="$dir/$zoom/$1/$2.png"
        curl -fsS --retry 3 --retry-delay 1 -o "$out" "$url/$zoom/$1/$2.png" || { rm -f "$out"; echo "MISS $zoom/$1/$2" >&2; }
      ' _ 2>"$todo.err"; then
    echo "  (some fetches reported failures)"
  fi
  # ⚠ `|| true`, not `|| echo 0`. `grep -c` PRINTS 0 and EXITS 1 when it matches nothing, so the `||`
  # branch fires on the success case and appends a second 0 — making `$miss` the two-line string "0\n0",
  # which is neither equal to 0 nor a number. It reported failures on every clean run.
  miss="$(grep -c '^MISS' "$todo.err" 2>/dev/null || true)"
  miss="${miss:-0}"
  [ "$miss" = 0 ] || { echo "   $miss tile(s) could not be fetched:"; head -5 "$todo.err" | sed 's/^/     /'; }
fi
rm -f "$todo" "$todo.err"

have="$(find "$dir/$zoom" -name '*.png' -size +0 | wc -l)"
echo "   $have tile(s) in $dir/$zoom, $(du -sh "$dir/$zoom" | cut -f1)"
# A cache with nothing in it is a failure, not an empty result — the sampler downstream would fill no
# heights and say so, but it would say so after loading a gigabyte-sized block.
[ "$have" -gt 0 ] || { echo "FAIL: no terrain tiles fetched" >&2; exit 1; }
