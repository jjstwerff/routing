// Copyright (c) 2026 Jurjen Stellingwerff
// SPDX-License-Identifier: LGPL-3.0-or-later
//
// PLAN-BUILD B5–B7 — the standalone base-map + routing app. Fetches the two loft stores, runs the
// loft-wasm kernel for the visible viewport (`view <bbox>`) and the matched route (`match`), and renders
// on a 2D canvas. No server: JS does pixels (map.mjs), loft does the map/route (store-kernel.mjs).
import { RouteMap, parseView, parseStretch, areasFromStore, viewFromStore, viewRenderLists,
         cameraFromHash, hashForCamera, densifySketch, isSketchEcho, PROFILES,
         routeDistanceM, formatDistance, routeGpx,
         SKETCH_KEY, sketchToJson, sketchFromJson } from './map.mjs';
import { createKernel } from './store-kernel.mjs';
import { pagesFor, indexStats, configureIndex, openIndex } from './page-index.mjs';
import { flatCount, flatElement, flatField, flatFields } from './loft-store.mjs';
import { buildIndex, storeLayout } from './store-geom.mjs';
import { RoughLayer, KernelQueue } from './rough.mjs';
import { resolveCoverage, roadsUrlsFor, baseUrlsFor, blocksChosenFor } from './coverage.mjs';

// PLAN-SCALE C1b — how the kernel READS the roads block: 'whole' downloads it once, 'paged' pulls only
// the cells each command touches (store_load_keys over HTTP Range). 'whole' is right for THIS block:
// it is 3.5 MB ≈ 56 pages, so a session that pans the region touches 80% of them anyway and pays 46
// round trips to do it (+~200 ms on a localhost cold start, worse over a real RTT). The switch exists
// because the answer flips with block SIZE, not with code — at C2 the top index carries it per block.
// ACTIVITY x SUB-MODE (DESIGN §6, PLAN.md step 8, restored per PLAN-RESTORE R1).
//
// The nine profiles have been in the kernel and under test the whole time — `way_penalty` weighs
// highway/surface/tracktype per profile and `tests/profiles.loft` asserts a footpath beside a road flips
// with the sub-mode. Only the SELECTOR was lost in the serverless rewrite, so this is plumbing: one
// mutable profile, two dropdowns, and a re-match through the existing chokepoint.
const ACT = {
  Walking: [['Paved', 'paved'], ['Trail', 'trail']],
  Running: [['Fast', 'fast'], ['Trail', 'trail']],
  Cycling: [['Road', 'road'], ['Gravel', 'gravel'], ['MTB', 'mtb']],
  Driving: [['Fastest', 'fastest'], ['Avoid motorways', 'avoid']],
};
const ACT_KEY = { Walking: 'walking', Running: 'running', Cycling: 'cycling', Driving: 'driving' };
let PROFILE = PROFILES[0];                       // walking_paved; the fragment may override at boot

const canvas = document.getElementById('map');
const hud = document.getElementById('hud');

// WHERE THE CAMERA STARTS — the URL fragment, OSM-style `#zoom/lat/lon`, else Enschede centre.
//
// It lives in the URL rather than in localStorage on purpose. The fragment survives a reload (which is
// the thing being asked for), it makes a view SHAREABLE and the back button work, and — the deciding
// reason — it keeps every headless gate deterministic BY CONSTRUCTION: seven CDP drivers navigate to a
// bare app URL with no fragment, so they all get the default. Saved state in localStorage would have
// leaked a panned camera from one gate run into the next through the persistent `--user-data-dir`, and
// staying deterministic would have meant clearing storage in all seven, with the eighth forgetting to.
//
// Everything is validated: a hand-edited or stale fragment must degrade to the default, never boot the
// app to a blank map at NaN.
// PLAN-SCALE §6i O1 — THE APP OPENS ON THE COUNTRY. It used to open on Enschede at z16 because that was
// the only camera it could afford: a wider view read the detailed blocks, and a country-wide one names
// ~1.1 M cell keys at ~200 kB each. The overview block answers this camera in ONE request of 19.6 MB and
// nothing else is touched — measured, 132 094 features drawn, `R=0` detailed roads read.
//
// ⚠ Every headless driver PINS its own camera now (`GATE_CAM` in the cdp_*.mjs files). Seven of them
// navigated to a bare URL and inherited whatever this said, so leaving it at Enschede was load-bearing
// for gates that have nothing to do with the default — moving it silently re-baselines all of them.
const DEFAULT_CAM = { lat: 52.15, lon: 5.30, zoom: 8 };
const bootCam = cameraFromHash(location.hash);
if (bootCam && bootCam.profile) PROFILE = bootCam.profile;
const map = new RouteMap(canvas, bootCam || DEFAULT_CAM);
map.profile = PROFILE;   // the signposted-network overlay follows it (§6/PLAN step 8)

// `replaceState`, not `location.hash =`: assigning would push a history entry per pan and turn the back
// button into a rewind of every camera nudge.
function rememberCamera() {
  const next = hashForCamera(map.camera, PROFILE);
  if (next !== location.hash) history.replaceState(null, '', next);
}

// PLAN-SCALE S7 — the TOP INDEX says which block covers the camera, and how to read it. The store URLs
// used to be hardcoded here, which is exactly as far as one block goes: a second region would have meant
// a second build of the app. Now the app ships one index lookup and the DATA decides.
//
// `readMode` comes from the index too (C1b): a small block is downloaded whole, a large one is read by
// byte range. That is a property of the block, so it belongs next to the block's URL, not in this file.
const INDEX_URL = new URL('./coverage.json', location.href).href;
const coverage = await resolveCoverage(INDEX_URL, map.camera.lat, map.camera.lon);
if (!coverage.block) {
  hud.textContent = 'no coverage index — the app has no data to show';
  throw new Error('no coverage index at ' + INDEX_URL);
}
// A region may have NO base map, and that is a supported product rather than a broken one: the NL road
// blocks are 497 MB and fit GitHub Pages' ~1 GB cap, while the NL base map is 2.87 GB and does not. So
// outside Enschede you get roads and a route on a plain background (PLAN-SCALE N3).
//
// The empty string is the kernel's own "no layout": line 1 is compared against `layout_at`, which starts
// empty, so an empty URL loads nothing and the exposed layout store stays empty. No kernel branch needed
// — but do NOT "simplify" this to a missing line, because line 1 is positional.
const LAYOUT = coverage.block.base ? new URL(coverage.block.base.url, INDEX_URL).href : '';
// PLAN-RESTORE R4 — the searchable names, a store of its own. Separate from the base map on purpose:
// after N3 most of the country HAS no base map, and "where is Lonneker" must still answer. Empty when a
// region ships none, which the kernel reads as "find nothing" rather than as an error.
const NAMES = coverage.block.names ? new URL(coverage.block.names.url, INDEX_URL).href : '';
// The single-block default. Every command below re-derives the covering SET for the box it is about to
// read (PLAN-SCALE C2) — this is what it collapses to when one block covers everything, and the fallback
// when a box covers none.
// …and a block may have NO roads at all (the overview is a picture, never a routing input). That is a
// supported state, not a crash: the per-command covering set names the roads a view or a match needs, and
// this is only the single-block default it collapses to.
const ROADS  = coverage.block.roads ? new URL(coverage.block.roads.url, INDEX_URL).href : '';

// docs/prefetch-index-design.md — WHICH PAGES DOES THIS VIEWPORT NEED, over every store at once.
//
// One file beside `coverage.json`, read by range: the app pays ~1.4 kB per session for the header and
// the root directory, then a sub-directory and a few chunks per screen. Its absence is not an error —
// `pagesFor` returns [] and every read takes today's path — so a site published without it works exactly
// as it did, only slower.
//
// The hashes come from the coverage index, which is the same number the deploy verifies each block's
// bytes against. That is what makes a STALE index safe: it is refused per store at the reader's
// chokepoint rather than believed into naming pages of data that has moved (design §5.1).
const PAGES_URL = new URL('./coverage.pagesx', INDEX_URL).href;
configureIndex(PAGES_URL, (coverage.index.blocks || []).flatMap((b) => [b.roads, b.base]
  .filter((s) => s && s.url && s.sha256)
  .map((s) => [new URL(s.url, INDEX_URL).href, s.sha256])));
openIndex();          // one session read, warmed here so it is not on the first view's critical path
// The roads blocks a box needs, as the kernel's line 1: the covering set, comma-separated. The BASE map
// stays single-block for now — `expose` pins one store, and re-scoping that is S5/C3.
// ⚠ THE VIEW'S ROADS ARE ZOOM-BANDED; A MATCH'S ARE NOT. Below the handover the overview answers the
// whole screen and carries its own merged spine, so reading the detailed roads there asks ~70 000 cell
// keys for motorways one 19.6 MB file already holds — measured, before this existed: 75 256 range
// requests, 4.7 GB, and the view never returned. `roadsForSketch` deliberately passes no zoom, because a
// route must always be matched against the DETAILED geometry whatever the camera is doing.
//
// The fallback follows the same rule as the set: the camera's block is only a sensible default while it
// serves this zoom. Out of band it would drag a detailed store back in through the side door.
// ⚠ The fallback is applied HERE, not inside `chooseBlocks`. Passing `coverage.block` as the chooser's
// fallback puts the camera's block back whenever the band excluded every candidate — which is exactly
// the case this exists to prevent, and it downloaded a 123 MB roads store whole at z8.
const roadsFor = (b, z) => roadsUrlsFor(coverage.index, INDEX_URL, b.mnla, b.mnlo, b.mxla, b.mxlo, null, z)
  || (inBandOf(coverage.block, z) ? ROADS : '');
// PLAN-LAYERS §4 — the lowest zoom the blocks answering this viewport's ROADS claim to serve.
//
// The renderer needs it because a class ladder written for continuous data now lives inside a band: below
// the floor there are no roads at all, so a class debut ABOVE the floor deletes content for part of a band
// the block says it serves. `roadDebut` applies it; this is where the index's own `zoom[0]` is read.
// 0 when the index declares no band, which means "no floor" and leaves the ladder exactly as it was.
// PLAN-LAYERS §5 (L3) — THE FLOOR.
//
// The ground a view is actually holding: the box it read, intersected with the union of the ROADS extents
// of the blocks that answered it — and only when the view actually produced something.
//
// ⚠ THE ROADS EXTENT, NOT THE BASE ONE, and `coverage.mjs` already says why in its own words: since the
// base map became TIERED, "all four base extents read lon 2.39..7.21, i.e. they no longer identify a
// region at all". A held-ground test built on those declares the whole country covered and suppresses the
// floor everywhere — measured: at 7.22°E the app drew 0 features and still reported held ground.
//
// ⚠ AND IT IS GATED ON WHAT THE VIEW RETURNED, because an extent is a claim and a feature count is an
// observation. A viewport past the data's edge intersects an extent that reaches over it and holds
// nothing at all; only the count can tell those apart.
function heldGroundFor(box, z, hadFeatures) {
  if (!hadFeatures) return null;                          // nothing came back — the floor may cover it all
  // The blocks that answered the BASE read, measured by their SELECTION extent — roads when the block has
  // them, its own base box when it does not. That is `coverage.mjs`'s `selBox` rule and it matters in both
  // directions: a detailed region is honestly bounded by its roads extent, while the overview and the
  // middle-zoom block have no roads at all and are bounded by their own.
  //
  // ⚠ Using the roads extent ALONE said "nothing is held" for every z12 view, because that band's block
  // carries no roads — so the floor fetched 33.7 MB behind a map that was already complete. The overview
  // gate caught it as "z12 reads the middle-zoom block alone" suddenly reading two stores.
  const chosen = blocksChosenFor(coverage.index, box.mnla, box.mnlo, box.mxla, box.mxlo, 'roads', 'base', z);
  let mnla = Infinity, mnlo = Infinity, mxla = -Infinity, mxlo = -Infinity;
  for (const b of chosen) {
    const x = (b.roads && b.roads.bbox) || (b.base && b.base.bbox);
    if (!x) continue;
    mnla = Math.min(mnla, x.mnla); mnlo = Math.min(mnlo, x.mnlo);
    mxla = Math.max(mxla, x.mxla); mxlo = Math.max(mxlo, x.mxlo);
  }
  if (!isFinite(mnla)) return null;                       // nothing answered — the floor may cover it all
  const F = 1e7;
  const hi = { mnla: Math.max(mnla, Math.round(box.mnla * F)), mnlo: Math.max(mnlo, Math.round(box.mnlo * F)),
               mxla: Math.min(mxla, Math.round(box.mxla * F)), mxlo: Math.min(mxlo, Math.round(box.mxlo * F)) };
  return (hi.mnla < hi.mxla && hi.mnlo < hi.mxlo) ? hi : null;
}

// The floor is fetched ON FIRST NEED, not at boot, and that is a measured choice rather than caution: the
// overview is 33.7 MB. A bare visit opens on the country and pays for it anyway; someone who deep-links
// to z16 inside a covered region never sees the floor and must not be charged 33.7 MB for it. So it loads
// the first time a view leaves ground uncovered — which is the first pan that would otherwise go blank.
// ⚠ WHICH block is the floor comes from the INDEX, not from a constant here. It was `'nl-overview'`
// until 2026-08-03, and that id is about to change — the overview stops being the Netherlands the moment
// coverage crosses a border. A stale constant does not throw: `floorBlock()` returns undefined,
// `ensureFloor` sets `floorState = 'absent'`, and the app quietly stops covering ground the fine layer
// has not got. The failure is a map that goes blank where it used to be coarse, with nothing logged.
//
// `data/coverage.toml` declares `floor = true` on exactly one region; `build_index.sh` carries it
// through. The fallback to the old id keeps an index written before this readable, so a deploy that
// serves the previous index against this app still has a floor.
const floorBlock = () => {
  const blocks = coverage.index?.blocks || [];
  const usable = (b) => b && b.base && b.base.url;
  return blocks.find((b) => b.floor && usable(b)) || blocks.find((b) => b.id === 'nl-overview' && usable(b));
};
let floorState = 'idle';                                  // idle → loading → ready | absent
const floorUrl = () => { const b = floorBlock(); return b ? new URL(b.base.url, INDEX_URL).href : '\u0000'; };
function floorReport(lists, how) {
  let coords = 0;
  for (const a of lists.areas) coords += a.ring.length;
  for (const l of lists.lines) coords += l.geom.length;
  return { how, areas: lists.areas.length, lines: lists.lines.length,
           pois: lists.pois.length, places: lists.places.length, coords };
}
function floorNeeded(box, z, hadFeatures) {
  const held = heldGroundFor(box, z, hadFeatures);
  if (!held) return true;                                 // nothing answered at all
  const F = 1e7, pad = 0.02;                              // a screen-edge sliver is not worth 33.7 MB
  return held.mnla > Math.round((box.mnla + pad) * F) || held.mxla < Math.round((box.mxla - pad) * F)
      || held.mnlo > Math.round((box.mnlo + pad) * F) || held.mxlo < Math.round((box.mxlo - pad) * F);
}
async function ensureFloor(box, z, hadFeatures) {
  if (floorState !== 'idle' || !floorNeeded(box, z, hadFeatures)) return;
  const blk = floorBlock();
  if (!blk) { floorState = 'absent'; return; }
  floorState = 'loading';
  const url = new URL(blk.base.url, INDEX_URL).href;
  const x = blk.base.bbox;
  const bbox = `${x.mnla / 1e7},${x.mnlo / 1e7},${x.mxla / 1e7},${x.mxlo / 1e7}`;
  try {
    // Its OWN kernel command, whole-file, over the block's whole extent — the one read this costs. It
    // cannot join the view's read set: P3 measured that mixing a `whole` block into a `paged` one spends
    // 5.8 MB and 2 whole-file loads and draws NOTHING (§5).
    await jobs.post('floor', async () => {
      // The kernel's own line protocol, spelled out rather than borrowed from `viewCmd`: this read names
      // NO roads store and forces `whole` on both, which is the one command in the app that does.
      await kernel.runKernel([url, '', 'view', bbox, '', 'whole', '', 'whole'].join('\n'));
      const h = kernel.exposedValue ? kernel.exposedValue(1) : null;
      if (!h) { floorState = 'absent'; return; }
      // ⚠ STORE_KINDS, not APP_OBJECT_KINDS. The app materialises only the LABELS and draws all geometry
      // from the store index (PLAN-PERF step 13), so asking for the app's own kind set gave a floor of
      // 390 place names and no map at all — measured, and it looked exactly like a floor that had loaded.
      // The floor is the one place that must materialise geometry: its whole purpose is to outlive the
      // store the index points into.
      const lists = viewRenderLists(viewFromStore(kernel.memory(), h, fboxOf(bbox), { flatCount, flatField }, STORE_KINDS));
      map.setFloor(lists, x);
      floorState = 'ready';
      window.__storeApp = { ...(window.__storeApp || {}), floor: floorReport(lists, 'fetched') };
    });
  } catch (e) { console.warn('floor load failed:', e); floorState = 'idle'; }
  // ⚠ The floor's own read leaves the kernel holding the OVERVIEW. The next view must rebuild the
  // session's store set rather than assume its own is still bound, so the source is invalidated here.
  loadedSrc = null;
  await ensureViewNow();
}

const roadsFloorFor = (b, z) => {
  const chosen = blocksChosenFor(coverage.index, b.mnla, b.mnlo, b.mxla, b.mxlo, 'roads', null, z);
  const floors = chosen.map((x) => (Array.isArray(x.zoom) ? x.zoom[0] : 0));
  return floors.length ? Math.min(...floors) : 0;
};
// PLAN-SCALE §6f F3 — the BASE map is a covering set too, now that a country is three base regions. A
// viewport on a cut needs both sides: one region answers a straddling z16 viewport with 13 946 of its
// 25 862 features, i.e. half the screen. Falls back to LAYOUT (the camera's own block, possibly empty),
// so a region with no base map behaves exactly as it did.
// PLAN-SCALE §6i O2 — the ZOOM decides which map answers, not just the box. Below the handover the
// overview alone answers (one 19.6 MB whole file); above it the detailed regions alone do. Passing the
// camera's zoom is the whole of the client's side of that: `blocksForBox` filters on the band the index
// declares, and a block that declares none is unaffected.
const inBandOf = (b, z) => !b || !Array.isArray(b.zoom) || z === undefined || (z >= b.zoom[0] && z < b.zoom[1]);
// ⚠ The fallback honours the BAND, like `roadsFor`'s does. Falling back to the camera's block when no
// block serves this zoom hands the view a store that has explicitly declared it does not serve it — and
// it hides a missing level: with the middle-zoom block absent, a z12 view silently drew the city block's
// base instead of nothing, which is a wrong map rather than an empty one.
const baseFor = (b, z) => baseUrlsFor(coverage.index, INDEX_URL, b.mnla, b.mnlo, b.mxla, b.mxlo, null, z)
  || (inBandOf(coverage.block, z) ? LAYOUT : '');
// ⚠ A SESSION-WIDE READ MODE IS WRONG, AND IT BROKE THE LIVE MAP (2026-08-02). It is resolved from the
// CAMERA's block, and the blocks a VIEWPORT needs are not always that block: at z13.68 over Enschede the
// viewport escapes the little city block, selection correctly picks `nl-east` — and the mode said
// `whole`, so the app asked for a 774 MB store as ONE download instead of paging it. It never finished,
// so the map stayed as whatever had loaded first, which looked exactly like "the base map is missing".
//
// Read mode belongs to the STORE. These stay only as the OVERRIDE a gate sets before load; the per
// command answer comes from `modeOf`, over the blocks that command actually named.
window.__readMode = window.__readMode || null;
// PLAN-SCALE §6f F1 — how to read the BASE MAP, which is a decision PER STORE and not per region
// (HANDOFF §0 rule 2): NL's roads ship beside the app and its base map does not, so the two are not
// read the same way. A country's base map is ~690 MB and only a viewport of it is ever on screen.
// The index may carry it per store; until a base block is published with one, inheriting the block's
// own read mode is right for both regions today (Enschede's 21 MB whole, a country's paged). Settable
// before load, like `__readMode`, so a gate can page the shipped city block on purpose.
window.__baseReadMode = window.__baseReadMode || null;
// The mode for a set of chosen blocks: PAGED if any of them says so. A whole-file load adopts an image,
// so mixing the two over one working set cannot work — and the big block is always the one that decides.
const modeOf = (blocks, kind) => {
  if (!blocks.length) return 'whole';
  return blocks.some((b) => (b[kind] && b[kind].readMode) === 'paged' || b.readMode === 'paged') ? 'paged' : 'whole';
};
// The camera block's mode, which is the right answer for every command that is NOT scoped to a box
// (reset, and the profiler hooks that drive a fixed sketch). Kept as a function so the override still
// works and so nothing reads a session-wide variable that no longer exists.
const READ_MODE = () => window.__readMode || coverage.block.readMode || 'whole';
const roadsModeFor = (b, z) => window.__readMode
  || modeOf(blocksChosenFor(coverage.index, b.mnla, b.mnlo, b.mxla, b.mxlo, 'roads', null, z), 'roads');
// The base mode, with the block's TIER FLOOR appended as `paged:N` when it has one (§6i O3b). The floor
// is the finest tier that store holds; keys below it are provably absent and an absent key still costs
// pages — 2469 asks and 169.6 MB against 82 and 43.7 on one z13 viewport of the middle-zoom block.
//
// The MINIMUM across the chosen set, because the floor must be low enough for every block being read: a
// set mixing a floored block with an unfloored one has to ask from 0 or the unfloored one loses its fine
// tiles. In practice the zoom bands make the set homogeneous.
const baseModeFor = (b, z) => {
  if (window.__baseReadMode) return window.__baseReadMode;
  const chosen = blocksChosenFor(coverage.index, b.mnla, b.mnlo, b.mxla, b.mxlo, 'roads', 'base', z);
  const mode = modeOf(chosen, 'base');
  if (mode !== 'paged' || !chosen.length) return mode;
  const floor = Math.min(...chosen.map((x) => (typeof x.tierFloor === 'number' ? x.tierFloor : 0)));
  return floor > 0 ? `${mode}:${floor}` : mode;
};
window.__coverage = coverage;
if (coverage.outside) console.warn(`[coverage] the camera is outside every block; showing ${coverage.block.id}`);

hud.textContent = 'loading kernel…';
const kernel = await createKernel(new URL('./store-kernel.wasm', location.href).href);

// The viewport bbox in degrees, padded by `pad` on each side.
function viewportBox(pad) {
  const tl = map.unproject(0, 0), br = map.unproject(map.width, map.height);
  const mnla = Math.min(tl.lat, br.lat), mxla = Math.max(tl.lat, br.lat);
  const mnlo = Math.min(tl.lon, br.lon), mxlo = Math.max(tl.lon, br.lon);
  const dla = (mxla - mnla) * pad, dlo = (mxlo - mnlo) * pad;
  return { mnla: mnla - dla, mnlo: mnlo - dlo, mxla: mxla + dla, mxlo: mxlo + dlo };
}
const covers = (o, i) => o && i.mnla >= o.mnla && i.mxla <= o.mxla && i.mnlo >= o.mnlo && i.mxlo <= o.mxlo;

// THE SCREEN FIRST, THEN A RING AROUND IT.
//
// The view used to read `viewportBox(0.6)` — 2.2 x 2.2 screens, 4.84 screens of area — in ONE kernel
// call, so the pixels the user is looking at waited for four screens of data they could not see. Two
// numbers replace that one: `VIEW_PAD` is what the first view reads and what the index covers, and the
// RING is eight screen-sized cells paged in AFTERWARDS, giving a full screen of data in every direction
// (3 x 3 = 9 screens) without the first paint paying for any of it.
//
// ⚠ `VIEW_PAD` is NOT a correctness margin. Features are keyed by their first vertex and overhang their
// cell (PLAN-PERF §7g), but both filters are already exact about it: `buildIndex` screens each tile on
// its own SEALED feature extent (`fmnla`/`fmxla`/…) and then each ring on its true span, so a feature
// whose key-cell lies outside the box still draws. The pad exists only so a one-pixel drift does not
// re-request, and it is small for exactly that reason.
const VIEW_PAD = 0.15;
// The ring, in the order it is paged. Straight neighbours before diagonals: a pan is far likelier to
// leave through an edge than a corner, and the queue can be interrupted at any step, so the order IS the
// priority. `[dx, dy]` in screen widths/heights.
const RING_CELLS = [[0, 1], [0, -1], [1, 0], [-1, 0], [1, 1], [1, -1], [-1, 1], [-1, -1]];

// One ring cell as a box: the screen translated by (dx, dy) screens, then padded like a view so adjacent
// cells overlap and no seam is left unpaged. Built from a SNAPSHOT of the screen, never from the live
// camera — the camera moves while the ring is being paged, and a cell computed from where the camera has
// got to would leave a hole where it started.
function ringCellBox(screen, dx, dy) {
  const w = screen.mxlo - screen.mnlo, h = screen.mxla - screen.mnla;
  const mnla = screen.mnla + dy * h, mxla = screen.mxla + dy * h;
  const mnlo = screen.mnlo + dx * w, mxlo = screen.mxlo + dx * w;
  const dla = h * VIEW_PAD, dlo = w * VIEW_PAD;
  return { mnla: mnla - dla, mnlo: mnlo - dlo, mxla: mxla + dla, mxlo: mxlo + dlo };
}

// PLAN-PERF §0 step 13 — which layer kinds render from the EXPOSED STORE rather than from loft's text.
// Grown one kind per commit, each proved equal to the text path before the next is added; loft's emit
// stays until every kind is here, and only then can it be deleted (§7f: that deletion is also what
// collapses step 9's per-view expose bracket).
const STORE_KINDS = ['areas', 'buildings', 'lines', 'pois', 'places', 'streetLabels'];
// What the APP still materialises as JS objects. Everything in STORE_GEOM_KINDS now renders straight out
// of the store (§6c), so materialising it too would retain exactly the 33 MB this exists to remove. Only
// the label kinds remain: they are 3,170 of 214,455 vertices (1.5%) and layoutLabels' collision pass is a
// separate piece of work. `storeRenderParity()` rebuilds the full set ON DEMAND, so the gate keeps both
// paths without the app paying for either.
const APP_OBJECT_KINDS = ['places', 'streetLabels'];
// PLAN-PERF §6c — the kinds the store-backed index currently covers. Grows one kind at a time, each
// proved pixel-identical against the object path before the next is added (buildings first: 145,214 of
// the viewport's 214,455 vertices, 68%).
const STORE_GEOM_KINDS = ['buildings', 'areas', 'lines', 'pois'];

// The viewport box in FIXED POINT (deg*1e7), built from the same 6-decimal strings the kernel parses so
// both sides round identically — `parse_fbox` reads exactly this text.
const fboxOf = (bbox) => {
  const p = bbox.split(',').map((s) => Math.round(parseFloat(s) * 1e7));
  return { mnla: p[0], mnlo: p[1], mxla: p[2], mxlo: p[3] };
};
const bboxOf = (b) => `${b.mnla.toFixed(6)},${b.mnlo.toFixed(6)},${b.mxla.toFixed(6)},${b.mxlo.toFixed(6)}`;

// The kernel's command blob is POSITIONAL, and it has grown past the point where writing one by hand is
// safe: line 5 is the roads read mode and line 7 the base map's (PLAN-SCALE §6f F1). A `view` built as
// four lines therefore reads BOTH as "whole" — which on a paged region is not a slower map, it is a
// blank one, because the working set is never asked for. So every view goes through here.
// (`match` / `find` / `reset` stop at line 6 and keep their literal form; if a line 8 is ever added,
// they come through here too.)
const viewCmd = (bbox, roads = ROADS, cmd = 'view', base = LAYOUT, box = null, z = undefined) =>
  [base, roads, cmd, bbox, '',
   box ? roadsModeFor(box, z) : (window.__readMode || coverage.block.readMode || 'whole'), '',
   box ? baseModeFor(box, z) : (window.__baseReadMode || coverage.block.readMode || 'whole')].join('\n');

let loadedBox = null, loadedBbox = null, lastViewText = null, loadedSrc = null;
// The `storeBase` the live store index was built against, and the ring's own generation. `indexBase` is
// what makes the ring safe to run without redrawing: a ring read is a kernel call like any other, so it
// can `memory.grow` and MOVE the store, and the index holds record numbers that are only meaningful
// against the base they were read from. Ring steps therefore compare and rebuild only on a change — the
// common case is that the store did not move and the drawn map is untouched.
let indexBase = null, ringGen = 0, ringStats = { planned: 0, done: 0, skipped: 0, abandoned: 0, ms: 0 };
// PLAN-EDIT E0, chokepoint 3 — the one way to reach the kernel. `runKernel` keeps a single resolve slot,
// so commands must be serialized; this does that AND coalesces per key, which the old shared `busy`
// boolean could not. Previously `busy` was held by both the view loader and the matcher, so a view in
// flight made a click return without matching and the route silently went stale (PLAN-EDIT §2 P4).
const jobs = new KernelQueue();

// The two dropdowns. Options are built from ACT so the markup carries no profile knowledge, and the
// value is validated against PROFILES — the kernel's own list — so a profile it cannot weigh never
// reaches a match request.
function initActivityControls() {
  const aSel = document.getElementById('activity'), sSel = document.getElementById('submode');
  if (!aSel || !sSel) return;
  const [act0, sub0] = (() => {
    const us = PROFILE.indexOf('_');
    const key = PROFILE.slice(0, us), sub = PROFILE.slice(us + 1);
    const name = Object.keys(ACT_KEY).find((k) => ACT_KEY[k] === key) || 'Walking';
    return [name, sub];
  })();
  aSel.innerHTML = Object.keys(ACT).map((a) => `<option${a === act0 ? ' selected' : ''}>${a}</option>`).join('');
  const fillSubs = (act, want) => {
    const subs = ACT[act];
    const pick = subs.some(([, id]) => id === want) ? want : subs[0][1];
    sSel.innerHTML = subs.map(([label, id]) => `<option value="${id}"${id === pick ? ' selected' : ''}>${label}</option>`).join('');
    return pick;
  };
  fillSubs(act0, sub0);

  // Changing either re-matches IMMEDIATELY — DESIGN §6's "lock in fast" win: a good first match from the
  // activity choice, with no point edits. It goes through `requestMatch`, the same chokepoint a gesture
  // uses, so there is still exactly one road to the kernel (PLAN-EDIT E0) and the queue still coalesces.
  const apply = () => {
    const act = aSel.value;
    const sub = sSel.value;
    const next = `${ACT_KEY[act]}_${sub}`;
    if (!PROFILES.includes(next) || next === PROFILE) return;
    PROFILE = next;
    // The overlay follows the activity, so the map has to be told and redrawn even when the sketch is
    // empty — changing the dropdown with no route on screen must still swap walk/cycle/mtb network.
    map.profile = PROFILE;
    // ⚠ The block raster cache holds the roads, so a re-render alone BLITS the old picture and the
    // overlay never changes (§6d: anything replacing layer data must invalidate). Measured: the canvas
    // hash was identical across all five activities until this line existed.
    map.invalidateBlocks();
    map.render();
    rememberCamera();                       // the fragment carries the profile, so a reload keeps it
    // `rough.coords()`, not `map.points` — the layer's array holds point OBJECTS while `requestMatch`
    // destructures [lat, lon] pairs, which is the shape `onCommit` passes. Getting that wrong re-matched
    // with a malformed sketch and left the old route on screen, so the gate saw two identical summaries.
    if (rough.coords().length >= 2) requestMatch(rough.coords());
    window.__storeApp = { ...(window.__storeApp || {}), profile: PROFILE };
  };
  aSel.addEventListener('change', () => { fillSubs(aSel.value, sSel.value); apply(); });
  sSel.addEventListener('change', apply);
  window.__storeApp = { ...(window.__storeApp || {}), profile: PROFILE };
}
initActivityControls();

// --- search (PLAN-RESTORE R4) ------------------------------------------------------------------------
// Types a name, gets our own answers. The old client asked Nominatim; this asks a 36 MB store that ships
// with the map, so it works with the network off — which is the point, since the same is true of routing.
//
// It goes through `jobs.post` like every other kernel call (PLAN-EDIT E0): `runKernel` keeps ONE resolve
// slot, so a second road to it does not merely race, it orphans a promise. A search typed during a match
// therefore waits its turn instead of eating the match's reply.
function initSearch() {
  const box = document.getElementById('search-input');
  const list = document.getElementById('search-results');
  if (!box || !list) return;
  let hits = [], timer = 0, seq = 0;

  const hide = () => { list.classList.add('hidden'); list.innerHTML = ''; hits = []; };
  const show = () => {
    if (!hits.length) { hide(); return; }
    list.innerHTML = hits.map((h, i) =>
      `<li role="option" data-i="${i}">${h.name.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}` +
      `<span class="kind">${h.kind === 1 ? 'place' : 'street'}</span></li>`).join('');
    list.classList.remove('hidden');
  };

  // A place gets a closer camera than a street only because a street is a line and you want its
  // surroundings; both keep the current zoom when it is already tighter, so searching does not throw
  // away a view you deliberately zoomed in.
  const goTo = (h) => {
    map.camera.lat = h.lat; map.camera.lon = h.lon;
    const want = h.kind === 1 ? 13 : 16;
    if (map.camera.zoom < want) map.camera.zoom = want;
    hide(); box.blur();
    rememberCamera(); ensureView();
  };

  const run = async (q) => {
    const mine = ++seq;
    const text = await jobs.post('find', () =>
      kernel.runKernel(`${LAYOUT}\n${ROADS}\nfind\n${map.camera.lat.toFixed(6)},${map.camera.lon.toFixed(6)},${q}\n\n${READ_MODE()}\n${NAMES}`));
    // A slower earlier query must not overwrite a newer one's results.
    if (mine !== seq) return;
    hits = [];
    for (const line of String(text || '').split('\n')) {
      if (!line.startsWith('FOUND ')) continue;
      // FOUND <lat>,<lon> <kind> <rank> <name>  — the name may contain spaces, so split only 3 times.
      const m = /^FOUND (-?[\d.]+),(-?[\d.]+) (\d+) (\d+) (.*)$/.exec(line);
      if (m) hits.push({ lat: +m[1], lon: +m[2], kind: +m[3], rank: +m[4], name: m[5] });
    }
    show();
  };

  box.addEventListener('input', () => {
    const q = box.value.trim();
    clearTimeout(timer);
    // Two characters is where the answers start being about what you typed; below it every street in the
    // country matches and the list is noise.
    if (q.length < 2) { hide(); return; }
    timer = setTimeout(() => run(q), 160);
  });
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { hide(); box.blur(); }
    else if (e.key === 'Enter' && hits.length) goTo(hits[0]);
  });
  list.addEventListener('click', (e) => {
    const li = e.target.closest('li');
    if (li && hits[+li.dataset.i]) goTo(hits[+li.dataset.i]);
  });
  window.__searchHooks = { run, results: () => hits, goTo };
}
initSearch();

// Load a viewport view only when the camera leaves the already-loaded area (a generous pad ⇒ small pans
// just re-draw the cached layers — no re-decode). Whole-region view would be ~230k lines and freeze.
//
// The pages this viewport needs, from every store that will answer it, fetched as ONE batch per store.
//
// `baseFor`/`roadsFor` return the covering set the kernel is about to read, so this asks the same
// question of the same stores — there is no second notion of "which block" to drift out of step.
let prefetchOn = true;
// ⚠ ONLY WHAT WILL BE READ BY RANGE. A `whole` store is one request for the entire file — there are no
// pages to plan, and asking the index about it is worse than useless: at z8 the country-wide viewport
// covers nearly every leaf, so the app read 3.6 MB of index (575 chunks) to prefetch a store it was about
// to download in one go. Measured on the boot camera, before this line existed. The overview is exactly
// that store, and it is the fastest step in a journey precisely because it is whole (design §8.2).
const isPaged = (m) => String(m || '').startsWith('paged');
async function prefetchFor(box, zoom) {
  if (!prefetchOn || !kernel.prefetch) return null;
  const b = { mnlo: Math.round(box.mnlo * 1e7), mnla: Math.round(box.mnla * 1e7),
              mxlo: Math.round(box.mxlo * 1e7), mxla: Math.round(box.mxla * 1e7) };
  // ⚠ THE COVERING SET IS COMMA-SEPARATED (`coverage.mjs` joins with ','), and splitting it on a SPACE
  // silently disabled the prefetch for every multi-block viewport: "a.store,b.store" is one token that
  // still ends in `.store`, so it passed the filter and then matched no store in the index. A border
  // screen — the case the covering set exists for — prefetched nothing at all.
  const urls = [...new Set([...(isPaged(baseModeFor(box, zoom)) ? (baseFor(box, zoom) || '').split(/[,\s]+/) : []),
                            ...(isPaged(roadsModeFor(box, zoom)) ? (roadsFor(box, zoom) || '').split(/[,\s]+/) : [])]
                          .filter((u) => u && u.endsWith('.store')))];
  const out = [];
  const t0 = performance.now();
  await Promise.all(urls.map(async (u) => {
    try {
      const pages = await pagesFor(u, b, PREFETCH_PAD);
      if (pages.length) out.push({ url: u, ...(await kernel.prefetch(u, pages)) });
    } catch { /* an index that will not read is not a reason to fail the view */ }
  }));
  // ⚠ WHAT THE BATCH COST, SEPARATELY FROM THE VIEW IT PRECEDES. Without this a prefetch that fetches
  // FAR MORE than the viewport needs is indistinguishable from one that fetches exactly right — both
  // land in "the view took N ms". Against the live host the prefetched arm took 33 s with 699 of 763
  // reads served from the buffer, and those two numbers alone cannot say where the time went.
  prefetchStats.batches++;
  prefetchStats.ms += Math.round(performance.now() - t0);
  for (const o of out) { prefetchStats.pages += o.pages || 0; prefetchStats.requests += o.requests || 0; }
  return out;
}
const prefetchStats = { batches: 0, ms: 0, pages: 0, requests: 0 };
// A feature is keyed by its FIRST VERTEX and never clipped, so it overhangs its cell — PLAN-PERF §7g
// measured up to 16 cells, which is why `PTile` carries a sealed extent rather than being screened by
// ox/oy. The index is keyed by ox/oy, so a padded query is the cheap approximation of that extent: too
// small and some pages miss (they are then fetched normally), too large and bytes are wasted.
// ⚠ AND IT IS THE WHOLE COST, NOT A MARGIN. A z14 viewport is ~0.05 deg tall; padding it by 0.16 deg on
// every side makes the QUERY box ~40x the area of the screen, so the pad — not the viewport — decides
// what is fetched. Measured on one Luxembourg screen at 0.16: 9 811 pages prefetched against 1 331 ever
// read, i.e. 86% waste. On a localhost harness that is free and the arm still wins on latency; against
// the live host it is 640 MB at 82 Mbps and the win disappears. The number that exposes it is not the
// hit rate (which asks "of the READS, how many were served") but its inverse — of the pages FETCHED, how
// many were used — and nothing measured that until the live run refused to reproduce.
// Settable before load, like `__readMode`, so a sweep can measure the trade rather than argue it.
const PREFETCH_PAD = window.__prefetchPad ?? 200000;   // 0.02 deg in fixed-point 1e-7

// The `covers` test lives INSIDE the job, so it is judged when the view actually runs rather than when it
// was queued — a camera that moved back over the loaded box while another job ran skips the load entirely.
function ensureView() { return jobs.post('view', ensureViewNow); }
async function ensureViewNow() {
  const box = viewportBox(VIEW_PAD);
  const zoom0 = map.camera.zoom;
  // WHAT THIS VIEW WOULD READ — the covering set and the modes, not just the box.
  //
  // ⚠ "The box is already loaded" is NOT enough once a zoom band exists, and shipping it that way broke
  // zooming in: booting on the country loads a `loadedBox` that CONTAINS every later viewport, so every
  // zoom-in was answered from the country data and no view was ever requested again. Reported from the
  // live site and reproduced exactly — z8 → z15 over Enschede left `viewSeq` at 1, `R=0`, 0 buildings,
  // while a direct load of the same camera drew 51 350. The box test cannot see a change of SOURCE, and
  // crossing the handover is exactly that.
  const src = `${baseFor(box, zoom0)}|${roadsFor(box, zoom0)}|${baseModeFor(box, zoom0)}|${roadsModeFor(box, zoom0)}`;
  // A pan that stays inside what is loaded is a re-draw, and it deliberately leaves the ring ALONE. The
  // ring is centred on the screen it was planned for, so a camera that has not left that screen is still
  // surrounded by it; retiring and re-planning here would re-page eight cells for a few pixels of drift.
  if (loadedSrc === src && covers(loadedBox, viewportBox(0.05))) { map.render(); return; }
  // Past here a real load happens, so the ring around the OLD screen is retired. The bump is what stops
  // the chain: every step checks its generation before doing anything.
  ringGen++;
  // A view whose SOURCE changed discards the store the map is drawn from, and a paged one takes hundreds
  // of range requests to replace it — so hold the last good frame and keep painting it, stretched to the
  // camera, until real data lands. Only on a source change: a plain pan already has its data and holding
  // a frame there would put stale pixels under a live map for no reason.
  if (loadedSrc !== null && loadedSrc !== src) map.holdFrame();
  const bbox = `${box.mnla.toFixed(6)},${box.mnlo.toFixed(6)},${box.mxla.toFixed(6)},${box.mxlo.toFixed(6)}`;
  hud.textContent = 'loading map…';
  const t0 = performance.now();
  const zoom = zoom0;
  // ⚠ PREFETCH BEFORE THE KERNEL RUNS, not alongside it. The kernel's range reads are SERIAL — it asks,
  // suspends, waits, resumes — so anything issued after `runKernel` starts is racing a chain it cannot
  // shorten. Fetching the pages first, concurrently, is the entire mechanism: measured 4.79x faster to
  // the same view (26.0 s -> 5.4 s at a 26 ms round trip). docs/prefetch-index-design.md.
  //
  // It degrades to today's behaviour at every step: a block with no `.pagesx` returns [], a page the
  // index does not name simply misses and is fetched the old way. Nothing here can make the map WRONG —
  // the store is unchanged and every byte is still verified by the loader.
  await prefetchFor(box, zoom);
  const text = await kernel.runKernel(viewCmd(bbox, roadsFor(box, zoom), 'view', baseFor(box, zoom), box, zoom));
  map.loadRoadsFlat(text, roadsFloorFor(box, zoom));
  // PLAN-PERF §0 step 13 — every layout kind renders from the exposed store. `view` is now ROADS ONLY,
  // so `map.loadView` above parses only the R lines; the layout costs loft nothing to serialise and,
  // because loft no longer walks it either, the `expose` pin survives the whole session (§7f).
  //
  // The read happens AFTER the kernel call because the pin is only guaranteed once the command returns.
  // Both the handle and `memory()` are re-fetched every time — a memory.grow during the call detaches
  // the old buffer and moves the store.
  //
  // Parity moved to the gate: with no layout text there is nothing to diff against per view, so
  // `viewParity()` below asks for `viewtext` explicitly and compares. That keeps the check honest
  // without paying for it on every user-facing view.
  const counts = {};
  const h = kernel.exposedValue ? kernel.exposedValue(1) : null;
  if (h) {
    const lists = viewRenderLists(viewFromStore(kernel.memory(), h, fboxOf(bbox), { flatCount, flatField }, APP_OBJECT_KINDS));
    for (const k of APP_OBJECT_KINDS) { counts[k] = lists[k].length; map[k] = lists[k]; }
    for (const k of STORE_GEOM_KINDS) map[k] = [];              // never materialised — drawn from the store
    // PLAN-PERF §6c — the store-backed index, built BESIDE the object lists above and (for now) driving
    // only buildings. Additive on purpose: while both exist the gate can prove they draw the same pixels,
    // and only then does the object path go. It costs one walk of the same tiles and retains typed arrays
    // instead of 145k boxed vertex pairs.
    const idx = buildIndex(kernel.memory(), h, storeLayout(h), fboxOf(bbox), STORE_GEOM_KINDS);
    map.setStoreIndex(idx, () => kernel.memory(), h.storeBase);
    indexBase = h.storeBase;      // what the ring compares against — see `pageRingCell`
    for (const k of STORE_GEOM_KINDS) counts[k] = idx[k].n;
  }
  loadedBox = box; loadedBbox = bbox; lastViewText = text; loadedSrc = src;
  // PLAN-LAYERS §5 (L3) — the ground this view is ACTUALLY holding, which is what the floor draws around.
  // The intersection of the box that was read with the extents of the blocks that answered it: a viewport
  // wider than the data gets a held box narrower than the screen, and the floor fills the rest.
  // PLAN-LAYERS §5 — THE FLOOR IS A BY-PRODUCT OF THE VIEW THAT ALREADY READ IT.
  //
  // A bare visit opens on the country, so the store the kernel is holding right now IS the overview.
  // Snapshotting it here costs one walk of tiles already decoded and NO fetch — where the lazy path below
  // costs 33.7 MB. That asymmetry decides the policy: take it for free when it is already here, and buy it
  // only when a view has left ground uncovered and the user would otherwise be looking at nothing.
  if (h && floorState === 'idle' && baseFor(box, zoom) === floorUrl()) {
    const lists = viewRenderLists(viewFromStore(kernel.memory(), h, fboxOf(bbox), { flatCount, flatField }, STORE_KINDS));
    const blk = floorBlock();
    if (blk && lists.areas.length) {
      map.setFloor(lists, blk.base.bbox);
      floorState = 'ready';
      window.__storeApp = { ...(window.__storeApp || {}), floor: floorReport(lists, 'free') };
    }
  }
  // What the view RETURNED decides whether this ground counts as held — see `heldGroundFor`.
  const gotFeatures = Object.values(counts).reduce((a, b) => a + b, 0) > 0
                   || (map.streetsFlat ? map.streetsFlat.n : 0) > 0;
  map.setHeldGround(heldGroundFor(box, zoom, gotFeatures));
  map.releaseFrame();                    // real data is in — the held pixels have done their job
  map.render();
  ensureFloor(box, zoom, gotFeatures);   // fetched on first NEED, never at boot — see below
  const sum = text.split('\n').find((l) => l.startsWith('# view')) || '(no view)';
  // PLAN-LAYERS §5 (L3), step 12 — SAY IT when there is nothing here.
  //
  // A viewport past the data drew a blank page and reported a view line, while `resolveCoverage` named a
  // block 300 km away — so "outside the map" was indistinguishable from "the app is broken", which is
  // what it was reported as. The floor draws whatever the country has; where even that is empty the
  // honest answer is a sentence, not an empty canvas.
  const floorDrew = (map._floorStats && map._floorStats.drawn) || 0;
  if (!gotFeatures && !floorDrew) {
    hud.textContent = 'no map data here — the Netherlands is the dataset; pan back west';
  } else {
    hud.textContent = `${sum.replace('# view: ', '')} · ${Math.round(performance.now() - t0)}ms — click to route`;
  }
  // The app's OWN first view is the only genuinely cold one — it pays the session's store load. Every
  // __perfHooks.timedView after it is warm, so the profiler cannot see the load unless we record it here.
  const ms = performance.now() - t0;
  // `viewSeq` counts COMPLETED views. A driver that panned and then waited on `lastViewMs` would be
  // waiting on a number that can legitimately repeat, and would read the PREVIOUS viewport's counts as
  // the new one's — so the gate needs something that only ever goes up (tools/base_paged_gate.sh).
  window.__storeApp = { ...(window.__storeApp || {}), viewOk: /R=\d+/.test(sum), view: sum,
                        firstViewMs: window.__storeApp?.firstViewMs ?? ms, lastViewMs: ms,
                        viewSeq: (window.__storeApp?.viewSeq || 0) + 1, viewBbox: bbox,
                        layerCounts: counts, areaSource: h ? 'store' : 'text' };
  // The screen is on the glass; NOW go and get its surroundings. Scheduled after every measurement above
  // so the ring can never be charged to `lastViewMs` — it is work that happens after the view is done.
  scheduleRing(viewportBox(0), zoom);
}

// Page one screen of data in each direction, so the next pan finds its data already resident.
//
// ⚠ THE RING IS CHAINED, NOT FANNED OUT, and that is the whole design. `KernelQueue` runs one job at a
// time in insertion order and cannot preempt a RUNNING job, so posting all eight cells at once would put
// a user's next click or pan BEHIND eight screens of paging — turning a prefetch meant to make the app
// feel faster into up to eight screens of added latency on the very interaction it exists to serve. Each
// step posts the next instead, so at most ONE ring cell is ever queued and a user action waits for at
// most one cell.
//
// Cells are paged with the ordinary `view` command and the result is DISCARDED: what the ring is buying
// is the range reads (`store_load_keys` ACCUMULATES into the same store, so nothing is fetched twice),
// not the text. Nothing is rendered and no index is rebuilt — see the storeBase guard below.
function scheduleRing(screen, zoom) {
  const gen = ringGen;
  ringStats = { planned: 0, done: 0, skipped: 0, abandoned: 0, ms: 0, gen };
  // A block read WHOLE is already entirely resident, so a ring around it would be eight kernel calls that
  // fetch nothing. The ring is a paging optimisation and it belongs only where there is paging to do.
  if (roadsModeFor(screen, zoom) !== 'paged' && baseModeFor(screen, zoom) !== 'paged') {
    ringStats.skipped = RING_CELLS.length;
    window.__storeApp = { ...(window.__storeApp || {}), ring: { ...ringStats, why: 'whole' } };
    return;
  }
  ringStats.planned = RING_CELLS.length;
  postRingStep(gen, screen, zoom, 0);
}

// THE RING IS COMPLETE — WIDEN ONTO IT. Every one of the nine screens is resident now, so rebuilding the
// index over the whole 3 x 3 box costs one walk of tiles already in memory and NOT ONE FETCH. After this a
// pan anywhere inside the ring is a redraw and nothing else: no kernel call, no range read, no wait.
//
// This is what keeps the small `VIEW_PAD` honest. Reading one screen makes the FIRST paint fast, but on its
// own it would also make the app hold LESS ground than the old 2.2-screen box did, so panning would re-view
// more often, not less. Promotion is the other half: fast first, then wider than before.
//
// ⚠ Only when the whole 3 x 3 box resolves to the SAME SOURCE. A neighbouring screen can belong to a
// different block — the coverage is a set of blocks and at a border it changes mid-ring — and claiming the
// centre's source covers it would let a later pan SKIP the view that would have loaded the right block, and
// draw a hole instead. That is exactly the failure `ensureViewNow`'s `src` test exists to prevent, one box
// larger, and it is why this compares rather than assumes.
function promoteRing(screen, zoom) {
  const w = screen.mxlo - screen.mnlo, h = screen.mxla - screen.mnla;
  const box3 = { mnla: screen.mnla - h, mxla: screen.mxla + h, mnlo: screen.mnlo - w, mxlo: screen.mxlo + w };
  const src3 = `${baseFor(box3, zoom)}|${roadsFor(box3, zoom)}|${baseModeFor(box3, zoom)}|${roadsModeFor(box3, zoom)}`;
  if (src3 !== loadedSrc) { ringStats.promoted = 'source-differs'; return; }
  // A ring with skipped cells did not fill the box, so widening onto it would claim ground the app does
  // not hold — the map would then answer a pan into that cell from an index that has nothing there, and
  // draw an empty screen instead of reloading. Hold the smaller, honest box.
  if (ringStats.skipped) { ringStats.promoted = `incomplete (${ringStats.skipped} skipped)`; return; }
  const hh = kernel.exposedValue ? kernel.exposedValue(1) : null;
  if (!hh) { ringStats.promoted = 'no-handle'; return; }
  const bbox3 = bboxOf(box3), fb = fboxOf(bbox3);
  const lists = viewRenderLists(viewFromStore(kernel.memory(), hh, fb, { flatCount, flatField }, APP_OBJECT_KINDS));
  for (const k of APP_OBJECT_KINDS) map[k] = lists[k];
  const idx = buildIndex(kernel.memory(), hh, storeLayout(hh), fb, STORE_GEOM_KINDS);
  map.setStoreIndex(idx, () => kernel.memory(), hh.storeBase);
  indexBase = hh.storeBase;
  loadedBox = box3; loadedBbox = bbox3;
  // The held ground widens with the data, or the floor keeps drawing over ground the fine layer now holds.
  const got = STORE_GEOM_KINDS.some((k) => idx[k].n > 0) || APP_OBJECT_KINDS.some((k) => lists[k].length > 0);
  map.setHeldGround(heldGroundFor(box3, zoom, got));
  ringStats.promoted = 'ok';
  map.render();
}

function postRingStep(gen, screen, zoom, i) {
  if (gen !== ringGen || i >= RING_CELLS.length) return;
  jobs.post('ring', async () => {
    // Checked again HERE, not only at post time: the camera can move while this job sits in the queue,
    // and a ring cell around a screen the user has already left is work bought for nobody.
    if (gen !== ringGen) { ringStats.abandoned = RING_CELLS.length - ringStats.done; return; }
    const [dx, dy] = RING_CELLS[i];
    const cell = ringCellBox(screen, dx, dy);
    // ⚠ A RING CELL MUST NEVER CHANGE THE SOURCE. A neighbouring screen can resolve to a different block
    // — around Amsterdam at country scale the ring reaches into other regions — and asking the kernel to
    // load one mid-ring pulls a foreign store into a session whose layout store is exposed. That TRAPS:
    // `RuntimeError: unreachable` out of wasm, measured as `nl_live_gate` dying on the match after it.
    //
    // A prefetch has no business changing what the app is reading. Cells that would are SKIPPED, and
    // crossing a block boundary stays what it already is: the view's own path, which holds the last frame
    // and reloads deliberately. This is `promoteRing`'s guard applied one cell at a time.
    const cellSrc = `${baseFor(cell, zoom)}|${roadsFor(cell, zoom)}|${baseModeFor(cell, zoom)}|${roadsModeFor(cell, zoom)}`;
    if (cellSrc !== loadedSrc) {
      ringStats.skipped++;
      window.__storeApp = { ...(window.__storeApp || {}), ring: { ...ringStats } };
      postRingStep(gen, screen, zoom, i + 1);
      return;
    }
    const t0 = performance.now();
    try {
      // The ring pays the SAME serial round trips the view used to, and there are eight of them: measured
      // on one Luxembourg screen, the view read 455 ranges and the ring behind it read 1 296. So a cell
      // plans its pages first, exactly as the view does — the index is already open, the cell is one
      // screen, and its chunks are usually the ones the view just read (design §5.5).
      //
      // ⚠ It stays BEHIND the critical path by construction: the ring is chained, one cell at a time,
      // and this runs inside a cell's own job. Nothing here can be issued before the screen is drawn.
      await prefetchFor(cell, zoom);
      await kernel.runKernel(viewCmd(bboxOf(cell), roadsFor(cell, zoom), 'view', baseFor(cell, zoom), cell, zoom));
    } catch (err) {
      // A ring cell that fails is a prefetch that did not happen — never a broken map. The screen is
      // already drawn from its own view, so the honest response is to record it and carry on.
      console.warn(`[ring] cell ${dx},${dy} failed:`, err);
    }
    ringStats.ms += performance.now() - t0;
    ringStats.done++;
    if (i === RING_CELLS.length - 1 && gen === ringGen) {
      promoteRing(screen, zoom);          // the last cell — the whole ring is resident, so widen onto it
    } else {
      // ⚠ THE STORE CAN MOVE UNDER THE DRAWN MAP. A ring read is a kernel call like any other, so it can
      // grow wasm memory and relocate the store; the live index holds RECORD NUMBERS, which are only
      // meaningful against the base they were read from. Rebuilding unconditionally would make the ring
      // cost a full index walk per cell; rebuilding never would draw garbage the one time it matters. So
      // compare, and pay only on a change.
      const h = kernel.exposedValue ? kernel.exposedValue(1) : null;
      if (h && indexBase !== null && h.storeBase !== indexBase && loadedBbox) {
        const idx = buildIndex(kernel.memory(), h, storeLayout(h), fboxOf(loadedBbox), STORE_GEOM_KINDS);
        map.setStoreIndex(idx, () => kernel.memory(), h.storeBase);
        indexBase = h.storeBase;
        ringStats.rebuilt = (ringStats.rebuilt || 0) + 1;
        map.render();
      }
    }
    window.__storeApp = { ...(window.__storeApp || {}), ring: { ...ringStats } };
    postRingStep(gen, screen, zoom, i + 1);
  });
}

// Run a match and let the route DRAW ITSELF as it arrives (PLAN-PERF §6b(2)).
//
// The kernel emits each matched sub-path as `STRETCH i;…` and yields, so the sink below runs once per
// stretch, mid-match, and the line grows in travel order — the direction the user will actually travel.
// Until this existed the yields bought responsiveness only: the page kept painting, but it painted
// nothing new until `#EOR`.
//
// The final ROUTE still replaces whatever streamed, so this cannot alter the delivered route — the
// growing line is strictly a view of the same match, and `tools/match_parity.sh` is untouched by it.
// `growSteps` records how many times the drawn route actually advanced, so the app's OWN path is
// observable to the gate and not just the probe's.
// The blocks a MATCH must be able to read: the sketch's own bbox, padded generously. The kernel widens a
// corridor by its margin (up to ~1 km) plus a cell ring, so the padding here has to be at least that or a
// corridor could want a block the app never named. 0.05° ≈ 5.5 km is comfortably beyond it, and naming a
// block that turns out to hold nothing costs one request that returns nothing.
const SKETCH_PAD_DEG = 0.05;
function roadsForSketch(spec) {
  let mnla = Infinity, mnlo = Infinity, mxla = -Infinity, mxlo = -Infinity;
  for (const tok of String(spec).split(';')) {
    const [la, lo] = tok.split(',').map(Number);
    if (!Number.isFinite(la) || !Number.isFinite(lo)) continue;
    if (la < mnla) mnla = la; if (la > mxla) mxla = la;
    if (lo < mnlo) mnlo = lo; if (lo > mxlo) mxlo = lo;
  }
  if (!Number.isFinite(mnla)) return ROADS;
  return roadsFor({ mnla: mnla - SKETCH_PAD_DEG, mnlo: mnlo - SKETCH_PAD_DEG,
                    mxla: mxla + SKETCH_PAD_DEG, mxlo: mxlo + SKETCH_PAD_DEG });
}

// The mode for a match, from the SAME box that chose its blocks — `roadsForSketch` pads the sketch and
// can name a country block from a camera sitting over a city one, which is exactly the mismatch that
// made a 774 MB base map download as one file.
function sketchBox(spec) {
  let mnla = Infinity, mnlo = Infinity, mxla = -Infinity, mxlo = -Infinity;
  for (const tok of String(spec).split(';')) {
    const [la, lo] = tok.split(',').map(Number);
    if (!Number.isFinite(la) || !Number.isFinite(lo)) continue;
    if (la < mnla) mnla = la; if (la > mxla) mxla = la;
    if (lo < mnlo) mnlo = lo; if (lo > mxlo) mxlo = lo;
  }
  if (!Number.isFinite(mnla)) return null;
  return { mnla: mnla - SKETCH_PAD_DEG, mnlo: mnlo - SKETCH_PAD_DEG,
           mxla: mxla + SKETCH_PAD_DEG, mxlo: mxlo + SKETCH_PAD_DEG };
}
// One kilometre: measured to route where 3 km does not, with the working end of the range (2 km) left as
// margin. It is the step a segment is BROKEN INTO, not a threshold — a segment shorter than this is
// untouched, which is why an ordinary sketch never sees this code.
const DENSIFY_STEP_M = 1000;

const matchMode = (spec) => { const b = sketchBox(spec); return b ? roadsModeFor(b) : READ_MODE(); };

async function streamedMatch(spec, isCurrent) {
  map.beginStretches();
  let growSteps = 0, lastLen = 0;
  const text = await kernel.runKernel(`${LAYOUT}\n${roadsForSketch(spec)}\nmatch\n${spec}\n${PROFILE}\n${matchMode(spec)}`, (line) => {
    // A line sink is drained in a microtask, so one belonging to a SUPERSEDED match could still fire once
    // a newer match has begun and blend two routes into the same stretch accumulator (PLAN-EDIT failure
    // path 10). The generation check makes that impossible rather than unlikely.
    if (isCurrent && !isCurrent()) return;
    const s = parseStretch(line);
    if (!s) return;
    map.applyStretch(s.i, s.pts);
    if (map.route.length > lastLen) { lastLen = map.route.length; growSteps++; }
  });
  // Record what the user was actually looking at just before the final ROUTE replaced it. `growSteps`
  // alone would still pass if parseStretch mis-read the lines and the line grew as garbage, so the ENDS
  // are captured too: loft stitches these same sub-paths into the ROUTE with push_pt + remove_spurs, both
  // of which only ever DROP points, so a correct stream must end at the same two coordinates and carry at
  // least as many points as the finished route.
  const r = map.route;
  window.__storeApp = { ...(window.__storeApp || {}), growSteps, streamedPts: r.length,
                        streamedEnds: r.length ? [r[0], r[r.length - 1]] : null };
  return text;
}

// The rough sketch (PLAN-EDIT E0). The layer owns the points and ALL pointer input; this wiring is the
// whole of the app's side of editing, and every later gesture rides it unchanged — which is the point of
// the chokepoints: a new gesture mutates the point list and calls commitEdit, and nothing else.
// PLAN-EDIT E9 — AUTOSAVE THE SKETCH, because a session can end without being finished.
//
// Reported from the live site: a route was drawn, the page was reloaded, and the sketch was gone — and
// the kernel had stopped answering in the same session, so there was no way to redraw it either. The
// second half is a bug to find; the first half is a promise the app was not making, and this makes it.
//
// ⚠ ONE WRITE PER 10 s, LEADING AND TRAILING. Leading, so the first point is protected the instant it
// exists rather than 10 s later — the reported case is a session that ends unexpectedly, and a window
// where the work is not yet saved is exactly the window that loses it. Trailing, so the LAST state of a
// burst is what ends up stored. A drag emits ~33 commits a second and each one would otherwise be a
// synchronous JSON serialise + storage write on the gesture's own frame.
const SKETCH_SAVE_MS = 10000;
let sketchTimer = null, sketchPending = null;
function saveSketchNow() {
  if (!sketchPending) return;
  const text = sketchToJson(sketchPending, 0);
  sketchPending = null;
  try {
    if (text === null) localStorage.removeItem(SKETCH_KEY);   // over the cap — see SKETCH_MAX_PTS
    else localStorage.setItem(SKETCH_KEY, text);
    window.__storeApp = { ...(window.__storeApp || {}), sketchSaves: (window.__storeApp?.sketchSaves || 0) + 1 };
  } catch (e) {
    // A full or disabled storage must not take the app down with it: the sketch on screen is still the
    // truth, and this is a safety net, not the thing being edited.
    console.warn('sketch autosave failed:', e);
  }
}
function saveSketchSoon(pts) {
  sketchPending = pts.map(([a, b]) => [a, b]);
  if (sketchTimer) return;                       // a write is already scheduled — it will take the latest
  saveSketchNow();                               // …but protect what exists NOW, before the window opens
  sketchTimer = setTimeout(() => { sketchTimer = null; saveSketchNow(); }, SKETCH_SAVE_MS);
}
// The tab going away is the case the throttle would otherwise lose. `pagehide` covers reload, navigation
// and close; `visibilitychange` covers a phone being switched away from, which on iOS is where a tab is
// most likely to be discarded without ever firing anything else.
window.addEventListener('pagehide', saveSketchNow);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveSketchNow(); });

const rough = new RoughLayer(map, {
  onCommit: (pts) => { saveSketchSoon(pts); return requestMatch(pts); },
  deleteButton: document.getElementById('rough-delete'),   // bound BY the layer — see rough.mjs bind()
  snackbar: { el: document.getElementById('undo-snackbar'),
              label: document.getElementById('undo-snack-label'),
              button: document.getElementById('undo-snack-btn') },
  boxElement: document.getElementById('select-box'),
});

// PLAN-EDIT E8 — the route bar: how long this route is, and a way to take it with you.
//
// ONE function owns both, called from every path that lands a route (the sketch, and the `__match` test
// hook), because a bar updated at two sites is a bar that eventually disagrees with the map. The length
// is loft's — `routeDistanceM` parses it, nothing here measures geometry.
const routeBar = document.getElementById('route-bar');
const routeDistEl = document.getElementById('route-dist');
const routeGpxBtn = document.getElementById('route-gpx');
let routeSummary = '';
function showRoute(summary) {
  routeSummary = summary || '';
  const m = routeDistanceM(routeSummary);
  const show = m !== null && map.route.length >= 2;
  if (routeDistEl) routeDistEl.textContent = show ? formatDistance(m) : '';
  if (routeBar) routeBar.classList.toggle('hidden', !show);
  window.__storeApp = { ...(window.__storeApp || {}), routeDistM: show ? m : null,
                        routeDistText: show ? formatDistance(m) : '' };
}

// The document is built from `map.route` — the route on screen, not the one a summary describes — so a
// download can never disagree with what is drawn. `<a download>` + an object URL is the whole mechanism;
// revoked on the next tick, because a blob held for the session is a leak the size of the route.
if (routeGpxBtn) {
  routeGpxBtn.addEventListener('click', () => {
    if (map.route.length < 2) return;
    const dist = formatDistance(routeDistanceM(routeSummary));
    const doc = routeGpx(map.route, `routing ${PROFILE}${dist ? ` · ${dist}` : ''}`);
    const url = URL.createObjectURL(new Blob([doc], { type: 'application/gpx+xml' }));
    const a = document.createElement('a');
    a.href = url; a.download = 'route.gpx';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    // Counted so the browser gate can assert the REAL button did the work — a hook that builds the
    // document by a private road would prove the format and nothing about the wiring.
    window.__storeApp = { ...(window.__storeApp || {}), gpxBytes: doc.length,
                          gpxPts: (doc.match(/<trkpt /g) || []).length,
                          gpxDownloads: (window.__storeApp?.gpxDownloads || 0) + 1 };
  });
}

// Below two points there is no route to draw. Clearing it here rather than leaving the last one on screen
// is what makes a delete-down-to-one-point degrade instead of lying (PLAN-EDIT failure path 8).
function requestMatch(pts) {
  if (pts.length < 2) {
    map.setRoute([]); map.render();
    hud.textContent = `sketch ${pts.length} pt — add ≥2 to route`;
    window.__storeApp = { ...(window.__storeApp || {}), routePts: 0, summary: '' };
    showRoute('');
    return Promise.resolve();
  }
  hud.textContent = 'matching…';
  return jobs.post('match', async (isCurrent) => {
    const spec = (p) => p.map(([a, b]) => `${a},${b}`).join(';');
    let text = await streamedMatch(spec(pts), isCurrent);
    // A superseded match's route must not land: the user has already edited past it, and drawing it would
    // put a route on screen for a sketch that no longer exists. The newer job is already queued.
    if (!isCurrent()) return;
    let sum = map.loadMatch(text);
    // PLAN-SCALE §6i O2 — RETRY DENSIFIED, and only when the first attempt handed the sketch back.
    //
    // A tube corridor around two distant points is a straight band the roads need not follow, so the
    // match returns the trace unchanged. Measured on one Amsterdam corridor: 1 km spacing routes, 2 km
    // routes, 3 km does not. At z16 a drag is metres and this never fired; the country view makes a
    // 100-pixel drag ~40 km, which is the failing case as the ORDINARY gesture.
    //
    // ⚠ IT IS A FALLBACK, NOT A PREPROCESS, and that is deliberate. Densifying every sketch would change
    // the route for every sketch whose points are more than a kilometre apart — including the ones that
    // already route perfectly well (the Enschede corpus spans 3.5-4.8 km between points and matches
    // fine), and a route-affecting change is gated on the 26-sketch corpus with 0 worse accepted. Firing
    // only on the echo leaves every working match byte-identical and costs nothing but a retry on the
    // case that returned nothing at all.
    if (isSketchEcho(map.route, pts)) {
      const dense = densifySketch(pts, DENSIFY_STEP_M);
      if (dense.length > pts.length) {
        hud.textContent = `matching… (${dense.length} pts)`;
        // Counted, because the property that matters is that it does NOT fire on an ordinary sketch:
        // a retry on a match that already worked would be a route-affecting change (§6i O2).
        window.__storeApp = { ...(window.__storeApp || {}),
                              densifyRetries: (window.__storeApp?.densifyRetries || 0) + 1 };
        text = await streamedMatch(spec(dense), isCurrent);
        if (!isCurrent()) return;
        sum = map.loadMatch(text);
      }
    }
    map.render();
    showRoute(sum);
    // The distance leads, because it is the thing being asked; the kernel's own line stays behind it
    // rather than being replaced, since it is what every gate and every bug report quotes.
    const d = formatDistance(routeDistanceM(sum));
    hud.textContent = sum ? (d ? `${d} · ${sum}` : sum) : '(no route)';
    window.__storeApp = { ...(window.__storeApp || {}), matchOk: /ways=\d+/.test(sum), summary: sum,
                          routePts: map.route.length, matchRuns: (window.__storeApp?.matchRuns || 0) + 1 };
  });
}

map.onMove(ensureView);        // re-view when the camera settles outside the loaded area
map.onMove(rememberCamera);    // …and record where it settled, so a reload comes back here
await ensureView();       // initial load

// PLAN-EDIT E9 — and the sketch comes back with it.
//
// AFTER the first view, not before: `setPoints` commits, which posts a match, and a match queued ahead of
// the initial view would make the app's first act a corridor read for a route nobody is looking at yet.
// The points are drawn either way — the sketch layer does not need the kernel to show them, which is the
// whole point of restoring on the session where the kernel is what broke.
//
// Ids are minted fresh (1..n) rather than stored: they are session-local handles for the double-click
// detector and the selection anchors, and a restored sketch is a new session's starting point.
{
  let saved = [];
  try { saved = sketchFromJson(localStorage.getItem(SKETCH_KEY)); } catch { saved = []; }
  if (saved.length) {
    rough.setPoints(saved.map(([lat, lon], i) => ({ id: i + 1, lat, lon })));
    window.__storeApp = { ...(window.__storeApp || {}), sketchRestored: saved.length };
  }
}
window.__storeApp = { ...(window.__storeApp || {}), ready: true };

// Perf hook (headless profiler, browser/cdp_profile.mjs): run a view/match with each phase timed
// separately, so the bottleneck is ATTRIBUTED — wasm-side (store decode + text serialize) vs JS-side
// (text parse) vs render — instead of assumed. Test-only; the app itself never calls it.
window.__map0 = map;   // test hook: the live RouteMap, for render-comparison probes
// Test hook: the live sketch. The gate asserts on THIS rather than on `map.points`, because they are the
// same array by reference and the layer is what owns it — asserting on the copy is how the old gate could
// have passed while the sketch it was meant to measure said something else (PLAN-EDIT failure path 11).
window.__rough = rough;
window.__jobs = jobs;
window.__perfHooks = {
  kernelStats: () => (kernel.stats ? kernel.stats() : null),
  // docs/prefetch-index-design.md — hand the bridge the pages a viewport needs, ALL AT ONCE, so the
  // kernel's reads become synchronous buffer hits instead of 764 serial round trips. Exposed as a probe
  // rather than wired into the view: the app cannot compute a cell key (JS works in bboxes, loft in
  // tkeys), so a real integration needs the index re-keyed spatially. This proves the CLAIM first.
  prefetch: (url, pages, c) => kernel.prefetch(url, pages, c),
  // The wired path, for a gate to drive and assert on rather than infer from timings.
  prefetchFor: (box, zoom) => prefetchFor(box || viewportBox(VIEW_PAD), zoom ?? map.camera.zoom),
  pageIndexStats: () => indexStats(),
  // What the batches themselves cost — the view's own wait, attributed away from the kernel loop.
  prefetchStats: () => ({ ...prefetchStats }),
  setPrefetch: (on) => { prefetchOn = !!on; return prefetchOn; },
  // HAS THE APP SETTLED? Every counter a gate asserts on — range reads, bytes, the expose bracket — is
  // only meaningful about a session that has stopped working. The ring keeps paging after the view that
  // scheduled it has finished and reported its milliseconds, so "the last view completed" no longer
  // implies "nothing is in flight". A driver that snapshots without waiting on this reads a kernel call
  // in progress and, for the expose bracket specifically, sees the pin as missing when it is merely
  // mid-command. Same family as PLAN-PERF §7e's "wait for the view to CHANGE before measuring it".
  settled: () => !jobs.busy,
  ringStats: () => ({ ...ringStats, busy: jobs.busy }),
  // PLAN-SCALE C2 — run a match through the APP's own path with a caller-supplied sketch, and report the
  // covering set the app named for it. The cross-block gate needs both halves: the route, to compare
  // against the single-block answer, and the URL list, to prove the command really addressed two blocks
  // rather than quietly falling back to one.
  matchSpec: async (spec) => {
    const roads = roadsForSketch(spec);
    await kernel.runKernel(`${LAYOUT}\n${roads}\nreset`);
    const text = await kernel.runKernel(`${LAYOUT}\n${roads}\nmatch\n${spec}\n${PROFILE}\n${READ_MODE()}`);
    const summary = (text.split('\n').find((l) => l.startsWith('SUMMARY')) || '').trim();
    // A hash of the ROUTE lines, not just the summary: two different routes can share a length to 0.1 m.
    const route = text.split('\n').filter((l) => l.startsWith('ROUTE')).join('\n');
    let h = 0;
    for (let i = 0; i < route.length; i++) h = (Math.imul(h, 31) + route.charCodeAt(i)) | 0;
    return { roads, blocks: roads.split(',').length, summary, routeHash: (h >>> 0).toString(16), routeBytes: route.length };
  },
  // §6i O2's observable — the retry's DECISION, with the app's own functions and its own step constant.
  //
  // The firing itself cannot be gated against the small local block: an echo needs a corridor that holds
  // ways but no path through them, and the shipped city block routes everything at the distances where
  // Amsterdam echoes (measured: it echoes at 3 km there, and not here at 4.8 km). So the gate asserts the
  // WIRING — that these are the functions the retry consults, at this spacing — while `map.test.mjs`
  // covers the functions and the live measurement covers the firing.
  densifyProbe: (pts, route) => ({ echo: isSketchEcho(route, pts), step: DENSIFY_STEP_M,
                                   dense: densifySketch(pts, DENSIFY_STEP_M).length }),
  // Step 9's observable: did loft actually hand JS a usable handle to the layout store?
  exposeInfo: () => {
    const e = kernel.exposedValue ? kernel.exposedValue(1) : null;
    if (!e) return null;
    const nodes = e.desc && e.desc.nodes ? Object.keys(e.desc.nodes).length : 0;
    const names = e.desc && e.desc.names ? (Array.isArray(e.desc.names) ? e.desc.names : Object.values(e.desc.names)) : [];
    return { storeBase: e.storeBase, rec: e.rec, pos: e.pos, typeId: e.typeId, descLen: e.descLen,
             descNodes: nodes, sampleNames: names.slice(0, 12), wasmMB: +(kernel.memory().buffer.byteLength / 1048576).toFixed(1) };
  },
  // Step 10's observable: can JS actually READ a tile out of the exposed store, or does it only hold a
  // descriptor it cannot walk? Reads tile `i` two ways — the cheap scalar screen (no ring decoded) and
  // the full materialisation — and reports both, so the gate can check they agree with loft's own read
  // of the same tkey. Counts, not geometry: geometry equality is step 11's job, per kind.
  readTile: (i) => {
    const h = kernel.exposedValue ? kernel.exposedValue(1) : null;
    if (!h) return { err: 'no exposed layout handle' };
    const mem = kernel.memory();
    const n = flatCount(mem, h);
    if (!n) return { err: 'exposed collection is empty' };
    const idx = ((i % n) + n) % n;
    const scalars = { tkey: String(flatField(mem, h, idx, 'tkey')),
                      ox:   String(flatField(mem, h, idx, 'ox')),
                      oy:   String(flatField(mem, h, idx, 'oy')) };
    const t = flatElement(mem, h, idx);
    const names = [];
    for (const b of t.buildings || []) if (b.name) names.push(b.name);
    for (const l of t.labels || []) if (l.name) names.push(l.name);
    return { tiles: n, index: idx, scalars,
             full: { tkey: String(t.tkey), ox: String(t.ox), oy: String(t.oy) },
             counts: { areas: (t.areas || []).length, buildings: (t.buildings || []).length,
                       lines: (t.lines || []).length, labels: (t.labels || []).length,
                       pois: (t.pois || []).length },
             ringLen: (t.areas || []).length ? t.areas[0].ring.length : ((t.buildings || []).length ? t.buildings[0].ring.length : 0),
             sampleNames: names.slice(0, 4), fields: flatFields(h).map((f) => f.name) };
  },
  // Step 11's observable: do the AREAS read from the exposed store equal the areas loft serialised as
  // text for the same viewport? Runs one `view`, then reads the store back through the bridge and diffs.
  //
  // Two asymmetries are mirrored deliberately rather than papered over, because each is a real property
  // of the text path that step 12 will INHERIT when it starts rendering from the store:
  //   * loft prints coordinates at 6 decimals (`{:2.6}`), so the text path is LOSSY — the store read is
  //     exact. They can therefore differ by up to half a unit in the last printed place; the gate checks
  //     a tolerance, not string equality, and reports the worst case it saw.
  //   * `parseAreas` drops rings with fewer than 3 vertices; `emit_areas` emits them. So the text-parsed
  //     count is compared against the FILTERED store read, and the unfiltered count is reported next to
  //     loft's own `A=` so a divergence in the filter itself is visible rather than absorbed.
  areaParity: async () => {
    const box = viewportBox(VIEW_PAD);
    const bbox = `${box.mnla.toFixed(6)},${box.mnlo.toFixed(6)},${box.mxla.toFixed(6)},${box.mxlo.toFixed(6)}`;
    // `viewtext` is the FULL text emit, kept in the kernel purely as this gate's reference — the app's
    // own `view` no longer serialises the layout at all. Asking for it explicitly is what keeps the
    // comparison possible after step 13 without charging every user-facing view for it.
    const text = await kernel.runKernel(viewCmd(bbox, roadsFor(box, map.camera.zoom), 'viewtext', baseFor(box, map.camera.zoom), box, map.camera.zoom));
    const h = kernel.exposedValue ? kernel.exposedValue(1) : null;
    if (!h) return { err: 'no exposed layout handle' };
    const txt = parseView(text);
    const t0 = performance.now();
    const raw = viewFromStore(kernel.memory(), h, fboxOf(bbox), { flatCount, flatField }, STORE_KINDS);
    const readMs = performance.now() - t0;
    const lists = viewRenderLists(raw);
    const per = {};
    for (const k of STORE_KINDS) per[k] = { store: lists[k].length, text: txt[k].length };
    // Geometry is checked on AREAS only, and deliberately: it is the kind whose rings are longest and
    // whose ordering is most likely to drift, and the check is element-wise so it also proves the
    // pre-flattened array walks in the same key order loft's `for t in layout` does. The other kinds are
    // count-checked — a per-kind geometry diff would be the same code five times over.
    let coverMismatch = 0, ringLenMismatch = 0, maxDelta = 0;
    const n = Math.min(lists.areas.length, txt.areas.length);
    for (let i = 0; i < n; i++) {
      if (lists.areas[i].cover !== txt.areas[i].cover) coverMismatch++;
      if (lists.areas[i].ring.length !== txt.areas[i].ring.length) { ringLenMismatch++; continue; }
      for (let k = 0; k < lists.areas[i].ring.length; k++) {
        maxDelta = Math.max(maxDelta, Math.abs(lists.areas[i].ring[k][0] - txt.areas[i].ring[k][0]),
                                      Math.abs(lists.areas[i].ring[k][1] - txt.areas[i].ring[k][1]));
      }
    }
    const sum = text.split('\n').find((l) => l.startsWith('# view')) || '';
    const emitted = +((sum.match(/A=(\d+)/) || [])[1] ?? -1);
    return { emitted, jsHits: raw.areas.length, per,
             coverMismatch, ringLenMismatch, maxDelta, readMs: Math.round(readMs), summary: sum };
  },
  // Does the session's graph grow without bound as the user moves to NEW areas? server.loft replaces
  // tile corridors for exactly this reason ("RSS and latency blow up"). Match several sketches in
  // different places and watch wasm memory: replace ⇒ flat, accumulate ⇒ climbing.
  async panSketches() {
    const areas = [
      [[52.2412,6.8834],[52.2694,6.9164]],
      [[52.1800,6.8300],[52.2000,6.8600]],
      [[52.3100,6.9800],[52.3300,7.0100]],
      [[52.2200,6.7900],[52.2400,6.8200]],
      [[52.3500,6.8800],[52.3700,6.9100]],
    ];
    const rows = [];
    for (const [i, pts] of areas.entries()) {
      const t0 = performance.now();
      const spec = pts.map(([a, b]) => `${a},${b}`).join(';');
      const text = await kernel.runKernel(`${LAYOUT}\n${roadsForSketch(spec)}\nmatch\n${spec}\n${PROFILE}\n${READ_MODE()}`);
      const m = text.match(/ways=(\d+)/);
      rows.push({ i, ms: Math.round(performance.now() - t0), wasmMB: +(kernel.stats().wasmBytes / 1048576).toFixed(1), ways: m ? +m[1] : -1 });
    }
    return rows;
  },
  // C0 — WARM UP TO THE WORKING SET, then measure. wasm memory grows 48 -> 136 MB over a session's
  // first few matches, and each memory.grow can copy the whole linear memory, so those runs cost ~2x
  // steady state. That is a real property of the app (a user's first clicks ARE the slowest), not
  // noise — so it is reported separately rather than averaged into the number everything is judged on.
  // Returns the warmup runs; measurement starts once wasmBytes stops changing.
  async warmup(kind, maxRuns) {
    const rows = []; let prev = -1;
    for (let i = 0; i < maxRuns; i++) {
      const t0 = performance.now();
      await this.run(kind);
      const b = kernel.stats().wasmBytes;
      rows.push({ ms: performance.now() - t0, wasmMB: +(b / 1048576).toFixed(1), grew: b !== prev });
      if (b === prev && i >= 1) break;    // two runs at the same size = plateau reached
      prev = b;
    }
    return rows;
  },
  run(kind) {
    if (kind === 'match') {
      return kernel.runKernel(`${LAYOUT}\n${ROADS}\nmatch\n52.2412299,6.8834496;52.2694705,6.9164085;52.3116272,6.9088554\n${PROFILE}\n${READ_MODE()}`);
    }
    const b = viewportBox(VIEW_PAD);
    return kernel.runKernel(viewCmd(bboxOf(b)));
  },
  // C0 — is cost growing with session history? Run the SAME command N times and report wasm memory and
  // duration for each, so growth is attributed rather than averaged away.
  async repeat(kind, n) {
    const rows = [];
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      if (kind === 'match') {
        await kernel.runKernel(`${LAYOUT}\n${ROADS}\nmatch\n52.2412299,6.8834496;52.2694705,6.9164085;52.3116272,6.9088554\n${PROFILE}\n${READ_MODE()}`);
      } else {
        const b = viewportBox(VIEW_PAD);
        await kernel.runKernel(viewCmd(bboxOf(b)));
      }
      rows.push({ i, ms: performance.now() - t0, wasmMB: +(kernel.stats().wasmBytes / 1048576).toFixed(1) });
    }
    return rows;
  },
  async timedView() {
    const box = viewportBox(VIEW_PAD);
    const bbox = `${box.mnla.toFixed(6)},${box.mnlo.toFixed(6)},${box.mxla.toFixed(6)},${box.mxlo.toFixed(6)}`;
    const t0 = performance.now();
    const zoom = map.camera.zoom;
    const text = await kernel.runKernel(viewCmd(bbox, roadsFor(box, zoom), 'view', baseFor(box, zoom), box, zoom));
    const t1 = performance.now();
    map.loadRoadsFlat(text, roadsFloorFor(box, zoom));
    const t2 = performance.now();
    // PLAN-PERF §0 step 13 — the layout layers come from the EXPOSED STORE, not from `text`. `ensureView`
    // does this on every view, so this probe must too: leaving it out would report a view the app never
    // performs, which is exactly the class of instrument bug §7e was written about. Timed as its own
    // phase so the bridge's cost stays attributable instead of hiding inside `render`.
    // ⚠ This mirrors `ensureView` EXACTLY, and had to be re-synced when §6c landed. It was still
    // materialising all STORE_KINDS after the app had stopped, so it timed a view the app no longer
    // performs — and worse, re-populated map.areas/buildings/… behind the app's back, which made
    // `projectionCost` report 214,455 vertices for layers the app now retains none of. Same class of bug
    // its own comment warns about (§7e). If ensureView's layer wiring changes, change it here too.
    const h = kernel.exposedValue ? kernel.exposedValue(1) : null;
    if (h) {
      const lists = viewRenderLists(viewFromStore(kernel.memory(), h, fboxOf(bbox), { flatCount, flatField }, APP_OBJECT_KINDS));
      for (const k of APP_OBJECT_KINDS) map[k] = lists[k];
      for (const k of STORE_GEOM_KINDS) map[k] = [];
      map.setStoreIndex(buildIndex(kernel.memory(), h, storeLayout(h), fboxOf(bbox), STORE_GEOM_KINDS),
                        () => kernel.memory(), h.storeBase);
    }
    const t3 = performance.now();
    map.render();
    const t4 = performance.now();
    return { kernel: t1 - t0, parse: t2 - t1, storeRead: t3 - t2, render: t4 - t3, total: t4 - t0,
             bytes: text.length, lines: text.split('\n').length };
  },
  // Isolate the per-call store_load_url cost. TWO probes, because the two commands load DIFFERENT
  // stores: `view` loads layout+roads, `match` loads ONLY roads (the kernel skips layout for match).
  // A degenerate arg makes the command's own work ≈ 0, so what's left is the decode.
  async timedDecodeBoth() {   // empty bbox ⇒ view serialize ≈ 0 ⇒ kernel ≈ decode(layout + roads)
    const t0 = performance.now();
    const text = await kernel.runKernel(viewCmd('0.0,0.0,0.000001,0.000001'));
    return { kernel: performance.now() - t0, bytes: text.length };
  },
  async timedDecodeRoads() {  // 2 identical pts ⇒ match compute ≈ 0 ⇒ kernel ≈ decode(roads only)
    const t0 = performance.now();
    const text = await kernel.runKernel(`${LAYOUT}\n${ROADS}\nmatch\n0.0,0.0;0.0,0.0\n${PROFILE}`);
    return { kernel: performance.now() - t0, bytes: text.length };
  },
  // Step 16's observable: does the route ARRIVE progressively, and does the page paint while it does?
  // Counts STRETCH lines and the frames that landed during the match.
  // n points evenly along the same corridor — a REALISTIC drawn route is ~40 points (PLAN-MATCH),
  // i.e. ~39 small stretches and 39 yield points. The 3-point sketch every other probe uses is the
  // pathological end: 2 huge stretches, so only 2 chances to hand back the frame.
  // Sketch density vs frozen gap. Both rows must enter in the SAME state or they are not comparable:
  // without the reset, the 3-point row pays a corridor miss (its straight-line geometry differs from
  // whatever the previous probe left) and the 40-point row is then covered by the corridor the 3-point
  // row just built — so the pair read as "denser is cheaper" when they were simply measuring different
  // interactions. Reset makes both deterministically COLD, which is also the worst case a frozen-frame
  // metric should report.
  async streamProgressN(n) {
    const pts = [];
    for (let i = 0; i < n; i++) {
      const f = i / (n - 1);
      pts.push([52.2412299 + f * (52.3116272 - 52.2412299), 6.8834496 + f * (6.9088554 - 6.8834496)]);
    }
    const spec = pts.map(([a, b]) => `${a.toFixed(7)},${b.toFixed(7)}`).join(';');
    await kernel.runKernel(`${LAYOUT}\n${ROADS}\nreset`);
    const gaps = []; let last = performance.now(), stop = false;
    const tick = () => { const t = performance.now(); gaps.push(t - last); last = t; if (!stop) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    const t0 = performance.now();
    const text = await kernel.runKernel(`${LAYOUT}\n${ROADS}\nmatch\n${spec}\n${PROFILE}\n${READ_MODE()}`);
    const total = performance.now() - t0;
    stop = true; await new Promise((r) => setTimeout(r, 50));
    const stretches = text.split('\n').filter((l) => l.startsWith('STRETCH ')).length;
    return { n, total, stretches, frames: gaps.length, longestGap: Math.max(...gaps), expectedFrames: Math.round(total / 16.7) };
  },
  // PLAN-PERF §0 step 15 — does the BLOCK CACHE change what is drawn, and what does it buy?
  //
  // Two separate claims, deliberately measured apart, because conflating them is how a raster cache ships
  // with a seam nobody notices:
  //   1. the cache is EXACT — blitting baked blocks equals drawing them, so `blocked` vs
  //      `renderSnappedDirect` must be pixel-identical. Both use the same snapped origin, so this
  //      isolates the caching from the snapping.
  //   2. the SNAP is a real but bounded visual change — snapped-direct vs the ordinary render will
  //      differ, by up to one device pixel of translation. Reported, never asserted equal, because
  //      asserting it would be asserting something false.
  // Then the number the step exists for: a cold pan frame (blocks bake) and a warm one (pure blit).
  // WHERE do two renders differ? A hash says "not equal" and nothing else, and four fixes in a row were
  // guesses because of it. This returns the differing-pixel count and their bounding box, which separates
  // the candidate causes at a glance: a seam is a thin line on a block boundary, a label is a small
  // scattered box, a bad origin is the whole canvas.
  renderDiff(a, b, inset) {
    const IN = inset || 0;
    const c = document.getElementById('map'), ctx = c.getContext('2d');
    a(); const A = ctx.getImageData(0, 0, c.width, c.height).data.slice();
    b(); const B = ctx.getImageData(0, 0, c.width, c.height).data;
    let n = 0, mnx = 1e9, mxx = -1, mny = 1e9, mxy = -1;
    const cols = new Map();
    for (let i = 0; i < A.length; i += 4) {
      if (A[i] === B[i] && A[i + 1] === B[i + 1] && A[i + 2] === B[i + 2]) continue;
      const px = (i / 4) % c.width, py = ((i / 4) / c.width) | 0;
      // `inset` ignores a border. A path clipped by the canvas edge can rasterise differently from the
      // same path continuing past it, so an edge band is a DIFFERENT claim from an interior difference —
      // and only the interior one would mean the cache is drawing the map wrong.
      if (IN && (px < IN || py < IN || px >= c.width - IN || py >= c.height - IN)) continue;
      n++;
      if (px < mnx) mnx = px; if (px > mxx) mxx = px;
      if (py < mny) mny = py; if (py > mxy) mxy = py;
      cols.set(px, (cols.get(px) || 0) + 1);
    }
    const hot = [...cols.entries()].sort((x, y) => y[1] - x[1]).slice(0, 6);
    let maxDelta = 0;
    for (let i = 0; i < A.length; i += 4) {
      for (let k = 0; k < 3; k++) { const d = Math.abs(A[i + k] - B[i + k]); if (d > maxDelta) maxDelta = d; }
    }
    // A sample of ACTUAL differing pixels with both colours. Counts and boxes narrow the search; the
    // colours end it — "#a5c8e8 vs #f2efe9" is a missing feature, "#a5c8e8 vs #a5c8e7" is antialiasing.
    const samples = [];
    for (let i = 0; i < A.length && samples.length < 14; i += 4) {
      if (A[i] === B[i] && A[i + 1] === B[i + 1] && A[i + 2] === B[i + 2]) continue;
      const px = (i / 4) % c.width, py = ((i / 4) / c.width) | 0;
      if (samples.length && samples[samples.length - 1].y === py && px - samples[samples.length - 1].x < 30) continue;
      const hex = (o) => '#' + [0, 1, 2].map((k) => o[k].toString(16).padStart(2, '0')).join('');
      samples.push({ x: px, y: py, a: hex([A[i], A[i + 1], A[i + 2]]), b: hex([B[i], B[i + 1], B[i + 2]]) });
    }
    return { diff: n, total: c.width * c.height, box: n ? [mnx, mny, mxx, mxy] : null, hotCols: hot, maxDelta, samples };
  },
  // §6d: WHICH layer diverges? Draw one at a time, both ways, and diff. A whole-canvas difference with
  // identical counts is uninformative on its own; per-layer it is a name.
  blockBisect() {
    const M = map, out = {};
    const runs = ['areas', 'lines', 'buildings', 'streets', 'pois'];
    M._skipOverlays = true;
    for (const layer of runs) {
      M._onlyLayer = layer;
      out[layer] = this.renderDiff(
        () => { M.blocked = false; M.renderSnappedDirect(); },
        () => { M.blocked = true; M._blocks = new Map(); M._blockZoom = null; M.render(); });
    }
    M._onlyLayer = null;
    out.baseAll = this.renderDiff(
      () => { M.blocked = false; M.renderSnappedDirect(); },
      () => { M.blocked = true; M._blocks = new Map(); M._blockZoom = null; M.render(); });
    // Labels, one pass at a time, on an EMPTY base — so a label difference cannot hide inside the map.
    M._skipOverlays = false;
    M._onlyLayer = '__none__';
    for (const kind of ['places', 'streets', 'buildings']) {
      M._onlyLabels = kind;
      out['label:' + kind] = this.renderDiff(
        () => { M.blocked = false; M.renderSnappedDirect(); },
        () => { M.blocked = true; M._blocks = new Map(); M._blockZoom = null; M.render(); });
    }
    M._onlyLabels = null; M._onlyLayer = null;
    out.withOverlays = this.renderDiff(
      () => { M.blocked = false; M.renderSnappedDirect(); },
      () => { M.blocked = true; M._blocks = new Map(); M._blockZoom = null; M.render(); });
    // CONTROL: one block big enough to cover the whole viewport. If a difference survives this, it is
    // NOT a seam — it is something about baking offscreen at all.
    M.blockSize = 2048;
    M._onlyLayer = 'pois'; M._skipOverlays = true;
    out['CONTROL pois 1block'] = this.renderDiff(
      () => { M.blocked = false; M.renderSnappedDirect(); },
      () => { M.blocked = true; M._blocks = new Map(); M._blockZoom = null; M.render(); });
    M._onlyLayer = null;
    out['CONTROL base 1block'] = this.renderDiff(
      () => { M.blocked = false; M.renderSnappedDirect(); },
      () => { M.blocked = true; M._blocks = new Map(); M._blockZoom = null; M.render(); });
    M._skipOverlays = false;
    out['CONTROL all 1block'] = this.renderDiff(
      () => { M.blocked = false; M.renderSnappedDirect(); },
      () => { M.blocked = true; M._blocks = new Map(); M._blockZoom = null; M.render(); });
    M.blockSize = null;
    M.blocked = false; M.render();
    return out;
  },
  // THE control for §6d: is an offscreen round-trip pixel-exact AT ALL?
  //
  // Draws the identical frame into an offscreen canvas of exactly the viewport size, same origin, and
  // blits it at (0,0). No blocks, no margins, no offset, nothing to get wrong — if this differs, then no
  // raster cache of any design can be pixel-identical, and step 15's gate must become a BOUNDED
  // difference rather than equality. That is a fact about the platform, not about the cache.
  offscreenRoundTrip(pad) {
    const P = pad || 0;
    const M = map, c = document.getElementById('map');
    const direct = () => { M.blocked = false; M.renderSnappedDirect(); };
    const viaOffscreen = () => {
      // `pad` grows the offscreen and shifts the origin by the same amount, so every feature keeps its
      // sub-pixel phase and only the CANVAS GEOMETRY changes. pad 0 is the identity control.
      const cv = document.createElement('canvas');
      cv.width = c.width + 2 * P * M.dpr; cv.height = c.height + 2 * P * M.dpr;
      const c2 = cv.getContext('2d');
      c2.setTransform(M.dpr, 0, 0, M.dpr, 0, 0);
      c2.fillStyle = '#f2efe9'; c2.fillRect(0, 0, M.width + 2 * P, M.height + 2 * P);
      const saved = M.ctx, sw = M.width, sh = M.height;
      M.ctx = c2; M.width = sw + 2 * P; M.height = sh + 2 * P;
      const o = M._originWorld.call({ camera: M.camera, width: sw, height: sh });
      M._origin = { x: Math.round(o.x * M.dpr) / M.dpr - P, y: Math.round(o.y * M.dpr) / M.dpr - P };
      try {
        M._noVertexCull = true;
        try { M._drawBase(M.camera.zoom); } finally { M._noVertexCull = false; }
        M.drawDesignations(); M.drawBarriers(); M.drawRoute(); M.layoutLabels();   // the same overlay set renderSnappedDirect draws
      } finally { M._origin = null; M.ctx = saved; M.width = sw; M.height = sh; }
      const ctx = c.getContext('2d');
      ctx.clearRect(0, 0, M.width, M.height);
      ctx.drawImage(cv, P * M.dpr, P * M.dpr, c.width, c.height, 0, 0, M.width, M.height);
    };
    return this.renderDiff(direct, viaOffscreen);
  },
  // PLAN-PERF §0 step 15's gate. Three claims, and only two of them can be equality:
  //
  //   1. a CACHED frame equals a freshly baked one — exact. This is the cache's own correctness, and it
  //      is the one a bisect that clears the cache every time will never check (building-label anchors
  //      are produced only by a bake, so a warm frame lost every one of them until they were cached too).
  //   2. every LABEL pass is exact — structural, and the check that caught the `{ox,oy}` vs `{x,y}`
  //      origin-key bug that made overlays project to NaN.
  //   3. blocked vs a direct render at the same snapped origin is BOUNDED, not equal — Chromium's
  //      rasterisation is not invariant to canvas dimensions, and a bleed margin necessarily changes
  //      them. Proven by `offscreenRoundTrip(pad)`: pad 0 is exact, pad 32 differs by 5,026 px at
  //      maxDelta 15 with identical geometry and identical sub-pixel phase. So this asserts a small
  //      per-channel delta, which is what "no structural difference" actually looks like here.
  blockRaster() {
    const M = map;
    // Bakes are amortised (BLOCK_BAKES_PER_FRAME), so a "fully blocked" frame is only reached after the
    // cache settles — render until it does, which is what a real pan does over its first few frames.
    const cold = () => { M.blocked = true; M._blocks = new Map(); M._blockZoom = null; for (let i = 0; i < 16; i++) M.render(); };
    const warm = () => { M.blocked = true; M.render(); };
    const snap = () => { M.blocked = false; M.renderSnappedDirect(); };
    const coldVsWarm = this.renderDiff(cold, warm);
    const labels = {};
    M._skipOverlays = false; M._onlyLayer = '__none__';
    for (const kind of ['places', 'streets', 'buildings']) {
      M._onlyLabels = kind;
      labels[kind] = this.renderDiff(snap, cold).diff;
    }
    M._onlyLabels = null; M._onlyLayer = null;
    const vsSnapped = this.renderDiff(snap, cold);
    const roundTrip = this.offscreenRoundTrip(0).diff;
    // The numbers the step exists for.
    // The settle cost: how many frames until the cache covers the viewport, and the WORST single frame
    // on the way there — which is the number that matters, since it is what a user feels.
    M.blocked = true; M._blocks = new Map(); M._blockZoom = null;
    let settleFrames = 0, worstMs = 0, settleMs = 0;
    for (let i = 0; i < 24; i++) {
      const t = performance.now(); M.render(); const d = performance.now() - t;
      settleMs += d; settleFrames++;
      if (d > worstMs) worstMs = d;
      if (M._blocksBaked === 0) break;                     // nothing left to bake
    }
    const coldMs = settleMs;
    const w = [];
    for (let i = 0; i < 6; i++) { const t = performance.now(); M.render(); w.push(performance.now() - t); }
    const blocks = M._blocks.size;
    M.blocked = false; M.render();
    const med = (a) => { const s2 = [...a].sort((x, y) => x - y); return s2[Math.floor(s2.length / 2)]; };
    // A block baked before a data load can be missing features that window did not include, and a stale
    // raster is a failure that LOOKS like a correct map.
    //
    // The data has to actually CHANGE for this to test anything: reloading the same text leaves stale
    // blocks correct, so the check passes whether or not invalidation happens. (It did, first try — a
    // vacuous gate is worse than none.) So: bake, then load an EMPTY road set, then compare a cached
    // frame against a forced-cold one. Without invalidation the cached frame still shows the old roads.
    M.blocked = true; M.render();                          // populate the cache
    const bandFloor = M.roadsBandFloor || 0;                // restored below — see PLAN-LAYERS §4
    M.loadRoadsFlat('');                                    // a real data change — must invalidate
    const staleness = this.renderDiff(() => { M.blocked = true; M.render(); },
                                      () => { M.blocked = true; M._blocks = new Map(); M._blockZoom = null; M.render(); }).diff;
    M.loadRoadsFlat(lastViewText || '', bandFloor);         // restore the real roads, and their band
    return { coldVsWarm: coldVsWarm.diff, labelDiffs: labels, roundTrip, staleness,
             settleFrames, worstFrameMs: +worstMs.toFixed(1),
             vsSnapped: vsSnapped.diff, vsSnappedMaxDelta: vsSnapped.maxDelta,
             pct: +(vsSnapped.diff / vsSnapped.total * 100).toFixed(2),
             coldMs: +coldMs.toFixed(1), warmMs: +med(w).toFixed(2), blocks };
  },
  // PLAN-PERF §6c — does the store-backed render path draw EXACTLY what the object path drew?
  //
  // This is the additive-before-subtractive gate: both paths are live, so flip the store index off, render,
  // fingerprint; flip it on, render, fingerprint; the two hashes must be equal. Counts alone would not
  // settle it — a ring read at a wrong offset yields plausible integers and a plausible count, and only
  // the pixels show that it drew somewhere else. This is the check that licenses deleting the object path.
  storeRenderParity() {
    const idx = map._sidx;
    const h = kernel.exposedValue ? kernel.exposedValue(1) : null;
    if (!idx || !h || !loadedBbox) return { err: 'no store index / handle / view' };
    // ⚠ DIRECT path only. With the block cache on, toggling `_sidx` and re-rendering would blit the same
    // cached rasters both times and this gate would pass vacuously — it would be comparing a cache
    // against itself. Blocking is restored at the end.
    const wasBlocked = map.blocked;
    map.blocked = false;
    // ⚠ And the NETWORK OVERLAY off, because only the flat street path draws it. This gate compares the
    // store-backed geometry against the object path for buildings/areas/lines/pois; an annotation that
    // exists in one render and not the other is a guaranteed mismatch that says nothing about the bridge.
    // `netForProfile('')` is 0, which is how the overlay is switched off without a second flag.
    const wasProfile = map.profile;
    map.profile = '';
    const fp = () => { map.render(); const c = document.getElementById('map');
                       const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
                       let hh = 0x811c9dc5;
                       for (let i = 0; i < d.length; i++) { hh ^= d[i]; hh = Math.imul(hh, 0x01000193); }
                       return { hash: (hh >>> 0).toString(16), counts: { ...map._stats } }; };
    // Rebuild the OBJECT path here rather than in the app: the whole point of §6c is that the app never
    // materialises these kinds, so the reference has to be constructed by the gate, for this one call.
    const lists = viewRenderLists(viewFromStore(kernel.memory(), h, fboxOf(loadedBbox), { flatCount, flatField }, STORE_KINDS));
    const saved = {};
    for (const k of STORE_KINDS) { saved[k] = map[k]; map[k] = lists[k]; }
    // Streets too: they come from the roads TEXT, so the boxed reference is rebuilt by re-parsing the
    // same `view` output the flat column was built from — same bytes in, both shapes out.
    const flat = map.streetsFlat;
    map.streets = parseView(lastViewText || '').streets;
    map.streetsFlat = null;
    map._sidx = null;
    const objects = fp();
    for (const k of STORE_KINDS) map[k] = saved[k];
    map.streetsFlat = flat; map.streets = [];
    map._sidx = idx;
    const store = fp();
    const kinds = Object.keys(idx).filter((k) => idx[k] && idx[k].n !== undefined);
    map.profile = wasProfile;
    map.blocked = wasBlocked; map.invalidateBlocks();
    return { objects: objects.hash, store: store.hash, equal: objects.hash === store.hash,
             objectCounts: objects.counts, storeCounts: store.counts, kinds,
             indexed: Object.fromEntries(kinds.map((k) => [k, idx[k].n])),
             streetsFlat: flat ? { n: flat.n, verts: flat.verts } : null,
             objectLists: Object.fromEntries(STORE_KINDS.map((k) => [k, lists[k].length])) };
  },
  // The descriptor's field map for PTile and everything nested under it — the reference a byte-level
  // walker has to be written against. Dumped rather than guessed: a wrong `pos` reads a neighbouring
  // field and still returns plausible integers.
  descMap() {
    const h = kernel.exposedValue ? kernel.exposedValue(1) : null;
    if (!h) return { err: 'no layout handle' };
    const d = h.desc, out = {}, seen = new Set();
    const sizeOf = (id) => (d.sizes && d.sizes[id] != null ? +d.sizes[id] : 0);
    const walk = (id, label) => {
      if (id == null || seen.has(id)) return;
      seen.add(id);
      const n = d.nodes[id];
      if (!n) return;
      const row = { id, kind: n.kind, size: sizeOf(id) };
      if (n.base) row.base = n.base;
      if (n.elem != null) { row.elem = n.elem, row.elemKind = d.nodes[n.elem]?.kind, row.elemSize = sizeOf(n.elem); }
      if (n.fields) row.fields = n.fields.map((f) => ({ name: f.name, pos: f.pos, content: f.content, kind: d.nodes[f.content]?.kind, base: d.nodes[f.content]?.base }));
      if (n.variants) row.variants = n.variants.map((v) => v.name);
      out[label] = row;
      if (n.elem != null) walk(n.elem, label + '.elem');
      for (const f of n.fields || []) walk(f.content, label + '.' + f.name);
    };
    walk(d.nodes[h.typeId].elem, 'PTile');
    return out;
  },
  // Is a `vector<Coord>` already the flat layout we want — readable as a ZERO-COPY Int32Array view over
  // wasm memory? (PLAN-PERF §6c: where the loft/JS split should live.)
  //
  // loft-deliver's `vector` case stores struct elements INLINE at `storeBase + vRec*8 + 8`, stride
  // sizeOf(elem) — so if Coord is two 4-byte ints at offsets 0 and 4, a ring IS an interleaved Int32Array
  // and JS never needs to copy or retain it. That would mean the 33 MB / 239k objects exist purely
  // because `readLoftValue` materialises structs, not because the data is shaped badly.
  //
  // This is the feasibility probe for that claim, and it does not take the layout on faith: it derives
  // the ring's address with loft-deliver's own formulas, maps an Int32Array over it, and compares every
  // coordinate against what loft's reader materialises for the same ring.
  coordLayout() {
    const h = kernel.exposedValue ? kernel.exposedValue(1) : null;
    if (!h) return { err: 'no layout handle' };
    const mem = kernel.memory(), d = h.desc, sb = Number(h.storeBase);
    const u32 = (a) => new DataView(mem.buffer).getUint32(a, true);
    const sizeOf = (id) => (d.sizes && d.sizes[id] != null ? +d.sizes[id] : 0);
    // Reach Coord STRUCTURALLY (PTile.areas → Area.ring → its element type) rather than by name: the
    // descriptor keeps names in a side table, and a structural walk is what the render path would do.
    const dRec = Number((d.flat && d.flat[`${Number(h.rec)}_${Number(h.pos)}`]) || 0);
    const nTiles = u32(sb + dRec * 8 + 4);
    const tileElem = d.nodes[d.nodes[h.typeId].elem];
    const fAreas = tileElem.fields.find((f) => f.name === 'areas');
    const areaVec = d.nodes[fAreas.content];                 // vector<Area>
    const areaId = areaVec.elem, area = d.nodes[areaId];
    const fRing = area.fields.find((f) => f.name === 'ring');
    const ringVec = d.nodes[fRing.content];                  // vector<Coord>
    const coordId = ringVec.elem, coord = d.nodes[coordId];
    const layout = { coordId, kind: coord.kind, size: sizeOf(coordId), areaSize: sizeOf(areaId),
                     fields: (coord.fields || []).map((f) => ({ name: f.name, pos: f.pos, kind: d.nodes[f.content]?.kind })) };
    for (let i = 0; i < nTiles; i++) {
      const tRec = u32(sb + dRec * 8 + 8 + 4 * i);
      if (!tRec) continue;
      const aRec = u32(sb + tRec * 8 + 8 + Number(fAreas.pos));
      if (!aRec) continue;
      const nAreas = u32(sb + aRec * 8 + 4);
      if (!nAreas) continue;
      const aPos = 8 + sizeOf(areaId) * 0;                   // area 0, inline in the vector
      const rRec = u32(sb + aRec * 8 + aPos + Number(fRing.pos));
      if (!rRec) continue;
      const n = u32(sb + rRec * 8 + 4);
      if (n < 3) continue;
      // ZERO-COPY: the ring as an interleaved Int32Array straight over wasm memory.
      const flat = new Int32Array(mem.buffer, sb + rRec * 8 + 8, n * 2);
      // loft's own reader, materialising the same ring into JS objects.
      const ref = flatField(mem, h, i, 'areas')[0].ring;
      let bad = 0;
      for (let k = 0; k < n; k++) if (flat[k * 2] !== ref[k].x || flat[k * 2 + 1] !== ref[k].y) bad++;
      return { layout, tile: i, ringLen: n, refLen: ref.length, mismatches: bad,
               zeroCopyOk: bad === 0 && ref.length === n && layout.size === 8,
               first: [flat[0], flat[1]], firstRef: [ref[0].x, ref[0].y],
               vecElemStride: sizeOf(ringVec.elem) };
    }
    return { layout, err: 'no ring found' };
  },
  // What does the JS side RETAIN between frames, and in what shape? (PLAN-PERF §6 R / §6c)
  //
  // Long-lived JS structures are where a JS renderer loses to loft, and the loss is not in the arithmetic
  // — it is in the shape. A vertex held as `[lat, lon]` is a separate heap object: header, elements
  // pointer, two boxed doubles, scattered. 200k of them are 200k GC-traced allocations and a projection
  // loop that is memory-bound rather than compute-bound. The same vertices in one Float64Array are
  // contiguous, GC-invisible (typed arrays are not traced element-wise) and iterate at cache speed.
  //
  // So this reports the two numbers that decide whether that matters here: how many objects the layers
  // actually retain, and what the same geometry would cost FLAT. Read with a forced GC before it, or it
  // reports garbage that was merely not collected yet.
  layerFootprint() {
    const arrays = [['areas', map.areas, (a) => a.ring], ['buildings', map.buildings, (b) => b.ring],
                    ['streets', map.streets, (s) => s.line], ['lines', map.lines, (l) => l.geom],
                    ['streetLabels', map.streetLabels, (s) => s.line], ['pois', map.pois, null],
                    ['places', map.places, null]];
    const per = {}; let verts = 0, objs = 0;
    for (const [name, list, geomOf] of arrays) {
      let v = 0;
      if (geomOf) for (const f of list) v += geomOf(f).length;
      else v = list.length;
      per[name] = { features: list.length, verts: v };
      verts += v; objs += list.length + (geomOf ? v : 0);   // one object per feature + one per vertex pair
    }
    const m = performance.memory || {};
    return { per, verts, objects: objs,
             heapUsedMB: m.usedJSHeapSize ? +(m.usedJSHeapSize / 1048576).toFixed(1) : null,
             flatFloat64MB: +(verts * 16 / 1048576).toFixed(2),      // 2 x f64 per vertex, contiguous
             flatInt32MB: +(verts * 8 / 1048576).toFixed(2) };       // deg*1e7 fixed point, as the store holds it
  },
  // A fingerprint of what is actually ON the canvas, for changes that must be PURELY representational.
  // §6 R's steps reorganise how geometry reaches the rasteriser and are supposed to leave every pixel
  // where it was; "supposed to" is not a gate, and counts cannot see a shifted or dropped feature. Cheap
  // FNV-1a over the raw pixel bytes — compare it across the commit, not against a stored golden, so it
  // survives a store regeneration.
  canvasFingerprint() {
    map.render();
    const c = document.getElementById('map');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let h = 0x811c9dc5;
    for (let i = 0; i < d.length; i++) { h ^= d[i]; h = Math.imul(h, 0x01000193); }
    return { hash: (h >>> 0).toString(16), bytes: d.length, w: c.width, h: c.height,
             camera: { ...map.camera }, counts: { ...map._stats } };
  },
  // PLAN-PERF §6 R: WHERE does a frame's 73 ms go? Steps 14 and 15 bet on different halves of it — 14
  // that per-frame projection dominates, 15 that rasterisation does — and one aggregate number cannot
  // referee that. Renders the CURRENT view n times with per-layer timing on, and separately times the
  // projection walk alone, which is the hard CEILING on what step 14 can win.
  async renderBudget(n) {
    // The per-layer breakdown describes the DIRECT path. A blocked frame is one blit and has no layers to
    // attribute, which is the point of it — `blockRaster()` reports that number.
    const wasBlocked = map.blocked; map.blocked = false;
    map._timeLayers = true;
    const runs = [];
    for (let i = 0; i < n; i++) { const t0 = performance.now(); map.render(); runs.push({ total: performance.now() - t0, ms: { ...map._layerMs } }); }
    map._timeLayers = false;
    const proj = [];
    let verts = 0;
    for (let i = 0; i < n; i++) { const t0 = performance.now(); const r = map.projectionCost(); proj.push(performance.now() - t0); verts = r.verts; }
    const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
    const layers = {};
    for (const k of Object.keys(runs[0].ms)) layers[k] = med(runs.map((r) => r.ms[k]));
    map.blocked = wasBlocked; map.invalidateBlocks();
    return { total: med(runs.map((r) => r.total)), layers, projection: med(proj), verts, counts: { ...map._stats } };
  },
  // What does drawing the SKETCH actually cost? (PLAN-EDIT E7's open gap.)
  //
  // `renderBudget` above reports `rough 0 ms · 0 drawn`, because it renders whatever is on screen and the
  // profiler's session never draws a sketch. That proves the ROW exists, not that the sketch is free —
  // and "a handful of points cannot matter" is exactly the kind of sentence this repo has been burned by.
  // So seed a sketch of each size and read the same layer timer the other rows come from.
  //
  // 0 is the baseline the profiler currently reports; 3 is the app's own demo sketch; 40 is the honest
  // dense case (PLAN-MATCH: a realistically drawn route is ~40 points) — the same pair
  // `match_phase_probe` uses, so the render and match sides stay comparable.
  //
  // The points are spread across the viewport rather than bunched, so they genuinely project on-screen
  // and rasterise: a sketch parked off-camera would measure the early-out, not the drawing.
  // ⚠ AMPLIFIED, because the first version of this probe was a blind instrument. Timing one sketch draw
  // per frame reported `0.00 ms` for 40 points and `0.10 ms` for 3 — a smaller sketch costing MORE, which
  // is impossible and therefore a reading of the clock, not of the code: `performance.now()` is clamped to
  // ~100 µs in Chromium and a single overlay draw lands under that floor. Drawing it REPS times per sample
  // and dividing puts the measurement well above the floor, where the sizes order monotonically and the
  // number means something. (engineering-rigor: a probe that will not converge is a tool problem first.)
  async roughBudget(n, sizes = [0, 3, 40]) {
    const REPS = 200;
    const saved = map.points;                  // test-only swap; restored in the finally below
    const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
    const out = {};
    try {
      for (const k of sizes) {
        const pts = [];
        for (let i = 0; i < k; i++) {
          const f = k === 1 ? 0.5 : i / (k - 1);
          const g = map.unproject(map.width * (0.08 + 0.84 * f),
                                  map.height * (0.5 + 0.38 * Math.sin(f * 7)));
          pts.push({ id: i + 1, lat: g.lat, lon: g.lon });
        }
        map.points = pts;
        const drawn = map.drawRough();
        const time = () => {
          const runs = [];
          for (let i = 0; i < n; i++) {
            const t0 = performance.now();
            for (let r = 0; r < REPS; r++) map.drawRough();
            runs.push((performance.now() - t0) / REPS);
          }
          return med(runs);
        };
        const ms = time();
        // Attribute it three ways rather than reporting one number nobody can act on. The shadow was the
        // obvious suspect (a canvas shadow is an offscreen blur per fill) and measuring said otherwise —
        // so the line/dots split is what actually tells you which way the cost scales.
        map._roughNoShadow = true;
        const msNoShadow = time();
        map._roughNoShadow = false;
        map._roughNoLine = true;
        const msDotsOnly = time();
        map._roughNoLine = false;
        out[k] = { ms, msNoShadow, msDotsOnly, drawn, reps: REPS };
      }
    } finally {
      map._roughNoShadow = false;
      map._roughNoLine = false;
      map.points = saved;
      map.invalidateBlocks();
      map.render();
    }
    return out;
  },
  // §6b(2)'s observable: do the STRETCH lines reach JS *while the match runs*, or only at the end?
  //
  // Step 16 made loft EMIT per stretch, but `runKernel` buffered the whole response, so JS learned
  // nothing until `#EOR`. The distinction is invisible in the resolved text — it contains the same lines
  // either way — so this counts DELIVERY BATCHES (`stats().deliveries`, one per yield that flushed
  // output) against STRETCH lines. One burst delivers once regardless of stretch count; genuine
  // streaming delivers at least once per stretch. A count, so a loaded machine cannot fake it either way.
  async streamArrival(n) {
    const pts = [];
    for (let i = 0; i < n; i++) {
      const f = i / (n - 1);
      pts.push([52.2412299 + f * (52.3116272 - 52.2412299), 6.8834496 + f * (6.9088554 - 6.8834496)]);
    }
    const spec = pts.map(([a, b]) => `${a.toFixed(7)},${b.toFixed(7)}`).join(';');
    await kernel.runKernel(`${LAYOUT}\n${ROADS}\nreset`);
    const d0 = kernel.stats().deliveries;
    let earlyStretches = 0, done = false, afterDone = 0;
    const text = await kernel.runKernel(`${LAYOUT}\n${roadsForSketch(spec)}\nmatch\n${spec}\n${PROFILE}\n${matchMode(spec)}`, (line) => {
      if (!line.startsWith('STRETCH ')) return;
      if (done) afterDone++; else earlyStretches++;
    });
    done = true;
    const lines = text.split('\n');
    const stretches = lines.filter((l) => l.startsWith('STRETCH ')).length;

    // Is what the user WATCHED the route they ended up with? Point counts alone cannot say: loft stitches
    // these same sub-paths with push_pt and then remove_spurs, and both only ever DROP points, so the
    // finished ROUTE is shorter than the stream by construction (measured: 431 → 213 on this sketch —
    // remove_spurs is doing real work, not rounding). The exact statement that survives that is
    // CONTAINMENT: every point of the final route must appear in the streamed line, in the same order.
    // If it does, the growing line is the real route plus excursions that were later pruned; if it does
    // not, the stream drew somewhere the route never went.
    const slots = [];
    for (const l of lines) { const s = parseStretch(l); if (s) slots[s.i] = s.pts; }
    const streamed = [];
    for (const pts of slots) { if (!pts) continue; for (const p of pts) { const q = streamed[streamed.length - 1]; if (!q || q[0] !== p[0] || q[1] !== p[1]) streamed.push(p); } }
    const route = [];
    for (const l of lines) {
      if (!l.startsWith('ROUTE')) continue;
      const p = l.split(';');
      for (let i = 1; i < p.length; i++) { const c = p[i].split(','); const a = +c[0], b = +c[1]; if (c.length === 2 && !Number.isNaN(a) && !Number.isNaN(b)) route.push([a, b]); }
    }
    let k = 0;
    for (const p of streamed) { if (k < route.length && route[k][0] === p[0] && route[k][1] === p[1]) k++; }
    return { n, stretches, earlyStretches, afterDone, deliveries: kernel.stats().deliveries - d0,
             streamedPts: streamed.length, routePts: route.length, contained: k === route.length };
  },
  // Reset first: a cold match is the case that streams, and it is the one whose freeze this measures.
  async streamProgress() {
    await kernel.runKernel(`${LAYOUT}\n${ROADS}\nreset`);
    const gaps = []; let last = performance.now(), stop = false;
    const tick = () => { const t = performance.now(); gaps.push(t - last); last = t; if (!stop) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    const t0 = performance.now();
    const text = await kernel.runKernel(`${LAYOUT}\n${ROADS}\nmatch\n52.2412299,6.8834496;52.2694705,6.9164085;52.3116272,6.9088554\n${PROFILE}\n${READ_MODE()}`);
    const total = performance.now() - t0;
    stop = true; await new Promise((r) => setTimeout(r, 50));
    const stretches = text.split('\n').filter((l) => l.startsWith('STRETCH ')).length;
    return { total, stretches, frames: gaps.length, longestGap: Math.max(...gaps), expectedFrames: Math.round(total / 16.7) };
  },
  // Is the MAIN THREAD blocked while the kernel runs? Lag is not slowness — it is a frozen frame.
  // Drive rAF across a kernel call: count the frames that actually landed and the longest gap between
  // them. A responsive app keeps ~16ms gaps; a blocked one shows one gap ≈ the whole call.
  // `kind` is 'view' | 'match' (cold, session dropped) | 'matchWarm' (one point moved, session live).
  // The match cases must name which they are: a cold rebuild and a warm edit block the thread for wildly
  // different times, and inheriting the previous probe's corridor silently picks one of them for you.
  async frameBlocking(kind) {
    if (kind === 'match') {
      await kernel.runKernel(`${LAYOUT}\n${ROADS}\nreset`);
    } else if (kind === 'matchWarm') {
      await kernel.runKernel(`${LAYOUT}\n${ROADS}\nreset`);
      await this.run('match');                       // establish the corridor, so the timed call is warm
    }
    const gaps = []; let last = performance.now(), stop = false;
    const tick = () => { const t = performance.now(); gaps.push(t - last); last = t; if (!stop) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    const t0 = performance.now();
    if (kind === 'matchWarm') {
      await kernel.runKernel(`${LAYOUT}\n${ROADS}\nmatch\n52.2412299,6.8834496;52.2694705,6.9164085;52.3118272,6.9090554\n${PROFILE}`);
    } else if (kind === 'match') {
      await kernel.runKernel(`${LAYOUT}\n${ROADS}\nmatch\n52.2412299,6.8834496;52.2694705,6.9164085;52.3116272,6.9088554\n${PROFILE}\n${READ_MODE()}`);
    } else {
      const b = viewportBox(VIEW_PAD);
      await kernel.runKernel(viewCmd(bboxOf(b)));
    }
    const total = performance.now() - t0;
    stop = true;
    await new Promise((r) => setTimeout(r, 50));
    return { kind, total, frames: gaps.length, longestGap: Math.max(...gaps), expectedFrames: Math.round(total / 16.7) };
  },
  // A genuinely COLD match: drop the session first, so the corridor read, build_graph and the full
  // incremental seed are all paid. `reset` deliberately does NOT touch the stores — they stay decoded,
  // because a real cold match never re-fetches them either (PLAN-PERF §7e).
  //
  // This probe exists because the OLD `matchColdFull` stopped being cold when step 6 landed the
  // persistent session, and nothing noticed for two months: it re-sent the same sketch into a live
  // session, so every iteration after the first measured the NOTHING-CHANGED case while still being
  // labelled "cold". The profiler then compared it against `matchWarm` and reported a warm/cold ratio
  // above 1 — read as a regression, when it was two different interactions wearing each other's names.
  async matchTrueCold(pts) {
    await kernel.runKernel(`${LAYOUT}\n${ROADS}\nreset`);
    return timeMatch(pts);
  },
  // The same cold match, down the app's REAL click path — with the route drawing itself as it arrives
  // (§6b(2)). Paired with matchTrueCold so the growing line's cost is a DELTA between two like-for-like
  // runs rather than a shift in the headline number that nothing explains. If this pair ever separates
  // materially, the per-stretch stroke has stopped being proportional to the route.
  async matchTrueColdStreamed(pts) {
    await kernel.runKernel(`${LAYOUT}\n${ROADS}\nreset`);
    return timeMatch(pts, true);
  },
  // A REPEAT match: the identical sketch, re-sent into a live session. covered() holds and
  // match_incremental finds nothing changed, so this is the app's cheapest possible match — the floor,
  // not the outlier. (This is what the old `matchColdFull` actually measured; kept under an honest name.)
  async matchRepeat(pts) {
    await timeMatch(pts);
    return timeMatch(pts);
  },
  // A WARM match: the interaction users actually perform — MOVE an existing point ~20 m. The nudged
  // point stays inside the corridor already fetched, so covered() holds and the session's graph is
  // reused; only the edited window is re-searched. Compare against matchTrueCold (should be far
  // cheaper) — NOT against matchRepeat, which changes nothing and is necessarily cheaper still.
  async matchWarm(pts) {
    await timeMatch(pts);                                  // establish the sketch (cold)
    const moved = pts.map((p, i) => (i === pts.length - 1 ? [p[0] + 0.0002, p[1] + 0.0002] : p));
    return timeMatch(moved);
  },
  // EXTEND the sketch by ~500m. This one CANNOT be warm by construction: the new point is outside every
  // corridor fetched so far, so its ways must be read and the graph rebuilt. Measured separately so the
  // two interactions are not conflated — "add a point" and "move a point" have different floors.
  async matchExtend(pts) {
    await timeMatch(pts);
    const last = pts[pts.length - 1];
    return timeMatch([...pts, [last[0] + 0.004, last[1] + 0.004]]);
  },
  // INSERT and DELETE an interior point — the two edits the rough editor added (PLAN-EDIT E2/E4).
  // `matchWarm` covers a MOVE, and the whole editor rests on the claim that insert and delete ride the
  // same incremental path rather than falling back to a cold rebuild. That was measured once during
  // design (PLAN-EDIT §2, P5) and is here so the verdict can be RE-CHECKED instead of re-derived: a probe
  // outside a gate is a comment. Same shape as matchWarm — establish the sketch, then time ONE edit.
  async matchInsert(pts) {
    await timeMatch(pts);
    const mid = [(pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2];
    return timeMatch([pts[0], mid, ...pts.slice(1)]);
  },
  async matchDelete(pts) {
    const mid = [(pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2];
    await timeMatch([pts[0], mid, ...pts.slice(1)]);
    return timeMatch(pts);
  },
};

// Shared body for the two match probes above.
//
// `stream` selects which of the two match paths is measured, and the pair is the point: with it, the
// app's REAL click path (streamedMatch — the route draws itself stretch by stretch); without it, the same
// match with the growing line switched off. Running both is what ATTRIBUTES the cost of §6b(2) instead of
// folding it into the headline number, and it is why the recorded 3327 ms cold match stays comparable
// across the change. Measuring only the non-streaming path would have profiled an interaction the user no
// longer performs — the mistake CLAUDE.md's "measure the common case" rule names.
async function timeMatch(pts, stream) {
  const spec = pts.map(([a, b]) => `${a},${b}`).join(';');
  const t0 = performance.now();
  const text = stream ? await streamedMatch(spec)
                      : await kernel.runKernel(`${LAYOUT}\n${ROADS}\nmatch\n${spec}\n${PROFILE}\n${READ_MODE()}`);
  const t1 = performance.now();
  map.loadMatch(text);
  const t2 = performance.now();
  map.render();
  const t3 = performance.now();
  return { kernel: t1 - t0, parse: t2 - t1, render: t3 - t2, total: t3 - t0, bytes: text.length, pts: pts.length };
}

// Test hook: drive a match programmatically (headless gate), given [[lat,lon],…].
//
// Goes through the SAME queue the click path uses. It used to call the kernel directly, which could
// overlap a view load — and `runKernel` keeps one resolve slot, so the overlap orphans a promise. A hook
// that reaches the kernel by a private road is also a hook that cannot catch a scheduling bug.
window.__match = (pts) => jobs.post('match', async (isCurrent) => {
  const text = await streamedMatch(pts.map(([a, b]) => `${a},${b}`).join(';'), isCurrent);
  const sum = map.loadMatch(text); map.render();
  showRoute(sum);                        // the same bar the sketch path fills — one owner, one truth
  const f = map.route;
  window.__storeApp = { ...(window.__storeApp || {}), matchOk: /ways=\d+/.test(sum), summary: sum, routePts: f.length,
                        routeEnds: f.length ? [f[0], f[f.length - 1]] : null,
                        matchRuns: (window.__storeApp?.matchRuns || 0) + 1 };
  return sum;
});
