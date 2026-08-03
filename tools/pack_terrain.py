#!/usr/bin/env python3
# Copyright (c) 2026 Jurjen Stellingwerff
# SPDX-License-Identifier: LGPL-3.0-or-later
"""Pack a terrarium PNG cache into ONE flat height grid (PLAN-RESTORE R2).

WHY A PACK STEP EXISTS. `tools/gen_heights.loft` has to sample a height for every stored step — tens of
millions of them — while it holds a bound store open. Decoding PNGs inside that program means holding a
tile cache beside the store and mixing the imaging library into the one program that binds a block; the
first attempt at exactly that died in the loft runtime (`find called on non-collection type: Pixel`,
src/database/search.rs) before it sampled anything. Packing first makes the sampler a seek and a two-byte
read with no cache, no hash and no image decoding at all — which is both simpler and the reason it works.

It is also the cheaper shape. The pack is a pure function of the terrain cache, so it survives every OSM
refresh: terrain does not change between snapshots, and a re-run of the whole pipeline pays for it once.

FORMAT (little-endian throughout):

    magic   4 bytes  "LTH1"
    zoom    i32      slippy zoom the grid is sampled at
    x0, y0  i32 i32  NW tile of the covered range
    cols    i32      tiles east
    rows    i32      tiles south
    present cols*rows bytes    1 = that tile was in the cache, 0 = it was not
    data    cols*rows tiles, row-major, each 256*256 int16 metres, row-major from the tile's NW corner

A missing tile still occupies its slot, so an offset is pure arithmetic. `present` is what distinguishes
"no data here" from "sea level" — the Netherlands is full of legitimate zeroes, so a zero sentinel would
have silently reported the whole country as flat and correct.

    tools/pack_terrain.py <terrain-dir> <zoom> <min_lon,min_lat,max_lon,max_lat> <out.hgt>
"""
import math
import os
import struct
import sys

TILE_PX = 256
HEADER = struct.Struct("<4s5i")


def tile_x(lon: float, n: int) -> int:
    return int((lon + 180.0) / 360.0 * n)


def tile_y(lat: float, n: int) -> int:
    r = math.radians(lat)
    return int((1.0 - math.log(math.tan(r) + 1.0 / math.cos(r)) / math.pi) / 2.0 * n)


def main() -> int:
    if len(sys.argv) < 5:
        print(__doc__.strip().splitlines()[-1].strip(), file=sys.stderr)
        return 2
    tdir, zoom, bbox, out = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4]
    mnlo, mnla, mxlo, mxla = (float(v) for v in bbox.split(","))

    n = 2 ** zoom
    x0, x1 = tile_x(mnlo, n), tile_x(mxlo, n)
    y0, y1 = tile_y(mxla, n), tile_y(mnla, n)      # y grows SOUTH: max lat is the smallest row
    cols, rows = x1 - x0 + 1, y1 - y0 + 1
    total = cols * rows

    print(f"== packing z{zoom} x {x0}..{x1} ({cols}) y {y0}..{y1} ({rows}) = {total} tiles")
    if os.path.exists(out):
        # Same rule as every store tool here: refuse an existing target rather than half-overwrite one.
        print(f"FAIL: {out} already exists — remove it first", file=sys.stderr)
        return 1

    # PIL is imported here rather than at module top so the usage message works without it installed.
    from PIL import Image

    present = bytearray(total)
    blank = b"\x00\x00" * (TILE_PX * TILE_PX)
    got = 0
    with open(out, "wb") as fh:
        fh.write(HEADER.pack(b"LTH1", zoom, x0, y0, cols, rows))
        fh.write(bytes(present))                    # placeholder, rewritten once the count is known
        for row in range(rows):
            for col in range(cols):
                path = os.path.join(tdir, str(zoom), str(x0 + col), f"{y0 + row}.png")
                if not os.path.exists(path) or os.path.getsize(path) == 0:
                    fh.write(blank)
                    continue
                try:
                    img = Image.open(path).convert("RGB")
                except Exception as exc:                       # a truncated download, not a crash
                    print(f"  skip {path}: {exc}", file=sys.stderr)
                    fh.write(blank)
                    continue
                if img.size != (TILE_PX, TILE_PX):
                    print(f"  skip {path}: {img.size}", file=sys.stderr)
                    fh.write(blank)
                    continue
                # terrarium: h = r*256 + g + b/256 - 32768. The fractional b term is dropped — the store
                # keeps whole metres, and b/256 is at most 0.996 m against a 23 m ground sample.
                px = img.tobytes()
                fh.write(struct.pack(
                    f"<{TILE_PX * TILE_PX}h",
                    *[(px[i] << 8) + px[i + 1] - 32768 for i in range(0, len(px), 3)]))
                present[row * cols + col] = 1
                got += 1
            if rows > 8 and row % max(1, rows // 8) == 0:
                print(f"   row {row}/{rows} ({got} tiles)", flush=True)
        fh.seek(HEADER.size)
        fh.write(bytes(present))

    size = os.path.getsize(out)
    print(f"   {got}/{total} tiles present -> {out} ({size / 1e6:.1f} MB)")
    if got == 0:
        # An empty pack is a failure, not an empty result: the sampler downstream would fill no heights,
        # and it would discover that only after loading a gigabyte-sized block.
        print("FAIL: no terrain tiles were found — is the cache filled for this zoom?", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
