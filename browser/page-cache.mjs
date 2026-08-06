// Copyright (c) 2026 Jurjen Stellingwerff
// SPDX-License-Identifier: LGPL-3.0-or-later
//
// PAGES THAT SURVIVE THE SESSION — and, with the same bytes, a route you can walk with the radio off.
//
// The in-memory prefetch buffer (`store-kernel.mjs`) is emptied when the tab closes, and the host only
// allows the browser's own cache to help for TEN MINUTES: measured on the live site, every store answers
// with `cache-control: max-age=600`. The data behind it does not change on that scale at all — a block is
// immutable for the life of a dataset and carries its sha256 in `coverage.json`. So a visitor who comes
// back after lunch pays the whole cold read again, and a session longer than ten minutes re-pays inside
// itself. That is what this fixes, and it needs nothing from the host.
//
// ⚠ TWO LIFETIMES, ONE STORE. A page arrives here for one of two reasons, and they must not evict each
// other:
//
//   * **incidental** — the view or the ring read it, so keeping it makes the next visit cheaper. Cheap to
//     lose: losing it costs a fetch.
//   * **PINNED** — it belongs to a saved route (`route-pack.mjs`). Losing it costs the user the map on a
//     trip where they have no way to get it back, which is the whole point of having saved it.
//
// So a pinned page is never dropped to make room for an incidental one, and a pack is deleted as a UNIT
// by the person who saved it, never by pressure.
//
// ⚠ AND THE KEY CARRIES THE sha256. A page is bytes at an offset in a specific image; the same offset in
// a regenerated block is different data. Keying by URL alone would serve last month's map, silently and
// convincingly, which is the one failure this must not have. The sha comes from `coverage.json` — the
// same number the deploy verifies each block against — so a dataset change invalidates every stale page
// by construction rather than by a sweep that has to remember to run.

// ⚠ EVERY TOP-LEVEL NAME HERE SHARES ONE SCOPE WITH EVERY OTHER MODULE. `build-site.mjs` concatenates
// the modules into a single inline script, so `PAGE`, `open` and `stats` — all of which this file wanted
// — collide with `page-index.mjs` and take the whole app down with a SyntaxError at load. The bundler
// refuses a duplicate now (it did not, and the browser was the only thing that noticed), but the habit
// that costs nothing is a prefix: `cacheCounters`, `openCache`, `CACHE_PAGE`.
const SCHEMA = 'v1';                     // bump to abandon every cache this code can no longer read
const CACHE_NAME = `routing-pages-${SCHEMA}`;
const MANIFEST = 'https://pagecache.local/manifest';
const CACHE_PAGE = 65536;

let cache = null;                        // the open Cache, or null where storage is unavailable
let manifest = null;                     // { packs: { id: { label, pages: [key…], bytes, when } } }
const cacheCounters = { hits: 0, misses: 0, writes: 0, bytesIn: 0, bytesOut: 0, evicted: 0, unavailable: null };

const keyOf = (sha, page) => `https://pagecache.local/${sha.slice(0, 16)}/${page}`;
// ⚠ THE INDEX HAS TO BE HERE TOO, or a saved route cannot be READ offline. The pages of a block are
// useless without `coverage.pagesx`, which is how the app learns which pages a viewport needs — and that
// file is fetched by RANGE, in pieces that are not 64 kB pages (a header, a sub-directory, leaf chunks).
// So blobs are keyed by an arbitrary string under a tag, and the tag carries the DATASET VERSION: the
// index is regenerated with the data, and a stale directory would point into pages that moved.
const blobKey = (tag, key) => `https://pagecache.local/blob/${tag}/${encodeURIComponent(key)}`;

// While a pack is being saved, everything written belongs to it — including the index ranges the planner
// itself read. A route whose pages are pinned but whose directory is not is a route that cannot be found.
let currentPack = null;
export const setPack = (id) => { currentPack = id; };

/** A cached byte range of something that is not a store page (the index). */
export async function getBlob(tag, key) {
  if (!await openCache()) return null;
  try {
    const r = await cache.match(blobKey(tag, key));
    if (!r) { cacheCounters.misses++; return null; }
    const b = new Uint8Array(await r.arrayBuffer());
    cacheCounters.hits++; cacheCounters.bytesOut += b.length;
    return b;
  } catch { return null; }
}

export async function putBlob(tag, key, bytes) {
  if (!await openCache()) return false;
  try {
    await cache.put(blobKey(tag, key), new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } }));
    cacheCounters.writes++; cacheCounters.bytesIn += bytes.length;
    if (currentPack) {
      const p = manifest.packs[currentPack] || (manifest.packs[currentPack] = { label: currentPack, pages: [], bytes: 0, when: Date.now() });
      p.pages.push(blobKey(tag, key));
      await saveManifest();
    }
    return true;
  } catch { return false; }
}

/**
 * Open the store. Safe to call repeatedly; resolves to false where the Cache API is unavailable (a
 * non-secure context, private mode in some browsers, storage disabled) — in which case every read misses
 * and the app behaves exactly as it does today.
 */
export async function openCache() {
  if (cache) return true;
  try {
    if (typeof caches === 'undefined') { cacheCounters.unavailable = 'no Cache API'; return false; }
    cache = await caches.open(CACHE_NAME);
    // Any cache from an older schema holds pages this code may not be able to read. Dropped whole, once.
    for (const name of await caches.keys()) {
      if (name.startsWith('routing-pages-') && name !== CACHE_NAME) await caches.delete(name);
    }
    const m = await cache.match(MANIFEST);
    manifest = m ? await m.json() : { packs: {} };
    return true;
  } catch (e) {
    cacheCounters.unavailable = String(e && e.message || e);
    cache = null;
    return false;
  }
}

/** Ask the browser not to evict us under pressure. Advisory — it may simply say no. */
export async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist();
  } catch { /* a refusal is not an error */ }
  return false;
}

/** How much room there is, as the browser sees it. */
export async function quota() {
  try {
    const e = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null;
    return e ? { usage: e.usage || 0, quota: e.quota || 0 } : null;
  } catch { return null; }
}

/** The pages of `sha` already held, as a Set — one pass, so a caller can plan without probing per page. */
export async function have(sha, pages) {
  if (!await openCache()) return new Set();
  const found = new Set();
  await Promise.all(pages.map(async (p) => {
    try { if (await cache.match(keyOf(sha, p))) found.add(p); } catch { /* treat as absent */ }
  }));
  return found;
}

/** Read pages. Returns a Map<page, Uint8Array> holding only what was present. */
export async function getMany(sha, pages) {
  const out = new Map();
  if (!await openCache()) { cacheCounters.misses += pages.length; return out; }
  await Promise.all(pages.map(async (p) => {
    try {
      const r = await cache.match(keyOf(sha, p));
      if (!r) { cacheCounters.misses++; return; }
      const b = new Uint8Array(await r.arrayBuffer());
      out.set(p, b);
      cacheCounters.hits++; cacheCounters.bytesOut += b.length;
    } catch { cacheCounters.misses++; }
  }));
  return out;
}

/**
 * Write pages. `packId` pins them to a saved route; without it they are incidental and may be swept.
 *
 * Failures are swallowed on purpose: a full disk must slow nothing down and break nothing. The counter
 * is how a gate sees it instead.
 */
export async function putMany(sha, entries, packId = null) {
  if (!await openCache()) return 0;
  let n = 0;
  const keys = [];
  await Promise.all([...entries].map(async ([page, bytes]) => {
    try {
      await cache.put(keyOf(sha, page), new Response(bytes, {
        headers: { 'content-type': 'application/octet-stream', 'content-length': String(bytes.length) },
      }));
      n++; cacheCounters.writes++; cacheCounters.bytesIn += bytes.length;
      if (packId || currentPack) keys.push(keyOf(sha, page));
    } catch { /* quota, or a browser that refuses — the app must not care */ }
  }));
  const pin = packId || currentPack;
  if (pin && keys.length) {
    const p = manifest.packs[pin] || (manifest.packs[pin] = { label: pin, pages: [], bytes: 0, when: Date.now() });
    p.pages.push(...keys);
    p.bytes += keys.length * CACHE_PAGE;
    await saveManifest();
  }
  return n;
}

async function saveManifest() {
  try { await cache.put(MANIFEST, new Response(JSON.stringify(manifest), { headers: { 'content-type': 'application/json' } })); }
  catch { /* the pages are what matter; a lost manifest costs the ability to delete a pack as a unit */ }
}

/** The saved packs, for the UI to list and for a gate to assert on. */
export async function packs() {
  if (!await openCache()) return [];
  return Object.entries(manifest.packs).map(([id, p]) => ({ id, ...p, pages: p.pages.length }));
}

/** Delete one saved pack and its pages. The user's decision, never storage pressure's. */
export async function dropPack(id) {
  if (!await openCache()) return 0;
  const p = manifest.packs[id];
  if (!p) return 0;
  let n = 0;
  for (const k of p.pages) { try { if (await cache.delete(k)) n++; } catch { /* already gone */ } }
  delete manifest.packs[id];
  await saveManifest();
  cacheCounters.evicted += n;
  return n;
}

/** Is this page pinned by a pack? Used to keep a sweep from taking the map off a trip. */
export function isPinned(sha, page) {
  const k = keyOf(sha, page);
  return Object.values(manifest ? manifest.packs : {}).some((p) => p.pages.includes(k));
}

export const cacheStats = () => ({ ...cacheCounters, schema: SCHEMA,
                                   packs: manifest ? Object.keys(manifest.packs).length : 0 });
