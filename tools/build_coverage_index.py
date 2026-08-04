#!/usr/bin/env python3
# Copyright (c) 2026 Jurjen Stellingwerff
# SPDX-License-Identifier: LGPL-3.0-or-later
#
# ONE index over the WHOLE coverage — every base and roads store at once, sized for Western Europe.
#
# The per-store `.pagesx` files this replaces had two properties that do not reach a continent:
#
#   1. ONE FILE PER STORE. A viewport is answered by three scales at once (overview, *-mid, a region
#      block) plus roads, so the browser had to open and range-read four indexes to plan one screen.
#      At WE scale that is ~58 regions of the same.
#   2. A DENSE DIRECTORY. `nl-west.base` carried 143 directory slots for 23 non-empty chunks — the body
#      was sparse but the directory was not. Over Europe a regular grid is overwhelmingly ocean and empty
#      land, and the directory becomes the cost.
#
# So this is v3, and the fixes are structural:
#
#   * A QUADTREE, NOT A GRID. Measured density across the Benelux blocks spans 4 to 6 297 cells/deg²
#     — three orders of magnitude — so a uniform grid is either too coarse for Rotterdam or absurdly fine
#     for the North Sea. A tile subdivides only while it holds more than MAX_CELLS, so a chunk is bounded
#     by WORK rather than by area, and `nl-west.base`'s 1 MB worst-case chunk cannot recur.
#   * A SPARSE DIRECTORY of LEAVES ONLY, sorted by key and binary-searched. Empty ocean costs nothing at
#     all: it is simply absent. Directory size tracks data, not extent.
#
# ⚠ AND THE DIRECTORY IS TWO-LEVEL, because a flat one does not reach Western Europe. Projected from
# these blocks, WE is ~2.9M cells and ~16 000 leaves — a flat directory is 252 kB, and it is read WHOLE
# before a single page can be planned, on every session. Split in two it is a ~8 kB root of level-0 tiles
# plus a ~512 B sub-directory for the tile you are actually in.
#
# ⚠ THE STORES ARE FULL URLs, ACROSS ORIGINS. At WE there are ~176 of them — roughly 58 regions × (roads
# + base) plus the derived middle and overview layers — and they live in DIFFERENT REPOSITORIES: the app's
# own site, one Pages repo per base map, and eventually a bucket. The table carries whatever
# `coverage.json` says, absolute or relative, so an index entry can point anywhere without the reader
# knowing or caring. ~19 kB at WE, read once with the header.
#
# Format (little-endian). Offsets are from the start of the file.
#
#   HEADER   magic "LPGX" · version u32=3 · nstores u16 · maxlevel u16 · nroot u32 · ncells u32
#            origin_lo i32 · origin_la i32 · root i32 (level-0 tile size, 1e-7 deg) · nleaf u32
#   STORES   nstores × { page u32 · urlLen u16 · url utf8 · sha256 32B }
#   ROOTDIR  nroot × { rx i16 · ry i16 · subOff u32 · subN u32 · reserved u32 }   sorted by (rx, ry)
#   SUBDIRS  per root tile, subN × { key u64 · off u32 · len u32 }   sorted by key
#            key = level u8 << 56 | x u28 << 28 | y u28
#   CHUNKS   ncells u32, then per cell: store u16 · ox i32 · oy i32 · npages u16 · pages u32[npages]
#
# A viewport therefore costs: the header+stores+rootdir ONCE per session, then one sub-directory and one
# to four chunks per screen — independent of how large the coverage is.
#
#   tools/build_coverage_index.py [out.pagesx] [--max-cells=N]
import json, struct, sys, os, glob

MAGIC = b'LPGX'
VERSION = 3
# ⚠ THE HEADER LENGTH IS DERIVED FROM THE FORMAT, NEVER WRITTEN TWICE. It was a literal 40 beside a
# 36-byte `struct.pack`, so every sub-directory and chunk offset in the file pointed 4 bytes past its
# own data — a whole index that parsed as garbage, and silently: a wrong page number costs bytes, not
# correctness (§5.2), so nothing would have failed loudly. `struct.calcsize` cannot disagree with the
# writer, and `verify()` below re-reads the finished file rather than trusting either.
HDR = '<4sIHHIIiiiI'
# Western Europe's box, so every block's chunks land on the SAME grid and compose without translation.
ORIGIN_LO, ORIGIN_LA = -110000000, 340000000        # -11.0°E, 34.0°N
ROOT = 10000000                                     # 1.0° level-0 tiles
MAX_LEVEL = 12

def verify(path, leaves):
    """Re-read the finished file the way the BROWSER will, and walk every leaf to its last byte.

    The writer computing an offset and the reader trusting it are two different claims, and the 4-byte
    header slip proved they can disagree without anything failing: a chunk read at the wrong offset yields
    plausible nonsense, and a wrong page number only costs bytes. So this parses the file back out of
    `path` — never out of the in-memory structures that produced it — and asserts every leaf's cell count
    and byte length against what was meant to be written. Returns a message on the first disagreement.
    """
    b = open(path, 'rb').read()
    magic, ver, nstores, _maxlevel, nroot, ncells, _olo, _ola, _root, nleaf = struct.unpack_from(HDR, b, 0)
    if magic != MAGIC or ver != VERSION: return f'magic/version: {magic!r} v{ver}'
    o = struct.calcsize(HDR)
    if struct.unpack_from('<H', b, o)[0] != nstores: return 'store table does not start where the header ends'
    o += 2
    for _ in range(nstores):
        _page, ul = struct.unpack_from('<IH', b, o); o += 6 + ul + 32
    seen = 0
    for i in range(nroot):
        _rx, _ry, sub_off, sub_n, _r = struct.unpack_from('<hhIII', b, o + i * 16)
        for j in range(sub_n):
            key, coff, clen = struct.unpack_from('<QII', b, sub_off + j * 16)
            lvl, x, y = key >> 56, (key >> 28) & 0xFFFFFFF, key & 0xFFFFFFF
            want = leaves.get((lvl, x, y))
            if want is None: return f'leaf {(lvl, x, y)} in the directory is not a leaf that was built'
            n = struct.unpack_from('<I', b, coff)[0]
            if n != len(want): return f'leaf {(lvl, x, y)}: {n} cells at offset {coff}, {len(want)} written'
            p = coff + 4
            for _ in range(n):
                _sid, _ox, _oy, np_ = struct.unpack_from('<HiiH', b, p); p += 12 + 4 * np_
            if p != coff + clen: return f'leaf {(lvl, x, y)}: walked to {p}, chunk ends at {coff + clen}'
            seen += n
    if seen != ncells: return f'{seen} cells reachable through the directory, header says {ncells}'
    if nleaf != len(leaves): return f'header says {nleaf} leaves, {len(leaves)} built'
    return None


def main():
    out = 'blocks/coverage.pagesx'
    max_cells = 512
    for a in sys.argv[1:]:
        if a.startswith('--max-cells'): max_cells = int(a.split('=')[1])
        elif not a.startswith('--'): out = a

    cov = json.load(open('browser/coverage.json'))
    url_of, sha_of = {}, {}
    for b in cov['blocks']:
        for k in ('roads', 'base'):
            s = b.get(k)
            if s and s.get('url'):
                url_of[s['url'].split('/')[-1]] = s['url']
                if s.get('sha256'): sha_of[s['url'].split('/')[-1]] = s['sha256']

    stores, cells = [], []          # cells: (ox, oy, store_id, pages)
    for f in sorted(glob.glob('blocks/*.pages.json')):
        d = json.load(open(f))
        xy = d.get('xy')
        if not xy:
            print(f"   skip {os.path.basename(f)} — no coordinates (run tools/add_cell_coords.sh)"); continue
        name = d['block']
        sid = len(stores)
        stores.append({'page': d['page'], 'url': url_of.get(name, f'stores/{name}'), 'sha256': d['sha256']})
        for k, pages in d['cells'].items():
            if k in xy and pages:
                cells.append((xy[k][0], xy[k][1], sid, pages))
    if not cells:
        print('FAIL: no cells — build and coordinate the per-store indexes first'); return 1

    # ⚠ A CELL WEST OR SOUTH OF THE ORIGIN CANNOT BE KEYED, so it is dropped LOUDLY rather than packed.
    # The leaf key is `level << 56 | x << 28 | y` over unsigned tile coordinates; a negative x or y would
    # wrap into another tile's key and hand that tile someone else's pages. Ireland and Portugal are inside
    # the -11°E / 34°N origin, so this should stay at zero — if it ever does not, the ORIGIN moved, and
    # that is a rebuild of every index rather than a cell to skip.
    outside = [c for c in cells if c[0] < ORIGIN_LO or c[1] < ORIGIN_LA]
    if outside:
        print(f'   ⚠ {len(outside)} cell(s) outside the {ORIGIN_LO/1e7:.1f}E/{ORIGIN_LA/1e7:.1f}N origin — DROPPED')
        cells = [c for c in cells if c[0] >= ORIGIN_LO and c[1] >= ORIGIN_LA]

    # Quadtree over the fixed global grid. A tile splits only while it holds more than `max_cells`, so a
    # chunk is bounded by work; empty tiles are never created, so ocean costs nothing.
    def tile_of(ox, oy, level):
        step = ROOT >> level
        return ((ox - ORIGIN_LO) // step, (oy - ORIGIN_LA) // step)

    leaves = {}
    def split(items, level):
        buckets = {}
        for it in items:
            buckets.setdefault(tile_of(it[0], it[1], level), []).append(it)
        for (x, y), grp in buckets.items():
            if len(grp) > max_cells and level < MAX_LEVEL:
                split(grp, level + 1)
            else:
                leaves[(level, x, y)] = grp
    split(cells, 0)

    # Group the leaves under their LEVEL-0 tile, so each root entry owns a self-contained sub-index.
    # Adding a country appends new root tiles and renumbers nothing.
    roots = {}
    for (lvl, x, y), grp in leaves.items():
        step = ROOT >> lvl
        rx, ry = (x * step) // ROOT, (y * step) // ROOT
        roots.setdefault((rx, ry), []).append(((lvl, x, y), grp))

    store_tbl = bytearray(struct.pack('<H', len(stores)))
    for st in stores:
        u = st['url'].encode()
        store_tbl += struct.pack('<IH', st['page'], len(u)) + u + bytes.fromhex(st['sha256'])
    header_len = struct.calcsize(HDR)
    rootdir_len = len(roots) * 16
    subdir_len = sum(len(v) * 16 for v in roots.values())
    base = header_len + len(store_tbl) + rootdir_len + subdir_len

    body, rootents, subblobs = bytearray(), [], bytearray()
    sub_at = header_len + len(store_tbl) + rootdir_len
    for (rx, ry) in sorted(roots):
        entries = sorted(roots[(rx, ry)])
        rootents.append((rx, ry, sub_at + len(subblobs), len(entries)))
        for (lvl, x, y), grp in entries:
            chunk = bytearray(struct.pack('<I', len(grp)))
            for ox, oy, sid, pages in sorted(grp, key=lambda c: (c[2], c[0], c[1])):
                chunk += struct.pack('<HiiH', sid, ox, oy, len(pages))
                chunk += struct.pack(f'<{len(pages)}I', *pages)
            subblobs += struct.pack('<QII', (lvl << 56) | (x << 28) | y, base + len(body), len(chunk))
            body += chunk

    with open(out, 'wb') as f:
        f.write(struct.pack(HDR, MAGIC, VERSION, len(stores), MAX_LEVEL,
                            len(rootents), len(cells), ORIGIN_LO, ORIGIN_LA, ROOT, len(leaves)))
        f.write(store_tbl)
        for rx, ry, o, n in rootents: f.write(struct.pack('<hhIII', rx, ry, o, n, 0))
        f.write(subblobs)
        f.write(body)

    bad = verify(out, leaves)
    if bad:
        print(f'FAIL: {bad}'); return 1

    # ⚠ DOES THIS INDEX DESCRIBE THE DATASET THE SITE PUBLISHES? Each entry carries the sha256 of the
    # block it was recorded against, and the reader refuses a store whose hash disagrees with
    # `coverage.json` (design §5.1) — silently, and correctly, because naming pages into bytes that have
    # moved is the one way an index can do harm. That refusal is invisible at the reader, so the same
    # comparison is made HERE, where it is a line of output instead of a mystery.
    stale = [s['url'].split('/')[-1] for s in stores
             if sha_of.get(s['url'].split('/')[-1], s['sha256']) != s['sha256']]
    missing = sorted(set(sha_of) - {s['url'].split('/')[-1] for s in stores})
    if stale:
        print(f'   ⚠ {len(stale)} store(s) do NOT match coverage.json and will be REFUSED at the reader:')
        for n in stale: print(f'       {n} — re-run tools/build_page_index.sh on the published block')
    if missing:
        print(f'   {len(missing)} published store(s) have no index; they read as they did before one existed:')
        for n in missing: print(f'       {n}')

    sizes = [16 + sum(12 + 4*len(pg) for _, _, _, pg in g) for grp in roots.values() for _, g in grp]
    lv = {}
    for (lvl, _, _) in leaves: lv[lvl] = lv.get(lvl, 0) + 1
    total = os.path.getsize(out)
    print(f'   {out}')
    print(f'     {len(stores)} stores · {len(cells)} cells · {len(leaves)} leaf chunks')
    print(f'     levels: ' + ' '.join(f'L{k}={v}' for k, v in sorted(lv.items())))
    hdr = header_len + len(store_tbl) + rootdir_len
    print(f'     root tiles {len(roots)} · header+stores+rootdir {hdr} B  ← ONE read per SESSION')
    subs = [len(v) * 16 for v in roots.values()]
    print(f'     sub-directory  median {sorted(subs)[len(subs)//2]} B · max {max(subs)} B  ← ONE read per tile')
    print(f'     chunk  min {min(sizes)} · median {sorted(sizes)[len(sizes)//2]} · max {max(sizes)} B')
    print(f'     total  {total/1024:.0f} kB — read by RANGE, never whole')
    return 0

if __name__ == '__main__':
    sys.exit(main())
