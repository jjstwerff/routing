// Copyright (c) 2026 Jurjen Stellingwerff
// SPDX-License-Identifier: LGPL-3.0-or-later
//
// Read the COVERAGE page index (`coverage.pagesx`, v3) — which 64 kB pages of which store does this
// viewport need?
//
// The store is read by byte range, and those reads are SERIAL: 764 of them for a cold Amsterdam
// viewport, at ~26 ms each, which is essentially the whole 16-26 s wait (docs/prefetch-index-design.md).
// Knowing the pages ahead of time turns that into one parallel batch — measured 4.79x faster to the same
// map. This is the part that produces the knowing, in the browser.
//
// ⚠ ONE INDEX OVER EVERY STORE, NOT ONE PER STORE. A single viewport is answered by three scales at once
// (overview, a `*-mid` layer, a region block) plus roads, so the per-store `.pagesx` this replaces made
// the browser open and range-read four separate indexes to plan ONE screen — and at Western Europe scale
// that is ~58 regions of the same. Here the four stores' pages come out of the SAME chunk, so the second,
// third and fourth `pagesFor` of a view fetch nothing at all.
//
// ⚠ AND IT IS READ BY RANGE, NEVER WHOLE. The index is 2.6 MB for the Benelux and projects to ~97 MB at
// WE; fetching that to prefetch a 43 MB viewport would eat the win whole. A session pays:
//
//   header + store table + root directory   ONCE      ~1.4 kB   (Benelux; ~27 kB projected at WE)
//   a sub-directory                         per tile  ~160 B
//   one to four leaf chunks                 per view  ~6 kB each
//
// which is independent of how large the coverage is — that is the property the two-level directory and
// the quadtree exist for, and it is why this reader never grows a "load the index" step.
//
// The format is written by `tools/build_coverage_index.py`; see its header for the byte layout and for
// why the leaves are a quadtree rather than a grid.
//
// ⚠ NOTHING HERE CAN MAKE THE MAP WRONG. A page number is a fetch HINT: the bytes still come from the
// store, at the offset the kernel asked for, and are still verified by loft's loader. A missing entry
// falls through to a normal ranged read (§5.2), so the worst an index can do is fail to save time — with
// ONE exception, which is why `configureIndex` takes hashes: an index built against DIFFERENT bytes of
// the same store would name pages that no longer hold what it thinks (§5.1). That is checked per store,
// at this chokepoint, before a single page number is believed.

const MAGIC = 0x5847504c;        // "LPGX" little-endian
const VERSION = 3;
const HEADER_BYTES = 36;         // struct '<4sIHHIIiiiI' — the writer derives this from the same format
const ROOTENT_BYTES = 16;        // rx i16 · ry i16 · subOff u32 · subN u32 · reserved u32
const SUBENT_BYTES = 16;         // key u64 · off u32 · len u32
// The kernel's prefetch buffer is keyed by 64 kB page number (`PFPAGE` in store-kernel.mjs). An index
// written for a different page size would name pages that mean something else, so it is refused rather
// than scaled — the two numbers have to be the same number, not merely convertible.
const PAGE = 65536;

// The persistent tier, wired by the app. Without it every read below goes to the network exactly as it
// did — and a saved route cannot be read offline, because the directory that finds its pages is itself
// fetched by range.
let store = null, storeTag = 'idx';
export function usePersist(mod, tag) { store = mod; storeTag = `idx-${tag || 'v'}`; }

let cfg = { url: null, sha: new Map() };
let opening = null;              // Promise<idx|null> — one open per session, whatever asks first
let held = null;                 // the same index once it has settled, for the synchronous stats hook
const stats = { chunkReads: 0, chunkBytes: 0, subdirReads: 0, refusedSha: [], unknownStores: [] };

async function range(url, off, len) {
  // ⚠ THE CACHE IS CONSULTED FIRST AND WRITTEN AFTER, because offline this is the only way the index can
  // be read at all — and the index is what turns a viewport into a page list. The tag carries the dataset
  // version, so a regenerated index cannot be answered from the previous one's directory.
  const key = `${off}+${len}`;
  if (store) {
    const hit = await store.getBlob(storeTag, key);
    if (hit) return hit;
  }
  const res = await fetch(url, { headers: { Range: `bytes=${off}-${off + len - 1}` } });
  if (!res.ok) throw new Error(`index ${url} range ${off}+${len} -> ${res.status}`);
  const b = new Uint8Array(await res.arrayBuffer());
  if (store) store.putBlob(storeTag, key, b).catch(() => {});   // write-behind: never on the read's clock
  return b;
}

/**
 * Where the coverage index lives, and what the app believes each store's bytes hash to.
 *
 * `shaByUrl` is `coverage.json`'s own sha256 per store URL — the same number the deploy verifies every
 * block against — so an index that outlived its data is refused HERE, once, instead of quietly naming
 * pages into a store that has moved underneath it. A store the app has no hash for is simply not
 * prefetched: silence is the safe direction, and it costs only the old behaviour.
 */
export function configureIndex(url, shaByUrl) {
  cfg = { url, sha: new Map(shaByUrl || []) };
  opening = null; held = null;
  stats.chunkReads = 0; stats.chunkBytes = 0; stats.subdirReads = 0;
  stats.refusedSha = []; stats.unknownStores = [];
}

function parseOpen(head, url) {
  const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
  if (dv.getUint32(0, true) !== MAGIC) throw new Error('bad magic');
  const ver = dv.getUint32(4, true);
  if (ver !== VERSION) throw new Error(`index version ${ver}, this reader speaks ${VERSION}`);
  const h = {
    url,
    nstores: dv.getUint16(8, true), maxlevel: dv.getUint16(10, true),
    nroot: dv.getUint32(12, true), ncells: dv.getUint32(16, true),
    olo: dv.getInt32(20, true), ola: dv.getInt32(24, true),
    root: dv.getInt32(28, true), nleaf: dv.getUint32(32, true),
  };
  let o = HEADER_BYTES;
  if (dv.getUint16(o, true) !== h.nstores) throw new Error('store table does not start where the header ends');
  o += 2;
  const dec = new TextDecoder();
  const stores = [];
  for (let i = 0; i < h.nstores; i++) {
    const page = dv.getUint32(o, true), ul = dv.getUint16(o + 4, true);
    const su = dec.decode(head.subarray(o + 6, o + 6 + ul));
    let sha = '';
    for (let j = 0; j < 32; j++) sha += head[o + 6 + ul + j].toString(16).padStart(2, '0');
    stores.push({ id: i, page, url: new URL(su, url).href, name: su.split('/').pop(), sha });
    o += 6 + ul + 32;
  }
  // The root directory is sorted by (rx, ry) and tiny; a Map by tile is the lookup the viewport wants.
  const roots = new Map();
  for (let i = 0; i < h.nroot; i++) {
    const p = o + i * ROOTENT_BYTES;
    roots.set(`${dv.getInt16(p, true)},${dv.getInt16(p + 2, true)}`,
              { off: dv.getUint32(p + 4, true), n: dv.getUint32(p + 8, true) });
  }
  const end = o + h.nroot * ROOTENT_BYTES;
  if (end > head.byteLength) throw new Error('short read');   // the caller re-reads with the true length
  return { h, stores, roots, subdirs: new Map(), chunks: new Map(), byUrl: new Map(), byName: new Map() };
}

/** Header + store table + root directory in ONE read. Returns null if there is no usable index. */
function open() {
  if (opening) return opening;
  opening = (async () => {
    if (!cfg.url) return null;
    // 64 kB covers the whole session-level prologue with room to spare: at Western Europe it projects to
    // ~19 kB of store URLs plus ~8 kB of root tiles. If a future coverage outgrows it, `parseOpen` says
    // so rather than reading past the end, and the retry below asks for exactly what it needs.
    // Any failure of the first read is retried ONCE at a megabyte before giving up: a prologue that
    // outgrows 64 kB runs off the end of the buffer, and the several ways that shows up (a short-read
    // check, a DataView RangeError) are all the same fixable cause. Failing straight to null would
    // silently turn the index off for a whole session over an index that is merely large.
    let ix;
    try {
      ix = parseOpen(await range(cfg.url, 0, 65536), cfg.url);
    } catch {
      ix = parseOpen(await range(cfg.url, 0, 1 << 20), cfg.url);
    }
    // ⚠ THE STORE TABLE IS MATCHED AGAINST WHAT THE APP WILL ACTUALLY FETCH, and the sha256 decides.
    // The URL alone cannot: the same store is `stores/x.store` on the app's origin, an absolute
    // `routing-data-*` Pages URL in the index, and a localhost path under a gate. So a full-href match is
    // tried first and the file NAME is the fallback — safe precisely because a name that means different
    // bytes fails the hash check below and is dropped.
    for (const st of ix.stores) {
      if (st.page !== PAGE) { stats.refusedSha.push(`${st.name}: page size ${st.page}`); continue; }
      ix.byUrl.set(st.url, st);
      if (!ix.byName.has(st.name)) ix.byName.set(st.name, st);
    }
    held = ix;
    return ix;
  })().catch(() => null);
  return opening;
}

/** Warm the one session-level read, so it is not on the first view's critical path. */
export const openIndex = () => open();

/** The store table entry for a URL the app is about to read — or null, which means "no prefetch". */
function storeFor(ix, storeUrl) {
  const key = storeUrl.split('?')[0];
  const st = ix.byUrl.get(key) || ix.byName.get(key.split('/').pop());
  if (!st) {
    if (!stats.unknownStores.includes(key)) stats.unknownStores.push(key);
    return null;
  }
  // §5.1 — the one genuine correctness hazard, refused at the chokepoint. An index built against other
  // bytes of the same store names pages that no longer hold what it thinks they do.
  const want = cfg.sha.get(key) || cfg.sha.get(st.url) || cfg.sha.get(st.name);
  if (want && want !== st.sha) {
    const line = `${st.name}: index ${st.sha.slice(0, 12)} vs data ${want.slice(0, 12)}`;
    if (!stats.refusedSha.includes(line)) stats.refusedSha.push(line);
    return null;
  }
  return st;
}

/** Leaf keys are `level << 56 | x << 28 | y`, read as two u32s — no BigInt for what fits in 28 bits. */
function leafKey(dv, o) {
  const lo = dv.getUint32(o, true), hi = dv.getUint32(o + 4, true);
  return { lvl: hi >>> 24, x: (lo >>> 28) | ((hi & 0x00FFFFFF) << 4), y: lo & 0x0FFFFFFF };
}

async function subdirFor(ix, rx, ry) {
  const key = `${rx},${ry}`;
  if (ix.subdirs.has(key)) return ix.subdirs.get(key);
  const ent = ix.roots.get(key);
  if (!ent || !ent.n) { ix.subdirs.set(key, []); return []; }
  let out = [];
  try {
    const b = await range(ix.h.url, ent.off, ent.n * SUBENT_BYTES);
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    stats.subdirReads++;
    for (let i = 0; i < ent.n; i++) {
      const p = i * SUBENT_BYTES;
      out.push({ ...leafKey(dv, p), off: dv.getUint32(p + 8, true), len: dv.getUint32(p + 12, true) });
    }
  } catch { out = []; }
  ix.subdirs.set(key, out);
  return out;
}

function parseChunk(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = dv.getUint32(0, true);
  const cells = [];
  let o = 4;
  for (let i = 0; i < n; i++) {
    const sid = dv.getUint16(o, true);
    const ox = dv.getInt32(o + 2, true), oy = dv.getInt32(o + 6, true);
    const np = dv.getUint16(o + 10, true);
    const pages = new Array(np);
    for (let j = 0; j < np; j++) pages[j] = dv.getUint32(o + 12 + j * 4, true);
    cells.push({ sid, ox, oy, pages });
    o += 12 + np * 4;
  }
  return cells;
}

/** The leaf chunks covering `box`, fetched CONCURRENTLY and held for the rest of the session. */
async function chunksFor(ix, box) {
  const { olo, ola, root } = ix.h;
  const rx0 = Math.floor((box.mnlo - olo) / root), rx1 = Math.floor((box.mxlo - olo) / root);
  const ry0 = Math.floor((box.mnla - ola) / root), ry1 = Math.floor((box.mxla - ola) / root);
  const tiles = [];
  for (let ry = ry0; ry <= ry1; ry++) for (let rx = rx0; rx <= rx1; rx++) tiles.push([rx, ry]);
  const subs = await Promise.all(tiles.map(([rx, ry]) => subdirFor(ix, rx, ry)));

  // A leaf covers a square of `root >> lvl`, so its box is arithmetic — nothing is stored that could
  // disagree with the key, and a leaf outside the viewport is skipped without a read.
  const want = [];
  for (const sub of subs) {
    for (const lf of sub) {
      const step = root >> lf.lvl;
      const lo = olo + lf.x * step, la = ola + lf.y * step;
      if (lo + step <= box.mnlo || lo > box.mxlo || la + step <= box.mnla || la > box.mxla) continue;
      want.push(lf);
    }
  }
  await Promise.all(want.filter((lf) => !ix.chunks.has(lf.off)).map(async (lf) => {
    try {
      const b = await range(ix.h.url, lf.off, lf.len);
      stats.chunkReads++; stats.chunkBytes += b.length;
      ix.chunks.set(lf.off, parseChunk(b));
    } catch { ix.chunks.set(lf.off, []); }
  }));
  return want.map((lf) => ix.chunks.get(lf.off) || []);
}

/**
 * The pages `storeUrl` needs for `box` — {mnlo, mnla, mxlo, mxla} in fixed-point 1e-7 degrees.
 * Returns [] when there is no index or no entry for this store, so the caller simply gets today's
 * behaviour.
 *
 * `pad` widens the CELL test, not just the chunk test: a feature is keyed by its FIRST VERTEX and never
 * clipped, so it can overhang its cell (PLAN-PERF §7g measured up to 16 cells). Missing such a page is
 * not an error — the read falls through to a normal fetch — so this errs small rather than fetching the
 * block.
 */
export async function pagesFor(storeUrl, box, pad = 0) {
  const ix = await open();
  if (!ix) return [];
  const st = storeFor(ix, storeUrl);
  if (!st) return [];
  const q = { mnlo: box.mnlo - pad, mxlo: box.mxlo + pad, mnla: box.mnla - pad, mxla: box.mxla + pad };
  const out = new Set();
  for (const cells of await chunksFor(ix, q)) {
    for (const c of cells) {
      if (c.sid !== st.id) continue;                     // one chunk, every store — this is the filter
      if (c.ox < q.mnlo || c.ox > q.mxlo || c.oy < q.mnla || c.oy > q.mxla) continue;
      for (const p of c.pages) out.add(p);
    }
  }
  return [...out];
}

/** What the index has actually done this session — for gates and probes to assert on rather than infer. */
export function indexStats() {
  const ix = held;                        // null until the one session read has settled
  return {
    url: cfg.url,
    open: !!ix,
    stores: ix ? ix.stores.map((s) => s.name) : [],
    cells: ix ? ix.h.ncells : 0,
    leaves: ix ? ix.h.nleaf : 0,
    rootTiles: ix ? ix.roots.size : 0,
    subdirsHeld: ix ? ix.subdirs.size : 0,
    chunksHeld: ix ? ix.chunks.size : 0,
    ...stats,
  };
}
