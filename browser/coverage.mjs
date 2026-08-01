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
    // The CAMERA's block is the one whose stores the session opens with, so it must be a routable
    // region: the overview has no roads and answering "which block am I in" with it would name no
    // roads URL at all. It reaches the map through the per-view covering set instead.
    const box = b.roads && b.roads.bbox;
    if (!box || !inBox(box, la, lo)) continue;
    const area = (box.mxla - box.mnla) * (box.mxlo - box.mnlo);
    if (area < bestArea) { best = b; bestArea = area; }
  }
  return best;
}

// The extent a block is SELECTED on, which is not always the extent of the store being asked for.
//
// A region is chosen by its ROADS extent even when the base map is what will be read (see `baseUrlsFor`):
// a tiered base extent is whatever its widest tile covers, which is most of the country. But the overview
// (§6i O1) has NO roads store at all — it is a picture, never a routing input — so there is nothing to
// select it by except its own base extent, which for a whole-country generalisation is exactly right.
// Roads when present, the asked-for store when not.
const selBox = (b, kind, urlKind) =>
  (b[kind] && b[kind].bbox) || (urlKind && b[urlKind] && b[urlKind].bbox) || null;

// PLAN-SCALE §6i O2 — the zoom band a block serves, half-open [lo, hi). A block that declares none serves
// every zoom, so an index written before this behaves exactly as it did.
//
// ⚠ It is what makes the overview and the detailed regions EXCLUSIVE, and that is not cosmetic: a
// country-wide box intersects both, the app would then ask 454 867 cell keys of each detailed block, and
// a `whole` block cannot share one working set with a `paged` one in any case. A zoom of `undefined`
// means "do not filter" — routing asks for roads without a zoom, and a route must reach the detailed
// blocks from any camera.
const inBand = (b, zoom) =>
  zoom === undefined || zoom === null || !Array.isArray(b.zoom) || (zoom >= b.zoom[0] && zoom < b.zoom[1]);

// Every block whose selection extent intersects a viewport box (degrees). What a multi-block viewport
// needs at C2 — a pan across a border shows two blocks at once — and already the honest answer to "what
// does this screen need", even when the answer is one.
export function blocksForBox(index, mnla, mnlo, mxla, mxlo, kind = 'roads', zoom = undefined, urlKind = null) {
  if (!index || !Array.isArray(index.blocks)) return [];
  const a = { mnla: Math.round(mnla * FIXED), mnlo: Math.round(mnlo * FIXED),
              mxla: Math.round(mxla * FIXED), mxlo: Math.round(mxlo * FIXED) };
  return index.blocks.filter((b) => {
    if (!inBand(b, zoom)) return false;
    const x = selBox(b, kind, urlKind);
    return x && !(x.mxla < a.mnla || x.mnla > a.mxla || x.mxlo < a.mnlo || x.mnlo > a.mxlo);
  });
}

// The roads URLs a command over `box` must be able to read, as the kernel's line 1 wants them: the
// covering set, comma-separated, resolved against the index's own URL.
//
// It is a SET, not a block, because a corridor near a border needs both sides — and the kernel decides
// its read strategy from the count (more than one can only be paged; a whole-file load adopts an image
// rather than adding to one). One entry is the C0/C1 case and behaves exactly as it did.
//
// The order is the index's, so the same viewport always produces the same string — which is what lets the
// kernel treat "the covering set changed" as "the session is stale" with a plain comparison.
export function roadsUrlsFor(index, indexUrl, mnla, mnlo, mxla, mxlo, fallback, zoom = undefined) {
  return storeUrlsFor(index, indexUrl, mnla, mnlo, mxla, mxlo, 'roads', fallback, null, zoom);
}

// The BASE-MAP counterpart, and it exists for the same reason the roads one does — PLAN-SCALE §6f F3
// cuts the Netherlands into three base regions, and a viewport ON a cut needs both sides. Measured on
// the 4.90°E cut at the app's own default zoom: a box straddling it holds 25 862 features, and ONE
// region answers with 13 946 of them. Half the screen, silently blank.
//
// It became possible in the same step that made it necessary: `store_load_keys` ACCUMULATES, so a second
// base block adds to the working set, where the old whole-file load would have replaced the image. That
// is why the app could only ever name one base store before, and why it can name a set now.
//
// A region with no base map at all (`base: null`, which is most of the country until F4 publishes) is
// simply not a candidate — `blocksForBox` skips it, and an empty set is the app's existing "no base map"
// state rather than an error.
export function baseUrlsFor(index, indexUrl, mnla, mnlo, mxla, mxlo, fallback, zoom = undefined) {
  // ⚠ SELECTED BY THE ROADS EXTENT, not the base one. Since PLAN-SCALE §6f F3 the base map is TIERED, and
  // a coarse tile is 256 km across — so a region's sealed base extent is whatever its widest tile covers,
  // which is most of the country for every region. Measured after the four-way cut: all four base extents
  // read lon 2.39..7.21, i.e. they no longer identify a region at all, and "smallest block containing the
  // box" picked an arbitrary one. Den Haag and Rotterdam rendered as two lines and nothing else.
  //
  // The ROADS extent is the region's real geographic band: untiered, disjoint, cut on a cell boundary.
  // A region is roads + base over the same ground, so choosing on roads and reading the base URL is the
  // honest question — and a viewport past the band picks the neighbour, which is what it should do.
  return storeUrlsFor(index, indexUrl, mnla, mnlo, mxla, mxlo, 'roads', fallback, 'base', zoom);
}

// One implementation, two stores. It used to be roads-only, and duplicating it for the base map would
// have duplicated the two rules below — the ones that took a session and a wrong route each to find.
// The blocks a box needs, as BLOCKS — so a caller can ask them anything, not just their URL. Read mode
// is the case that forced it: it is a property of the STORE, and resolving it from the camera's block
// instead is wrong exactly when the two differ, which is any viewport wider than the block under it.
export function blocksChosenFor(index, mnla, mnlo, mxla, mxlo, kind, urlKind = null, zoom = undefined) {
  return chooseBlocks(index, mnla, mnlo, mxla, mxlo, kind, null, urlKind, zoom).chosen;
}

function storeUrlsFor(index, indexUrl, mnla, mnlo, mxla, mxlo, kind, fallback, urlKind = null, zoom = undefined) {
  const { chosen, want } = chooseBlocks(index, mnla, mnlo, mxla, mxlo, kind, fallback, urlKind, zoom);
  return chosen.filter((b) => b[want]).map((b) => new URL(b[want].url, indexUrl).href).join(',');
}

function chooseBlocks(index, mnla, mnlo, mxla, mxlo, kind, fallback, urlKind, zoom = undefined) {
  const want = urlKind || kind;
  // A region that ships no store of the kind being ASKED FOR is not a candidate, however well its
  // selection extent fits: `base: null` is most of the country until the blocks are published, and
  // naming a URL the page cannot fetch takes the whole working set down with it.
  const hits = blocksForBox(index, mnla, mnlo, mxla, mxlo, kind, zoom, urlKind).filter((b) => b[want]);
  // ⚠ If one block CONTAINS the whole box, use the smallest such and nothing else.
  //
  // Real blocks are disjoint — regions are cut on cell boundaries — but the index cannot enforce that, and
  // an overlap is exactly what a detailed city block inside a country block looks like. Naming both would
  // feed the SAME roads to `build_graph` twice, and a duplicated way is not a slower match, it is a
  // different one. Only when no single block covers the box (a genuine border case) is the set plural.
  const covers = (b) => { const x = selBox(b, kind, urlKind); if (!x) return false;
    return x.mnla <= Math.round(mnla * FIXED) && x.mxla >= Math.round(mxla * FIXED)
        && x.mnlo <= Math.round(mnlo * FIXED) && x.mxlo >= Math.round(mxlo * FIXED); };
  const area = (b) => { const x = selBox(b, kind, urlKind);
    return x ? (x.mxla - x.mnla) * (x.mxlo - x.mnlo) : Infinity; };
  const whole = hits.filter(covers).sort((a, b) => area(a) - area(b));
  // ⚠ "One block covers the box" is NOT enough on its own, and believing it drops roads.
  //
  // Two blocks cut on a CELL boundary still have OVERLAPPING BBOXES, because a way is kept whole and
  // overhangs the cut. Measured: nl-west spans lon 3.3400..5.4680 and nl-east 5.3001..7.2430 for a seam
  // at 5.40 — a 0.17-degree band each claims. A box inside that band is "covered" by both, the smaller
  // AREA wins, and every road on the other side of the seam is silently absent. That is exactly the
  // Amersfoort->Apeldoorn route PLAN-SCALE calls out, and a bbox cannot tell the case apart from the
  // nesting one: `enschede` inside `nl-east` looks the same to a containment test.
  //
  // What separates them is NESTING. A city block inside a country block is fully contained, so the finer
  // one really does hold every cell of the box and the coarse one adds nothing but duplicates. Two
  // half-country blocks PARTIALLY overlap — neither contains the other — so each may hold cells the other
  // lacks and both are needed. So: take the smallest containing block, then add back any hit that is not
  // nested with it.
  const nested = (a, b) => { const x = selBox(a, kind, urlKind), y = selBox(b, kind, urlKind);
    if (!x || !y) return false;
    const inside = (p, q) => p.mnla >= q.mnla && p.mxla <= q.mxla && p.mnlo >= q.mnlo && p.mxlo <= q.mxlo;
    return inside(x, y) || inside(y, x); };
  let chosen;
  if (whole.length) {
    const best = whole[0];
    chosen = [best, ...hits.filter((b) => b !== best && !nested(b, best))];
  } else {
    chosen = hits.length ? hits : (fallback ? [fallback] : []);
  }
  return { chosen, want };
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
