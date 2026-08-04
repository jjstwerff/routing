// Copyright (c) 2026 Jurjen Stellingwerff
// SPDX-License-Identifier: LGPL-3.0-or-later
//
// Read a CHUNKED page index (`.pagesx`) — which 64 kB pages of a store does this viewport need?
//
// The store is read by byte range, and those reads are SERIAL: 764 of them for a cold Amsterdam
// viewport, at ~26 ms each, which is essentially the whole 16-26 s wait (docs/prefetch-index-design.md).
// Knowing the pages ahead of time turns that into one parallel batch — measured 4.79x faster to the same
// map. This is the part that produces the knowing, in the browser.
//
// ⚠ IT READS A VIEWPORT OF THE INDEX, NOT THE INDEX. `nl-east.base`'s index is 7.9 MB whole; fetching
// that to prefetch a 43 MB viewport is an 18% byte overhead and, on a small viewport, costs more than the
// data it saves. Chunked, this reads the header (one range) and the one-to-four chunks the viewport
// covers — ~50-120 kB — so the index pays for itself instead of eating the win.
//
// ⚠ AND THE NEIGHBOURS ARE ARITHMETIC. Chunks are a regular grid over the block's extent, so chunk
// (x, y) is directory slot `y * nx + x` and its neighbours are ±1. Nothing is stored that could disagree
// with the data, and a pan knows where to look with no extra round trip.
//
// The format is written by `tools/chunk_page_index.py`; see its header for the byte layout.

const MAGIC = 0x5847504c;        // "LPGX" little-endian
const HEADER_BYTES = 80;

const cache = new Map();         // store url -> {header, dir, chunks: Map<slot, Map<tkey,cell>>} | null

async function range(url, off, len) {
  const res = await fetch(url, { headers: { Range: `bytes=${off}-${off + len - 1}` } });
  if (!res.ok) throw new Error(`index ${url} range ${off}+${len} -> ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Header + directory in ONE read. Returns null if the block has no index (which must not be fatal). */
async function open(storeUrl) {
  const key = storeUrl.split('?')[0];
  if (cache.has(key)) return cache.get(key);
  let entry = null;
  try {
    const url = `${key}.pagesx`;
    // The header is 80 bytes and the directory follows it; one 64 kB read covers the header plus a
    // directory of up to 8184 chunks, which is far beyond the largest block (342).
    const head = await range(url, 0, 65536);
    const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
    if (dv.getUint32(0, true) !== MAGIC) throw new Error('bad magic');
    const h = {
      url, page: dv.getUint32(8, true), ncells: dv.getUint32(12, true),
      nx: dv.getUint16(16, true), ny: dv.getUint16(18, true),
      mnlo: dv.getInt32(20, true), mnla: dv.getInt32(24, true),
      mxlo: dv.getInt32(28, true), mxla: dv.getInt32(32, true),
      dirlen: dv.getUint32(72, true),
    };
    const dir = [];
    for (let i = 0; i < h.nx * h.ny; i++) {
      const o = HEADER_BYTES + i * 8;
      dir.push([dv.getUint32(o, true), dv.getUint32(o + 4, true)]);
    }
    entry = { h, dir, chunks: new Map(), head };
  } catch {
    entry = null;                // no index, or unreadable — the caller falls back to plain paged reads
  }
  cache.set(key, entry);
  return entry;
}

function parseChunk(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = dv.getUint32(0, true);
  const cells = [];
  let o = 4;
  for (let i = 0; i < n; i++) {
    const ox = dv.getInt32(o + 8, true), oy = dv.getInt32(o + 12, true);
    const np = dv.getUint16(o + 16, true);
    const pages = new Array(np);
    for (let j = 0; j < np; j++) pages[j] = dv.getUint32(o + 18 + j * 4, true);
    cells.push({ ox, oy, pages });
    o += 18 + np * 4;
  }
  return cells;
}

/**
 * The pages `store` needs for `box` — {mnlo, mnla, mxlo, mxla} in fixed-point 1e-7 degrees.
 * Returns [] when there is no index, so the caller simply gets today's behaviour.
 *
 * `pad` widens the CELL test, not the chunk test: a feature is keyed by its FIRST VERTEX and never
 * clipped, so it can overhang its cell (PLAN-PERF §7g measured up to 16 cells). Missing such a page is
 * not an error — the read falls through to a normal fetch — so this errs small rather than fetching the
 * block.
 */
export async function pagesFor(storeUrl, box, pad = 0) {
  const ix = await open(storeUrl);
  if (!ix) return [];
  const { h, dir } = ix;
  const spanx = Math.max(1, h.mxlo - h.mnlo + 1), spany = Math.max(1, h.mxla - h.mnla + 1);
  const cx0 = Math.max(0, Math.min(h.nx - 1, Math.floor((box.mnlo - pad - h.mnlo) * h.nx / spanx)));
  const cx1 = Math.max(0, Math.min(h.nx - 1, Math.floor((box.mxlo + pad - h.mnlo) * h.nx / spanx)));
  const cy0 = Math.max(0, Math.min(h.ny - 1, Math.floor((box.mnla - pad - h.mnla) * h.ny / spany)));
  const cy1 = Math.max(0, Math.min(h.ny - 1, Math.floor((box.mxla + pad - h.mnla) * h.ny / spany)));

  const want = [];
  for (let y = cy0; y <= cy1; y++) for (let x = cx0; x <= cx1; x++) want.push(y * h.nx + x);

  // Chunks not already held are fetched CONCURRENTLY — the same reason the pages are.
  const missing = want.filter((s) => !ix.chunks.has(s) && dir[s] && dir[s][1] > 0);
  await Promise.all(missing.map(async (s) => {
    try { ix.chunks.set(s, parseChunk(await range(h.url, dir[s][0], dir[s][1]))); }
    catch { ix.chunks.set(s, []); }
  }));

  const out = new Set();
  for (const s of want) {
    for (const c of ix.chunks.get(s) || []) {
      if (c.ox < box.mnlo - pad || c.ox > box.mxlo + pad) continue;
      if (c.oy < box.mnla - pad || c.oy > box.mxla + pad) continue;
      for (const p of c.pages) out.add(p);
    }
  }
  return [...out];
}

/** Which stores have a usable index — for gates and probes to assert on rather than infer. */
export function indexStats() {
  const o = {};
  for (const [k, v] of cache) {
    o[k.split('/').pop()] = v ? { cells: v.h.ncells, grid: `${v.h.nx}x${v.h.ny}`, chunksHeld: v.chunks.size } : null;
  }
  return o;
}
