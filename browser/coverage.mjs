// Copyright (c) 2026 Jurjen Stellingwerff
// SPDX-License-Identifier: LGPL-3.0-or-later
//
// PLAN-SCALE S7 — the top index: bbox → which block covers it (D6).
//
// This is the ONLY thing the project authors about its own data. The tiles' directory and their byte
// ranges are the store's business (loft reads them by key), so the index stays a few hundred bytes per
// block: where it lives, how big it is, its sha256, its MEASURED extent, and how to read it.
//
// `pickBlock` is pure and separate from the fetch on purpose — "which block covers this point" is the
// one piece of routing logic in the whole coverage layer, and it is worth testing without a browser.
const inBox = (b, la, lo) => la >= b.mnla && la <= b.mxla && lo >= b.mnlo && lo <= b.mxlo;
const FIXED = 1e7;   // the index states its unit; this is that unit

// The block covering (lat, lon), or null. Coordinates are DEGREES; the index is fixed-point 1e-7°,
// which is the store's own unit — converting here rather than storing degrees keeps the index exactly
// what the loft side already speaks.
//
// A point is matched against the ROADS extent, not the base map's: routing is what a block is for, and
// the two extents differ (the base map covers a slightly wider box than the road network in it).
// Overlapping blocks are resolved by the smallest area, so a city block inside a country block wins —
// the finer data is the one someone bothered to make.
export function pickBlock(index, lat, lon) {
  if (!index || !Array.isArray(index.blocks)) return null;
  const la = Math.round(lat * FIXED), lo = Math.round(lon * FIXED);
  let best = null, bestArea = Infinity;
  for (const b of index.blocks) {
    const box = b.roads && b.roads.bbox;
    if (!box || !inBox(box, la, lo)) continue;
    const area = (box.mxla - box.mnla) * (box.mxlo - box.mnlo);
    if (area < bestArea) { best = b; bestArea = area; }
  }
  return best;
}

// Every block whose roads extent intersects a viewport box (degrees). What a multi-block viewport needs
// at C2 — a pan across a border shows two blocks at once — and already the honest answer to "what does
// this screen need", even when the answer is one.
export function blocksForBox(index, mnla, mnlo, mxla, mxlo) {
  if (!index || !Array.isArray(index.blocks)) return [];
  const a = { mnla: Math.round(mnla * FIXED), mnlo: Math.round(mnlo * FIXED),
              mxla: Math.round(mxla * FIXED), mxlo: Math.round(mxlo * FIXED) };
  return index.blocks.filter((b) => {
    const x = b.roads && b.roads.bbox;
    return x && !(x.mxla < a.mnla || x.mnla > a.mxla || x.mxlo < a.mnlo || x.mnlo > a.mxlo);
  });
}

// Resolve the block for a camera, with the fallbacks stated rather than implied:
//   * no index at all      → null, and the caller says so (the app is not usable without data)
//   * index but no cover   → the FIRST block, flagged `outside: true`, so a visitor who lands outside
//                            coverage gets a map they can pan INTO coverage instead of a blank page
export async function resolveCoverage(indexUrl, lat, lon, fetchImpl = fetch) {
  let index = null;
  try {
    const res = await fetchImpl(indexUrl);
    if (res.ok) index = await res.json();
  } catch { index = null; }
  if (!index || !index.blocks || !index.blocks.length) return { index: null, block: null, outside: true };
  const hit = pickBlock(index, lat, lon);
  return { index, block: hit || index.blocks[0], outside: !hit };
}
