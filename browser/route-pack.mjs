// Copyright (c) 2026 Jurjen Stellingwerff
// SPDX-License-Identifier: LGPL-3.0-or-later
//
// THE MAP FOR A TRIP, SAVED BEFORE YOU LEAVE — a corridor around the route, at the zooms you will use.
//
// A walk, a ride or a crossing happens where there is no signal, and that is exactly where the map is
// wanted. The pages are the same pages an ordinary view reads; what changes is WHEN they are fetched and
// how long they are kept (`page-cache.mjs` pins a pack, so storage pressure can never take the map off a
// trip that has already started).
//
// ⚠ THE INVARIANT, AND EVERYTHING HERE EXISTS TO KEEP IT:
//
//   > Every page the app reads while following the route offline is already in the pack, because the pack
//   > asked the SAME covering question, at the SAME zooms, through the SAME index that the view will use.
//
// So this does not compute which blocks a route needs — it ASKS the app's own `baseFor`/`roadsFor` and
// `pagesFor`, the functions a view calls. A second implementation of "which store answers here" is the
// one thing certain to drift, and it would drift into a hole in the map halfway up a hill.
//
// ⚠ AND IT IS BOUNDED BY TWO KNOBS THE USER HOLDS, because the honest answer to "how much is this" is
// "as much as you ask for":
//
//   * **width** — how far either side of the line to keep. A phone in a pocket does not pan far; 500 m
//     covers a wrong turn, 2 km covers a re-route.
//   * **detail** — which zooms to save. Each finer zoom is a different store with far more cells, so this
//     is the knob that moves the total by an order of magnitude, not the width.
//
// Both are reported as an ESTIMATE before anything is downloaded. A trip pack that silently eats a
// gigabyte on a metered connection is a worse failure than one that refuses.

const M_PER_DEG_LAT = 111320;

/** Degrees of latitude / longitude for a distance in metres at a given latitude. */
export const degLat = (m) => m / M_PER_DEG_LAT;
export const degLon = (m, lat) => m / (M_PER_DEG_LAT * Math.max(0.05, Math.cos(lat * Math.PI / 180)));

/**
 * The corridor as a list of boxes: one per route segment, grown by `halfWidthM` and split so no box is
 * wildly larger than the corridor is wide.
 *
 * Boxes rather than a true buffer polygon on purpose — every consumer downstream (the coverage index, the
 * page index) is a bbox test, so a polygon would be converted to these anyway, and an exact buffer would
 * buy nothing but a harder thing to check.
 */
export function corridorBoxes(route, halfWidthM, maxSpanM = 4000) {
  const out = [];
  if (!Array.isArray(route) || route.length === 0) return out;
  const pts = route.length === 1 ? [route[0], route[0]] : route;
  for (let i = 1; i < pts.length; i++) {
    const [alat, alon] = pts[i - 1], [blat, blon] = pts[i];
    // A long segment is split, so one straight leg across a country does not become one box covering it.
    const spanM = Math.hypot((blat - alat) * M_PER_DEG_LAT,
                             (blon - alon) * M_PER_DEG_LAT * Math.cos(((alat + blat) / 2) * Math.PI / 180));
    const steps = Math.max(1, Math.ceil(spanM / maxSpanM));
    for (let s = 0; s < steps; s++) {
      const t0 = s / steps, t1 = (s + 1) / steps;
      const la0 = alat + (blat - alat) * t0, la1 = alat + (blat - alat) * t1;
      const lo0 = alon + (blon - alon) * t0, lo1 = alon + (blon - alon) * t1;
      const mid = (la0 + la1) / 2;
      const dla = degLat(halfWidthM), dlo = degLon(halfWidthM, mid);
      out.push({ mnla: Math.min(la0, la1) - dla, mxla: Math.max(la0, la1) + dla,
                 mnlo: Math.min(lo0, lo1) - dlo, mxlo: Math.max(lo0, lo1) + dlo });
    }
  }
  return out;
}

/**
 * What a pack would contain — WITHOUT fetching anything.
 *
 * `ask` is the app's own view of the world, supplied by the caller so this file owns no second copy of it:
 *   ask.storesFor(box, zoom) -> [url]         the covering set a view at that zoom would read
 *   ask.pagesFor(url, box)   -> Promise<[page]>  the index's answer for that store and box
 *   ask.shaOf(url)           -> sha256 | null
 *   ask.pageBytes            -> bytes per page (65536)
 */
export async function planPack(route, { halfWidthM = 800, zooms = [12, 14, 16], ask }) {
  // ⚠ THE PACK MUST HOLD WHAT A VIEW WILL READ, NOT WHAT THE ROUTE COVERS. A corridor 800 m either side
  // of the line is narrower than the SCREEN at z14 (~4 km), so the app standing on the route asks for
  // cells the pack never contained: measured offline, 187 of 237 reads failed and the map drew nothing
  // even though 220 pages were served from the device. So each sample point contributes the VIEWPORT the
  // app would read there — via the app's own `boxAt`, so there is still only one notion of it — and the
  // width knob widens that rather than replacing it.
  const corridor = corridorBoxes(route, halfWidthM);
  const boxes = [];
  for (const z of []) void z;                       // (zoom-specific boxes are built per zoom below)
  boxes.push(...corridor);
  const perStore = new Map();               // url -> { sha, pages: Set<number> }
  for (const z of zooms) {
    // The screen the app would draw at each sample point, grown by the width knob. Union with the plain
    // corridor so a wide-width/low-zoom combination is never NARROWER than what was asked for.
    const atZoom = ask.boxAt
      ? route.map(([la, lo]) => {
          const b = ask.boxAt(la, lo, z);
          const dla = degLat(halfWidthM), dlo = degLon(halfWidthM, la);
          return { mnla: b.mnla - dla, mxla: b.mxla + dla, mnlo: b.mnlo - dlo, mxlo: b.mxlo + dlo };
        })
      : [];
    for (const box of [...boxes, ...atZoom]) {
      for (const url of ask.storesFor(box, z)) {
        if (!url) continue;
        let e = perStore.get(url);
        if (!e) { e = { sha: ask.shaOf(url), pages: new Set() }; perStore.set(url, e); }
        // A store with no sha cannot be persisted safely (page-cache keys by it), so it is named in the
        // plan and reported rather than silently packed under a key that cannot be invalidated.
        for (const p of await ask.pagesFor(url, box)) e.pages.add(p);
      }
    }
  }
  let pages = 0, unkeyed = [];
  for (const [url, e] of perStore) {
    pages += e.pages.size;
    if (!e.sha) unkeyed.push(url);
  }
  return { boxes: boxes.length, stores: perStore.size, pages,
           bytes: pages * (ask.pageBytes || 65536), perStore, unkeyed,
           zooms: [...zooms], halfWidthM };
}

/**
 * Fetch and pin a plan. `fetchPages(url, pages)` is the kernel's own prefetch, so the bytes arrive
 * through the one path everything else already uses — the buffer, the counters and the write-behind to
 * `page-cache` all apply without this file knowing they exist.
 *
 * Reports progress per store, and NEVER throws: a pack that stops halfway is a partial map, which is a
 * thing the user can be told about and re-run, not a reason to lose the ones already saved.
 */
export async function buildPack(plan, { fetchPages, onProgress = () => {} }) {
  let done = 0, failed = 0;
  for (const [url, e] of plan.perStore) {
    if (!e.sha) { failed += e.pages.size; onProgress({ url, skipped: 'no sha256 — cannot be keyed safely' }); continue; }
    const pages = [...e.pages].sort((a, b) => a - b);
    try {
      const r = await fetchPages(url, pages);
      done += pages.length;
      onProgress({ url, pages: pages.length, requests: r && r.requests, done, total: plan.pages });
    } catch (err) {
      failed += pages.length;
      onProgress({ url, error: String(err && err.message || err) });
    }
  }
  return { done, failed, total: plan.pages };
}

/** A human-sized description, for the button that has to say what it is about to spend. */
export const describePlan = (plan) =>
  `${(plan.bytes / 1e6).toFixed(0)} MB · ${plan.pages} pages · ${plan.stores} store(s) · ` +
  `${plan.halfWidthM} m either side · zooms ${plan.zooms.join(', ')}`;
