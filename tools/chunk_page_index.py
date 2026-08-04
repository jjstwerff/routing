#!/usr/bin/env python3
# Copyright (c) 2026 Jurjen Stellingwerff
# SPDX-License-Identifier: LGPL-3.0-or-later
#
# Chunk a page index so the browser reads a VIEWPORT of it, not the whole thing.
#
# ⚠ WHY THIS IS NOT AN OPTIMISATION BUT A REQUIREMENT. `nl-east.base`'s index is 7.9 MB. Fetching 7.9 MB
# to prefetch a 43 MB viewport is an 18% byte overhead, and for a small viewport it costs more than the
# data it saves — a monolithic index on a big block is self-defeating. Chunked, a viewport reads the
# header plus one or two chunks: two round trips and a few tens of kB.
#
# ⚠ AND THE NEIGHBOURS COME FREE. The chunks are a REGULAR GRID over the block's extent, so chunk (x, y)
# is at directory slot `y * nx + x` and its four neighbours are that arithmetic ±1 — no stored pointers,
# no spatial key encoding, nothing that can disagree with the data. The directory is ~8 bytes per chunk
# (338 chunks for the largest block = 2.7 kB), so it rides along in the header's single read.
#
# Layout, little-endian throughout:
#
#   HEADER    magic "LPGX" · version u32 · page u32 · ncells u32 · nx u16 · ny u16
#             extent mnlo/mnla/mxlo/mxla i32 (1e-7 deg) · sha256 32B · ndir u32
#   DIRECTORY nx*ny × (offset u32, length u32)          ← empty chunks are (0, 0)
#   CHUNKS    ncells u32, then per cell:
#             tkey u64 · ox i32 · oy i32 · npages u16 · pages u32[npages]
#
#   tools/chunk_page_index.py <index.pages.json> [out.pagesx] [--target-cells N]
import json, struct, sys, os, hashlib

MAGIC = b'LPGX'
VERSION = 1

def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    target = 256
    for a in sys.argv[1:]:
        if a.startswith('--target-cells'): target = int(a.split('=')[1])
    if not args:
        print('usage: chunk_page_index.py <index.pages.json> [out.pagesx] [--target-cells=N]'); return 2
    src = args[0]
    out = args[1] if len(args) > 1 else src.replace('.pages.json', '.pagesx')
    d = json.load(open(src))
    cells, xy = d['cells'], d.get('xy') or {}
    if not xy:
        print(f'FAIL: {src} has no `xy` — run tools/add_cell_coords.sh first, or the browser cannot'
              ' locate a chunk by viewport'); return 1

    keys = [k for k in cells if k in xy]
    xs = [xy[k][0] for k in keys]; ys = [xy[k][1] for k in keys]
    mnlo, mxlo, mnla, mxla = min(xs), max(xs), min(ys), max(ys)
    # A square-ish grid sized so a chunk holds ~`target` cells. Cells are not uniformly dense, so this is
    # an average — the point is bounding the READ, not equalising the chunks.
    nchunks = max(1, round(len(keys) / target))
    nx = max(1, int(nchunks ** 0.5)); ny = max(1, (nchunks + nx - 1) // nx)
    spanx = max(1, mxlo - mnlo + 1); spany = max(1, mxla - mnla + 1)

    buckets = {}
    for k in keys:
        x, y = xy[k]
        cx = min(nx - 1, (x - mnlo) * nx // spanx)
        cy = min(ny - 1, (y - mnla) * ny // spany)
        buckets.setdefault(cy * nx + cx, []).append(k)

    dirsize = nx * ny * 8
    header = struct.pack('<4sIIIHHiiii32sI', MAGIC, VERSION, d['page'], len(keys), nx, ny,
                         mnlo, mnla, mxlo, mxla, bytes.fromhex(d['sha256']), dirsize)
    body, directory = bytearray(), []
    base = len(header) + dirsize
    for slot in range(nx * ny):
        ks = buckets.get(slot)
        if not ks:
            directory.append((0, 0)); continue
        off = base + len(body)
        chunk = bytearray(struct.pack('<I', len(ks)))
        for k in sorted(ks, key=int):
            pg = cells[k]
            chunk += struct.pack('<QiiH', int(k), xy[k][0], xy[k][1], len(pg))
            chunk += struct.pack(f'<{len(pg)}I', *pg)
        body += chunk
        directory.append((off, len(chunk)))

    with open(out, 'wb') as f:
        f.write(header)
        for off, ln in directory: f.write(struct.pack('<II', off, ln))
        f.write(body)

    used = [l for _, l in directory if l]
    total = os.path.getsize(out)
    print(f'   {os.path.basename(out)}')
    print(f'     {len(keys)} cells · grid {nx}x{ny} = {nx*ny} chunks ({len(used)} non-empty)')
    print(f'     header+directory {len(header)+dirsize} B   ← ONE read locates any chunk')
    print(f'     chunk size  min {min(used)} · median {sorted(used)[len(used)//2]} · max {max(used)} B')
    print(f'     total {total} B vs {os.path.getsize(src)} B of JSON  ({total/os.path.getsize(src)*100:.0f}%)')
    worst = len(header) + dirsize + max(used) * 4
    print(f'     a viewport reads ~{(len(header)+dirsize+sorted(used)[len(used)//2]*4)/1024:.1f} kB '
          f'(header + 4 chunks), worst {worst/1024:.1f} kB — against {os.path.getsize(src)/1024:.0f} kB whole')
    return 0

if __name__ == '__main__':
    sys.exit(main())
