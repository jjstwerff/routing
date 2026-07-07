# Copyright (c) 2026 Jurjen Stellingwerff
# SPDX-License-Identifier: LGPL-3.0-or-later
#
# geojson2overpass — convert osmium's GeoJSON-seq way export into the Overpass-JSON shape that
# routing_kernel::parse_ways (and tools/gen-tiles.loft) consume:
#   {"elements":[{"type":"way","tags":{...},"geometry":[{"lat":..,"lon":..},...]},...]}
# Usage: python3 tools/geojson2overpass.py <roads.geojsonseq> <overpass.json>
# See HANDOFF.md / PLAN-APP §11 for the full pipeline (Geofabrik .pbf -> osmium -> here -> gen-tiles).
import json, sys
inp, out = sys.argv[1], sys.argv[2]
n = 0
with open(inp, 'rb') as f, open(out, 'w') as o:
    o.write('{"elements":[')
    first = True
    for raw in f:
        raw = raw.strip(b'\x1e').strip()
        if not raw: continue
        try: feat = json.loads(raw)
        except Exception: continue
        geom = feat.get('geometry') or {}
        if geom.get('type') != 'LineString': continue
        coords = geom.get('coordinates') or []
        if len(coords) < 2: continue
        el = {"type": "way",
              "tags": feat.get('properties', {}) or {},
              "geometry": [{"lat": c[1], "lon": c[0]} for c in coords]}
        if not first: o.write(',')
        first = False
        o.write(json.dumps(el, separators=(',', ':')))
        n += 1
    o.write(']}')
print("wrote", n, "ways")
