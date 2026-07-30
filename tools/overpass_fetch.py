#!/usr/bin/env python3
# Copyright (c) 2026 Jurjen Stellingwerff
# SPDX-License-Identifier: LGPL-3.0-or-later
#
# Fetch a region's highways from Overpass and write `geojsonseq` — the form the generator STREAMS
# (PLAN-SCALE S6). No local OSM tooling: a `.osm.pbf` stores ways as node REFERENCES, and something must
# join those to coordinates; `out geom;` makes Overpass do that join server-side.
#
# CHUNKED, because that join is what costs the server: one province-sized query is a large response held
# in Overpass's memory, while a grid of small ones is ordinary traffic. Chunks also make the fetch
# RESUMABLE — each is cached on disk and skipped on a re-run, so an interrupted region continues.
#
# Ways are emitted once per chunk they appear in; a way crossing a chunk border therefore arrives twice.
# That is harmless for the generator (a duplicate way bins to the same tile and the matcher dedups nodes
# by coordinate) but it is wasteful, so the writer drops repeats by OSM id across the whole region.
#
#   tools/overpass_fetch.py <out.geojsonseq> <S,W,N,E> [--step 0.2] [--cache DIR]
import json, os, sys, time, urllib.parse, urllib.request

TAGS = ["highway", "surface", "tracktype", "bicycle", "access", "oneway",
        "oneway:bicycle", "service", "cycleway", "cyclestreet", "name"]
ENDPOINTS = ["https://overpass-api.de/api/interpreter",
             "https://overpass.kumi.systems/api/interpreter"]


def fetch_chunk(s, w, n, e, cache, attempt_log):
    key = f"{s:.3f}_{w:.3f}_{n:.3f}_{e:.3f}.json"
    path = os.path.join(cache, key)
    if os.path.exists(path) and os.path.getsize(path) > 0:
        return path, True
    q = f'[out:json][timeout:180];way["highway"]({s},{w},{n},{e});out geom;'
    data = urllib.parse.urlencode({"data": q}).encode()
    for i, ep in enumerate(ENDPOINTS * 3):          # each endpoint up to 3 times, alternating
        try:
            with urllib.request.urlopen(urllib.request.Request(ep, data=data), timeout=300) as r:
                body = r.read()
            # A truncated or error response is valid JSON often enough to be worth parsing here rather
            # than three steps later, where it looks like missing data instead of a failed fetch.
            json.loads(body)
            with open(path, "wb") as f:
                f.write(body)
            return path, False
        except Exception as ex:                      # noqa: BLE001 — any failure is a retry
            attempt_log.append(f"{ep.split('/')[2]}: {type(ex).__name__}")
            time.sleep(5 + 5 * i)
    return None, False


def main():
    if len(sys.argv) < 3:
        print(__doc__.strip().splitlines()[-1]); sys.exit(2)
    out_path = sys.argv[1]
    s, w, n, e = (float(x) for x in sys.argv[2].split(","))
    step = float(sys.argv[sys.argv.index("--step") + 1]) if "--step" in sys.argv else 0.2
    cache = sys.argv[sys.argv.index("--cache") + 1] if "--cache" in sys.argv else \
        os.path.expanduser("~/.cache/routing-overpass")
    os.makedirs(cache, exist_ok=True)

    boxes = []
    la = s
    while la < n - 1e-9:
        lo = w
        while lo < e - 1e-9:
            boxes.append((la, lo, min(la + step, n), min(lo + step, e)))
            lo += step
        la += step
    print(f"region {s},{w},{n},{e} → {len(boxes)} chunk(s) of {step}°", flush=True)

    seen = set()
    ways = coords = dropped = cached = 0
    with open(out_path, "w") as out:
        for i, (bs, bw, bn, be) in enumerate(boxes, 1):
            log = []
            path, was_cached = fetch_chunk(bs, bw, bn, be, cache, log)
            if not path:
                print(f"  [{i}/{len(boxes)}] FAILED {bs},{bw},{bn},{be} — {'; '.join(log[-3:])}", flush=True)
                sys.exit(1)
            cached += 1 if was_cached else 0
            with open(path) as f:
                doc = json.load(f)
            got = 0
            for el in doc.get("elements", []):
                if el.get("type") != "way" or "geometry" not in el:
                    continue
                if el["id"] in seen:
                    dropped += 1
                    continue
                seen.add(el["id"])
                geom = [[g["lon"], g["lat"]] for g in el["geometry"]]
                if len(geom) < 2:
                    continue
                tags = el.get("tags", {})
                props = {k: tags[k] for k in TAGS if k in tags}
                out.write(json.dumps({"type": "Feature", "properties": props,
                                      "geometry": {"type": "LineString", "coordinates": geom}},
                                     separators=(",", ":")) + "\n")
                ways += 1
                coords += len(geom)
                got += 1
            print(f"  [{i}/{len(boxes)}] {bs:.2f},{bw:.2f} {'cache' if was_cached else 'fetch'} "
                  f"{os.path.getsize(path)//1024} KB → {got} new ways", flush=True)

    print(f"wrote {out_path}: {ways} ways / {coords} coords "
          f"({dropped} cross-chunk duplicates dropped, {cached}/{len(boxes)} chunks from cache)")


if __name__ == "__main__":
    main()
