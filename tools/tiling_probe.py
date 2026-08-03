#!/usr/bin/env python3
# Copyright (c) 2026 Jurjen Stellingwerff
# SPDX-License-Identifier: LGPL-3.0-or-later
"""What cells would this source claim, and what would its blocks cost? — WITHOUT building a store.

WHY. Answering "do two countries overlap?" and "how many regions does this need?" currently costs a full
`gen-tiles` run: 50 minutes and 1.8 GB of RSS for Benelux, and the input grows several times again for
France or Germany (plans/51). But neither question needs a store:

  * **Disjointness** is a property of the CELL SET. A feature is keyed at its FIRST VERTEX
    (PLAN-PERF §7g), so the cell it claims is one `floordiv` on that one coordinate.
  * **Sizing** is a property of DENSITY. A block's bytes track its feature and coordinate counts, and
    both are countable in the same pass.

So this streams the geojsonseq the pipeline already produces and emits the cell set plus the counts. One
pass, constant memory apart from the cell set itself, no loft, no store.

    tools/tiling_probe.py <in.geojsonseq> <out.cells>      # writes sorted cell keys, prints the summary

Then two sources overlap iff their cell files intersect:

    comm -12 a.cells b.cells | wc -l

and a longitude cut's cost is read straight off the per-band histogram it prints.

⚠ IT ANSWERS ABOUT THE TILING, NOT ABOUT THE BLOCK. It cannot tell you a route is correct or that a
category survived — `conservation_gate` and `block_overlap_gate` still own those, on real blocks. This is
the cheap screen you run BEFORE committing an hour of CPU, not a replacement for the gate.
"""
import json
import sys
from collections import defaultdict

# Must match routing_kernel's packing exactly, or the cells this reports are not the cells the generator
# will produce. Imported by value rather than re-derived: `cell_ix` is floordiv, and Python's `//` is
# already floor for negatives, which is the case that made the loft version collide west of Greenwich.
TILE_CELL = 200_000          # 0.02 deg in 1e-7 fixed point
BIAS_X, BIAS_Y, TKEY_ROW = 9001, 4501, 18003


def cell_key(lon_deg: float, lat_deg: float) -> int:
    tx = int(round(lon_deg * 1e7)) // TILE_CELL
    ty = int(round(lat_deg * 1e7)) // TILE_CELL
    return (ty + BIAS_Y) * TKEY_ROW + (tx + BIAS_X)


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__.strip().splitlines()[-8].strip(), file=sys.stderr)
        return 2
    src, out = sys.argv[1], sys.argv[2]

    cells = set()
    feats = coords = skipped = 0
    band_f = defaultdict(int)     # features per 0.1 deg longitude band
    band_c = defaultdict(int)     # coordinates per band — the better size predictor
    mnlo = mnla = 1e9
    mxlo = mxla = -1e9

    with open(src, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.lstrip("\x1e").strip()
            if not line:
                continue
            try:
                f = json.loads(line)
            except Exception:
                skipped += 1
                continue
            g = f.get("geometry") or {}
            c = g.get("coordinates")
            if not c:
                continue
            t = g.get("type")
            # The FIRST VERTEX is what decides the cell — the rule the whole tiling rests on.
            if t == "Point":
                first, n = c, 1
            elif t == "LineString":
                first, n = c[0], len(c)
            elif t == "Polygon":
                first, n = c[0][0], sum(len(r) for r in c)
            elif t == "MultiPolygon":
                first, n = c[0][0][0], sum(len(r) for p in c for r in p)
            else:
                continue
            lon, lat = float(first[0]), float(first[1])
            cells.add(cell_key(lon, lat))
            feats += 1
            coords += n
            b = int(lon * 10)
            band_f[b] += 1
            band_c[b] += n
            mnlo = min(mnlo, lon); mxlo = max(mxlo, lon)
            mnla = min(mnla, lat); mxla = max(mxla, lat)

    with open(out, "w", encoding="utf-8") as fh:
        for k in sorted(cells):
            fh.write(f"{k}\n")

    print(f"  features {feats}  coords {coords}  cells {len(cells)}"
          + (f"  (skipped {skipped} unparsable)" if skipped else ""))
    print(f"  extent   lon {mnlo:.4f}..{mxlo:.4f}  lat {mnla:.4f}..{mxla:.4f}")
    print(f"  cells    -> {out}")
    # The histogram is what a region cut is chosen from: coordinates per 0.1 deg of longitude, cumulative,
    # so an even split by COST (not by width) can be read straight off it.
    tot = sum(band_c.values()) or 1
    run = 0
    marks = [0.20, 0.40, 0.60, 0.80]
    mi = 0
    print("  even-cost cuts (cumulative coordinate share by longitude):")
    for b in sorted(band_c):
        run += band_c[b]
        while mi < len(marks) and run / tot >= marks[mi]:
            print(f"     {marks[mi]*100:3.0f}%  at lon {(b + 1) / 10:.1f}")
            mi += 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
