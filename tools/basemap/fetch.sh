#!/usr/bin/env bash
# PLAN-BASEMAP — regenerate a presentation fixture from Overpass for the test bbox. One dataset per
# feature kind; the fixture-equivalent of the production pipeline's second osmium pass. The large dumps
# (areas, buildings) are gitignored + regenerable; the small ones (places, streets) are committed whole.
#
#   tools/basemap/fetch.sh <areas|places|streets|buildings> [S,W,N,E] [out.json]
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
kind="${1:?usage: fetch.sh <areas|places|streets|buildings> [bbox] [out.json]}"
bbox="${2:-52.23232,6.87046,52.31858,6.93253}"   # south,west,north,east of fixtures/real_stretch.json + margin
out="${3:-$here/client/basemap/fixtures/real_stretch_${kind}.json}"

case "$kind" in
  areas)     sel="way[\"landuse\"]($bbox);way[\"natural\"]($bbox);way[\"leisure\"]($bbox);"; mode="geom" ;;
  places)    sel="node[\"place\"]($bbox);";                                                  mode=""     ;;  # nodes carry lat/lon inline
  streets)   sel="way[\"highway\"][\"name\"]($bbox);";                                       mode="geom" ;;
  buildings) sel="way[\"building\"]($bbox);";                                                mode="geom" ;;
  *) echo "unknown kind: $kind (areas|places|streets|buildings)"; exit 1 ;;
esac
q="[out:json][timeout:120];($sel);out ${mode};"
ua='routing-basemap/0.1 (github.com/jjstwerff/routing)'
mkdir -p "$(dirname "$out")"

# Overpass mirrors — the main endpoint 504s under load; fall through to others.
for ep in https://overpass-api.de/api/interpreter https://overpass.kumi.systems/api/interpreter https://maps.mail.ru/osm/tools/overpass/api/interpreter; do
  if curl -fsS --max-time 180 -A "$ua" "$ep" --data-urlencode "data=$q" -o "$out" 2>/dev/null && [ -s "$out" ]; then
    echo "wrote $out ($(wc -c < "$out") bytes) via $ep"; exit 0
  fi
  sleep 3
done
echo "FAILED: all Overpass mirrors errored for kind=$kind" >&2; exit 1
