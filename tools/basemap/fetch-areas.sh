#!/usr/bin/env bash
# PLAN-BASEMAP S1 — regenerate the "area use" presentation fixture from Overpass for the test bbox.
# The full dump is large + regenerable, so it is gitignored; only the trimmed *.sample.json is committed.
# This is the fixture-equivalent of the production pipeline's second osmium pass (landuse/natural/leisure).
#
#   tools/basemap/fetch-areas.sh                 # → client/basemap/fixtures/real_stretch_areas.json
#   tools/basemap/fetch-areas.sh S,W,N,E out.json
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
bbox="${1:-52.23232,6.87046,52.31858,6.93253}"   # south,west,north,east of fixtures/real_stretch.json + margin
out="${2:-$here/client/basemap/fixtures/real_stretch_areas.json}"
q="[out:json][timeout:120];(way[\"landuse\"]($bbox);way[\"natural\"]($bbox);way[\"leisure\"]($bbox););out geom;"
mkdir -p "$(dirname "$out")"
curl -fsS --max-time 180 -A 'routing-basemap/0.1 (github.com/jjstwerff/routing)' \
  https://overpass-api.de/api/interpreter --data-urlencode "data=$q" -o "$out"
echo "wrote $out ($(wc -c < "$out") bytes)"
echo "classify: loft --interpret client/basemap/areas.loft $out"
