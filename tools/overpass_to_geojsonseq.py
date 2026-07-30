#!/usr/bin/env python3
# Copyright (c) 2026 Jurjen Stellingwerff
# SPDX-License-Identifier: LGPL-3.0-or-later
#
# One Overpass JSON document → `geojsonseq`, the form the base generator STREAMS (PLAN-SCALE S6).
#
# It exists for the parity gate: the same layer, read both ways, must bin to the same tiles. Converting
# the fixtures rather than fetching new data keeps the comparison exact — same features, same order, only
# the reader differs. (For real regions, `osmium export -f geojsonseq` produces this directly.)
#
# Emits the RFC 8142 record separator that osmium emits, so the gate exercises the shape the real producer
# writes rather than a convenient one — that omission is what let 2.78 M features parse as nothing.
#
#   tools/overpass_to_geojsonseq.py <in.json> <out.geojsonseq>
import json, sys

src, dst = sys.argv[1], sys.argv[2]
doc = json.load(open(src))
n = 0
with open(dst, "w") as out:
    for el in doc.get("elements", []):
        tags = el.get("tags", {})
        if el.get("type") == "node" and "lat" in el:
            geom = {"type": "Point", "coordinates": [el["lon"], el["lat"]]}
        elif "geometry" in el:
            geom = {"type": "LineString", "coordinates": [[g["lon"], g["lat"]] for g in el["geometry"]]}
        else:
            continue
        out.write("\x1e" + json.dumps({"type": "Feature", "properties": tags, "geometry": geom},
                                      separators=(",", ":")) + "\n")
        n += 1
print(f"{src} → {dst}: {n} features")
