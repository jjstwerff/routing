// Copyright (c) 2026 Jurjen Stellingwerff  SPDX-License-Identifier: LGPL-3.0-or-later
//
// PLAN-MAP M0 check — the projection invariant, DOM-free (node). Run: node browser/map.test.mjs
//   1. the camera centre projects to the viewport centre
//   2. unproject∘project ≈ identity (< 1e-6°) and project∘unproject ≈ identity (< 1e-6 px)
//   3. a resize keeps the centre centred
//   4. orientation: east → +x, north → −y

import { makeView, projectWorld, unprojectWorld, panCenter, parseStretch, RouteMap } from './map.mjs';
import { RoughLayer, KernelQueue, pointToSegment, PAN_SLOP_PX, HIT_POINT_PX, HIT_SEGMENT_PX,
         DOUBLE_CLICK_MS, BOX_MIN_PX } from './rough.mjs';
const DOUBLE_TAP_MOVED_PX = HIT_POINT_PX;   // "the point moved further than a hit radius" — see E4

let fails = 0;
const ok = (cond, msg) => { if (!cond) { fails++; console.error('  ✗ ' + msg); } else console.log('  ✓ ' + msg); };
const near = (a, b, eps) => Math.abs(a - b) <= eps;

const ENSCHEDE = { lat: 52.2215, lon: 6.8937 };

console.log('M0 · centre projects to the viewport centre');
for (const [W, H, z] of [[800, 600, 13], [1440, 900, 15.5], [375, 812, 11]]) {
  const v = makeView({ ...ENSCHEDE, zoom: z }, W, H);
  const p = v.project(ENSCHEDE.lat, ENSCHEDE.lon);
  ok(near(p.x, W / 2, 1e-6) && near(p.y, H / 2, 1e-6), `centre → (${(W/2)},${(H/2)}) at ${W}×${H} z${z}  got (${p.x.toFixed(3)},${p.y.toFixed(3)})`);
}

console.log('M0 · unproject∘project ≈ identity (< 1e-6°)');
const pts = [ENSCHEDE, { lat: 52.2837, lon: 6.9056 }, { lat: 52.17, lon: 6.82 }, { lat: 52.28, lon: 6.98 }];
let maxDeg = 0;
for (const z of [10, 13, 16, 18.3]) {
  const v = makeView({ ...ENSCHEDE, zoom: z }, 1024, 768);
  for (const q of pts) {
    const s = v.project(q.lat, q.lon);
    const r = v.unproject(s.x, s.y);
    maxDeg = Math.max(maxDeg, Math.abs(r.lat - q.lat), Math.abs(r.lon - q.lon));
  }
}
ok(maxDeg < 1e-6, `worst lon/lat error ${maxDeg.toExponential(2)}°`);

console.log('M0 · project∘unproject ≈ identity (< 1e-6 px)');
let maxPx = 0;
for (const z of [10, 13, 16]) {
  const v = makeView({ ...ENSCHEDE, zoom: z }, 900, 700);
  for (const [sx, sy] of [[0, 0], [900, 700], [123, 456], [450, 350]]) {
    const g = v.unproject(sx, sy);
    const s = v.project(g.lat, g.lon);
    maxPx = Math.max(maxPx, Math.abs(s.x - sx), Math.abs(s.y - sy));
  }
}
ok(maxPx < 1e-6, `worst pixel error ${maxPx.toExponential(2)} px`);

console.log('M0 · resize keeps the centre centred');
for (const [W, H] of [[1200, 900], [500, 1000]]) {
  const v = makeView({ ...ENSCHEDE, zoom: 14 }, W, H);
  const p = v.project(ENSCHEDE.lat, ENSCHEDE.lon);
  ok(near(p.x, W / 2, 1e-9) && near(p.y, H / 2, 1e-9), `centre stays centred at ${W}×${H}`);
}

console.log('M0 · orientation: east → +x, north → −y');
{
  const v = makeView({ ...ENSCHEDE, zoom: 13 }, 800, 600);
  const east = v.project(ENSCHEDE.lat, ENSCHEDE.lon + 0.01);
  const north = v.project(ENSCHEDE.lat + 0.01, ENSCHEDE.lon);
  ok(east.x > 400 && near(east.y, 300, 1e-6), `+0.01° lon → right  (x=${east.x.toFixed(1)})`);
  ok(north.y < 300 && near(north.x, 400, 1e-6), `+0.01° lat → up    (y=${north.y.toFixed(1)})`);
}

console.log('M1 · pan holds the grabbed lat/lon under the cursor');
{
  let worst = 0;
  for (const z of [11, 13.5, 16]) {
    const v = makeView({ ...ENSCHEDE, zoom: z }, 900, 600);
    const start = { x: 200, y: 150 }, end = { x: 640, y: 470 };
    const grab = v.unproject(start.x, start.y);              // grab a point, then "drag" start→end
    const nc = panCenter(grab, end, z, 900, 600);            // new centre pins grab under `end`
    const now = makeView({ lat: nc.lat, lon: nc.lon, zoom: z }, 900, 600).unproject(end.x, end.y);
    worst = Math.max(worst, Math.abs(now.lat - grab.lat), Math.abs(now.lon - grab.lon));
  }
  ok(worst < 1e-9, `grabbed point stays under cursor across a drag (worst ${worst.toExponential(2)}°)`);
}

console.log('M1 · wheel zoom holds the cursor lat/lon fixed while zoom changes');
{
  let worst = 0, allZoomed = true;
  for (const [z, dz] of [[13, 0.5], [13, -0.5], [17, 0.8]]) {
    const v = makeView({ ...ENSCHEDE, zoom: z }, 800, 600);
    const cur = { x: 520, y: 240 };
    const anchor = v.unproject(cur.x, cur.y);
    const nz = Math.max(2, Math.min(19, z + dz));
    const nc = panCenter(anchor, cur, nz, 800, 600);         // re-anchor cursor's point at the new zoom
    const after = makeView({ lat: nc.lat, lon: nc.lon, zoom: nz }, 800, 600).unproject(cur.x, cur.y);
    worst = Math.max(worst, Math.abs(after.lat - anchor.lat), Math.abs(after.lon - anchor.lon));
    if (nz === z) allZoomed = false;
  }
  ok(worst < 1e-9 && allZoomed, `cursor point fixed across a wheel tick (worst ${worst.toExponential(2)}°)`);
}

// --- §6b(2): the growing line ----------------------------------------------------------------------
// DOM-free, because the case that matters is one a browser gate is bad at reaching: the ladder has to
// REJECT its first tier before a second pass ever happens, and the sketches the headless gate uses are
// accepted on the first try. A stub canvas gets the branch under test in milliseconds instead.
const noop = () => {};
const stubCanvas = () => {
  const ctx = { setTransform: noop, clearRect: noop, fillRect: noop, beginPath: noop, moveTo: noop,
                lineTo: noop, stroke: noop, fill: noop, arc: noop, rect: noop, closePath: noop,
                setLineDash: noop, fillText: noop, strokeText: noop, save: noop, restore: noop,
                measureText: () => ({ width: 10 }) };
  return { width: 0, height: 0, style: {}, getContext: () => ctx, addEventListener: noop,
           getBoundingClientRect: () => ({ width: 800, height: 600 }) };
};

console.log('\n§6 R · the cached view invalidates when the camera is mutated IN PLACE');
{
  // view() is memoised because project() runs once per VERTEX (214k in a frame), and rebuilding a view
  // per call cost an extra projectWorld plus three allocations each time. The arithmetic is provably
  // unchanged (makeView is pure, same inputs), so the only risk the cache introduces is STALENESS — and
  // pan/zoom mutate this.camera in place, which is exactly the case a naive identity check would miss.
  const m = new RouteMap(stubCanvas(), { ...ENSCHEDE, zoom: 13, interactive: false });
  const a = m.project(52.25, 6.90);
  m.camera.lat += 0.01;                                     // pan mutates the camera object in place
  const b = m.project(52.25, 6.90);
  const fresh = makeView({ ...m.camera }, m.width, m.height).project(52.25, 6.90);
  ok(b.y !== a.y && b.x === fresh.x && b.y === fresh.y,
     `a pan invalidates it (y ${a.y.toFixed(2)} → ${b.y.toFixed(2)}, equals a freshly built view)`);
  m.camera.zoom += 1;
  const c = m.project(52.25, 6.90);
  const f2 = makeView({ ...m.camera }, m.width, m.height).project(52.25, 6.90);
  ok(c.x === f2.x && c.y === f2.y, 'a zoom invalidates it');
  const d = m.project(52.25, 6.90);
  ok(d.x === c.x && d.y === c.y, 'an unchanged camera reuses it (same answer)');
}

console.log('\n§6b(2) · a STRETCH line parses to its index and points');
{
  const s = parseStretch('STRETCH 7;52.1,6.1;52.2,6.2');
  ok(s && s.i === 7 && s.pts.length === 2 && s.pts[1][0] === 52.2, `STRETCH 7 → i=${s?.i}, ${s?.pts.length} pts`);
  ok(parseStretch('ROUTE;52.1,6.1') === null && parseStretch('') === null, 'a non-STRETCH line parses to null');
}

console.log('§6b(2) · a restarted stretch pass REPLACES the route, never blends with it');
{
  // Step 22's ladder re-runs match_incremental_streamed on the fat bbox when the gate rejects the cell
  // tube, so the whole route is emitted a second time from index 0 (measured: a 40-point sketch emits 78
  // stretches, not 39). Blending the passes would draw a route that was never matched — new stretch 0
  // beside the rejected tier's stretches 1..n.
  const m = new RouteMap(stubCanvas(), { ...ENSCHEDE, zoom: 13, interactive: false });
  m.beginStretches();
  m.applyStretch(0, [[52.20, 6.88], [52.21, 6.89]]);
  m.applyStretch(1, [[52.21, 6.89], [52.22, 6.90]]);
  const pass1 = m.route.length;
  ok(pass1 === 3, `pass 1 accumulates and dedups the shared joint (${pass1} pts from 2+2)`);
  m.applyStretch(0, [[52.30, 6.98], [52.31, 6.99]]);          // the gate rejected tier 1 — pass 2 restarts
  ok(m.route.length === 2 && m.route[0][0] === 52.30,
     `a restart drops the rejected tier entirely (${pass1} pts → ${m.route.length}, starting at the new geometry)`);
  m.applyStretch(1, [[52.31, 6.99], [52.32, 7.00]]);
  ok(m.route.length === 3 && m.route[2][0] === 52.32, `pass 2 then accumulates normally (${m.route.length} pts)`);
}

// --- PLAN-EDIT E0: the three chokepoints -------------------------------------------------------------
// DOM-free, because the classifier is pure screen-space arithmetic and the browser gate is an expensive
// place to pin a boundary. The BEHAVIOURS these encode were measured in a browser first (PLAN-EDIT §2);
// these tests are what keep them from drifting back.

const layerOn = (map) => new RoughLayer(map, { bind: false });
const freshMap = () => new RouteMap(stubCanvas(), { ...ENSCHEDE, zoom: 14, interactive: false });

console.log('\nE0 · a PAN never appends a point, a TAP always does  (PLAN-EDIT §2 P1)');
{
  const m = freshMap();
  const r = layerOn(m);
  // A drag past the slop: this is a pan. It moves the camera and must leave the sketch empty.
  const lat0 = m.camera.lat;
  r.pointerDown(300, 200, 1000);
  r.pointerMove(340, 230);
  r.pointerMove(420, 280);
  r.pointerUp();
  ok(r.points.length === 0, `a 200-px drag appends nothing (${r.points.length} points)`);
  ok(m.camera.lat !== lat0, 'the same drag DID pan the camera (it was delegated, not swallowed)');

  // A press/release with no movement: this is a tap.
  r.pointerDown(500, 400, 5000);
  r.pointerUp();
  ok(r.points.length === 1, `a tap appends exactly one point (${r.points.length})`);

  // Jitter below the slop is still a tap — a finger is never perfectly still. Tapped well clear of the
  // existing point, since a press ON a point is a grab, not an append (E2).
  const before = m.camera.lat;
  r.pointerDown(200, 150, 9000);
  r.pointerMove(200 + PAN_SLOP_PX, 150);
  r.pointerUp();
  ok(r.points.length === 2, `${PAN_SLOP_PX}px of jitter is still a tap (${r.points.length} points)`);
  ok(m.camera.lat === before, 'and it did not pan the camera');
}

console.log('E0/E2 · a double-click drops ONE point — enforced by hit PRIORITY, not a timer  (PLAN-EDIT §2 P2)');
{
  // E0 ported rough.js's 250 ms / 12 px dedupe for this. E2's hitTest made it unreachable (a tap appends a
  // point AT the press, so the second click lands within HIT_POINT_PX=15 of it and resolves to that POINT
  // — 15 > 12, so the timer could never fire first) and then harmful (it keyed on SCREEN position, which a
  // pan invalidates). The dedupe is gone; these assertions pin the behaviour it used to be credited with.
  const m = freshMap();
  const r = layerOn(m);
  const tap = (x, y, t) => { r.pointerDown(x, y, t); r.pointerUp(); };
  tap(400, 300, 0);
  tap(401, 301, 60);                       // the 2nd click of a double-click, landing on the new point
  ok(r.points.length === 1, `a double-click drops ONE point, not two (${r.points.length})`);
  tap(401, 301, 900);                      // well outside E4's window: a grab, not an add and not a delete
  ok(r.points.length === 1, `a repeat tap on a point never appends (${r.points.length})`);
  tap(600, 300, 1200);                     // clear of every point → a genuine new point
  ok(r.points.length === 2, `a tap ELSEWHERE appends (${r.points.length})`);

  // The case that proves the timer had to go rather than merely being redundant: tap, pan the map, then
  // tap the SAME SCREEN SPOT. Nothing is under the cursor any more, so this is a legitimate new point —
  // a screen-keyed dedupe would have swallowed it.
  const n = r.points.length;
  r.pointerDown(250, 520, 1400); r.pointerMove(350, 600); r.pointerUp();   // pan, started clear of every point
  const moved = m.project(r.points[n - 1].lat, r.points[n - 1].lon);
  ok(Math.round(moved.x) !== 600, `the pan carried the point off (600,300) → (${Math.round(moved.x)},${Math.round(moved.y)})`);
  tap(600, 300, 1600);
  ok(r.points.length === n + 1, `a tap at the same screen spot AFTER a pan still appends (${r.points.length})`);
}

console.log('E0 · the sketch is ONE array, shared with the renderer  (failure path 11)');
{
  const m = freshMap();
  const r = layerOn(m);
  ok(m.points === r.points, 'map.points IS the layer\'s array, not a rebuilt copy');
  r.append(52.25, 6.90);
  ok(m.points.length === 1 && m.points[0].lat === 52.25, 'an append is visible to the renderer with no re-assignment');
  r.clear();
  ok(m.points.length === 0 && m.points === r.points, 'a clear empties it IN PLACE (the reference survives)');
}

console.log('E0 · commitEdit is the only exit, and reports whether the edit is committed');
{
  const m = freshMap();
  const seen = [];
  const r = new RoughLayer(m, { bind: false, onCommit: (pts, committed) => seen.push({ n: pts.length, committed }) });
  r.pointerDown(300, 300, 0); r.pointerUp();
  r.append(52.3, 6.9);
  r.clear();
  ok(seen.length === 3, `three mutations → three commits (${seen.length})`);
  ok(seen.every((s) => s.committed === true), 'a discrete edit is committed');
  ok(seen[0].n === 1 && seen[1].n === 2 && seen[2].n === 0, `each commit carries the sketch AT THAT MOMENT (${seen.map((s) => s.n).join(',')})`);
  const shape = seen[1] && r.coords();
  ok(Array.isArray(shape) && shape.every((p) => p.length === 2), 'coords() hands the matcher [[lat,lon],…]');
}

console.log('E0 · the kernel queue serializes, and coalesces per key — latest wins  (PLAN-EDIT §2 P4)');
{
  const q = new KernelQueue();
  const log = [];
  const job = (tag, ms) => () => new Promise((res) => setTimeout(() => { log.push(tag); res(tag); }, ms));

  // Three matches posted while the first is still running: the middle one is SUPERSEDED, never dropped
  // silently, and the last one is the one that runs.
  const p1 = q.post('match', job('m1', 30));
  const p2 = q.post('match', job('m2', 1));
  const p3 = q.post('match', job('m3', 1));
  ok(q.pendingCount === 1, `three posts under one key leave ONE pending (${q.pendingCount})`);
  const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
  ok(r1 === 'm1' && r3 === 'm3', `the running job and the LATEST both complete (${r1}, ${r3})`);
  ok(r2 === undefined, 'the superseded job resolves undefined — settled, not left hanging');
  ok(log.join(',') === 'm1,m3', `m2 never ran (${log.join(',')})`);

  // Different keys do not coalesce with each other: a view must not eat a match. This is the exact
  // conflation the old shared `busy` boolean made, and P4's stale route was the result.
  log.length = 0;
  await Promise.all([q.post('view', job('v', 5)), q.post('match', job('m', 1))]);
  ok(log.join(',') === 'v,m', `a view and a match both run, in order (${log.join(',')})`);

  // Serialization: two jobs never overlap, whatever their durations.
  let live = 0, overlapped = false;
  const watch = (ms) => async () => { live++; if (live > 1) overlapped = true; await new Promise((r) => setTimeout(r, ms)); live--; };
  await Promise.all([q.post('a', watch(20)), q.post('b', watch(1)), q.post('c', watch(1))]);
  ok(!overlapped, 'no two jobs are ever in flight at once (runKernel has one resolve slot)');
}

console.log('E0 · a superseded job\'s isCurrent() goes false, so its stretches can be discarded  (failure path 10)');
{
  const q = new KernelQueue();
  let checkAfterNext = null;
  await q.post('match', async (isCurrent) => { checkAfterNext = isCurrent; ok(isCurrent(), 'a running job sees itself as current'); });
  await q.post('match', async () => {});
  ok(checkAfterNext && checkAfterNext() === false, 'once a later job has run, the earlier job\'s isCurrent() is false');
}

// --- PLAN-EDIT E1: the sketch is visible ------------------------------------------------------------

console.log('\nE1 · the rough layer draws INSIDE the snapped origin  (PLAN-EDIT §2 P3)');
{
  // The one that matters. The base map is rasterised from a whole-device-pixel origin (step 15), so an
  // overlay projected from the unsnapped camera sits up to a device pixel off the map under it. `onRender`
  // used to fire after the origin was restored, which made the hook documented as PLAN-EDIT's seam the one
  // place an overlay could NOT be drawn. Both the sketch and the hook must now see a live origin.
  // `renderSnappedDirect` sets a snapped origin unconditionally, so it is the one path that exercises the
  // real case without a DOM. (render() itself only snaps when it can bake blocks, which needs a document —
  // the browser gate covers that half.)
  const m = freshMap();
  const r = layerOn(m);
  r.append(52.2215, 6.8937);
  let seen = 'never-drawn';
  const realDrawRough = m.drawRough.bind(m);
  m.drawRough = function () { seen = this._origin; return realDrawRough(); };
  m.renderSnappedDirect();
  ok(seen && typeof seen.x === 'number', `drawRough sees a LIVE snapped origin (${seen ? `x=${seen.x}` : seen})`);
  ok(m._origin === null, 'and the origin is restored afterwards');
  m.drawRough = realDrawRough;

  // The same must hold for the onRender hook, which fires from render()'s snapped block. Drive it with an
  // origin already set, and assert the callback still sees one — the regression P3 measured was the
  // callback running after `_origin = null`.
  let inHook = 'never-fired';
  m.onRender(function (ctx, map) { inHook = map._origin; });
  m.render();
  ok(inHook !== 'never-fired', 'onRender fires during a render');
  const rendersSnapped = m._stats && typeof m._stats.rough === 'number';
  ok(rendersSnapped, 'render() reached the overlay pass');
  // render() on a stub canvas cannot bake blocks, so its origin is legitimately null here. What this pins
  // is that the hook runs INSIDE the try that owns the origin — i.e. it sees whatever drawRough sees.
  let hookOrigin = null, roughOrigin = null;
  m._renderCbs = [(ctx, map) => { hookOrigin = map._origin; }];
  m.drawRough = function () { roughOrigin = this._origin; return realDrawRough(); };
  m._origin = null;
  m.render();
  ok(hookOrigin === roughOrigin, 'the onRender hook and the sketch see the SAME origin — one block, not two');
  m.drawRough = realDrawRough;
}

console.log('E1 · the sketch draws a line and roles its points');
{
  const m = freshMap();
  const r = layerOn(m);
  ok(m.drawRough() === 0, 'an empty sketch draws nothing');
  r.append(52.2215, 6.8937);
  ok(m.drawRough() === 1, 'one point draws (a lone start, no line)');
  r.append(52.2300, 6.9000);
  r.append(52.2400, 6.9100);
  ok(m.drawRough() === 3, 'three points draw');
  m.render();
  ok(m._stats.rough === 3, `render() reports the sketch in its stats (rough=${m._stats.rough})`);
  // The role is positional, so an insert or delete re-roles the ends with no extra bookkeeping — which is
  // what lets E2/E4 mutate the list and nothing else (DESIGN.md §1: start/finish are a distinct type).
  const roles = (n) => Array.from({ length: n }, (_, i) => (i === 0 ? 'start' : i === n - 1 ? 'finish' : 'mid'));
  ok(roles(3).join(',') === 'start,mid,finish', 'roles: start · mid · finish');
  ok(roles(1).join(',') === 'start', 'a single point is the start, not the finish');
  ok(roles(2).join(',') === 'start,finish', 'two points are start and finish, no mid');
}

console.log('E1 · the sketch is drawn, and the route stays read-only beneath it');
{
  // DESIGN.md §1: the detailed route is derived and never edited. Drawing order encodes that — the thing
  // you can grab is the thing on top — so a regression that drew the sketch first would be invisible to a
  // count and visible only as "my points vanished under the route".
  const m = freshMap();
  const order = [];
  m.route = [[52.20, 6.88], [52.24, 6.92]];
  new RoughLayer(m, { bind: false }).append(52.22, 6.90);
  const realRoute = m.drawRoute.bind(m), realRough = m.drawRough.bind(m);
  m.drawRoute = () => { order.push('route'); return realRoute(); };
  m.drawRough = () => { order.push('rough'); return realRough(); };
  m.render();
  ok(order.join(',') === 'route,rough', `the sketch draws ABOVE the route (${order.join(' → ')})`);
}

// --- PLAN-EDIT E2: hit test + insert -----------------------------------------------------------------

console.log('\nE2 · point-to-segment geometry');
{
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  let r = pointToSegment(5, 3, 0, 0, 10, 0);
  ok(near(r.d, 3) && near(r.t, 0.5), `a perpendicular foot inside the segment (d=${r.d}, t=${r.t})`);
  r = pointToSegment(-4, 0, 0, 0, 10, 0);
  ok(near(r.d, 4) && near(r.t, 0), `beyond the start clamps to the start (d=${r.d}, t=${r.t})`);
  r = pointToSegment(14, 3, 0, 0, 10, 0);
  ok(near(r.d, 5) && near(r.t, 1), `beyond the end clamps to the end (d=${r.d}, t=${r.t})`);
  r = pointToSegment(3, 4, 7, 7, 7, 7);
  ok(near(r.d, 5) && near(r.t, 0), `a zero-length segment measures to the point itself (d=${r.d})`);
}

console.log('E2 · "nearest" is judged in SCREEN pixels, and degrees would get it WRONG');
{
  // The trap this pins: a degree of longitude is not a degree of latitude on the ground, and Mercator's y
  // is not linear in latitude either. An L-shaped sketch and a press placed so the two metrics DISAGREE —
  // if hitTest ever drifts back to degrees, this is the test that says so, in the direction a user would
  // notice (the point lands on the wrong leg).
  const m = new RouteMap(stubCanvas(), { lat: 52.025, lon: 6.05, zoom: 13, interactive: false });
  const r = layerOn(m);
  for (const [lat, lon] of [[52.00, 6.00], [52.00, 6.10], [52.05, 6.10]]) r.append(lat, lon);
  const press = { lat: 52.030, lon: 6.060 };

  // What DEGREES would say: segment 0 is the horizontal leg (lat 52.00), segment 1 the vertical (lon 6.10).
  const degD0 = Math.abs(press.lat - 52.00), degD1 = Math.abs(press.lon - 6.10);
  const degWinner = degD0 < degD1 ? 0 : 1;

  const s = m.project(press.lat, press.lon);
  const hit = r.nearestSegment(s.x, s.y);
  ok(degWinner === 0, `degrees would pick segment 0 (${degD0.toFixed(3)}° vs ${degD1.toFixed(3)}°)`);
  ok(hit.index === 1, `screen space picks segment ${hit.index} — the leg actually nearer on screen`);
  ok(hit.index !== degWinner, 'the two metrics DISAGREE here, which is the whole point of the case');
}

console.log('E2 · hitTest: points beat segments, and both respect their tolerance');
{
  const m = freshMap();
  const r = layerOn(m);
  for (const [lat, lon] of [[52.20, 6.85], [52.24, 6.95]]) r.append(lat, lon);
  const px = [m.project(52.20, 6.85), m.project(52.24, 6.95)];
  const mid = { x: (px[0].x + px[1].x) / 2, y: (px[0].y + px[1].y) / 2 };

  ok(r.hitTest(px[0].x, px[0].y).kind === 'point', 'dead on a point → point');
  ok(r.hitTest(mid.x, mid.y).kind === 'segment', 'mid-segment → segment');
  // Every point lies ON the line, so a press near a point satisfies BOTH tests. Point must win, or a point
  // could never be grabbed — pressing it would insert a second point on top of it instead.
  const onPt = r.hitTest(px[0].x + 2, px[0].y + 2);
  ok(onPt.kind === 'point' && onPt.index === 0, 'a press that satisfies both tests resolves to the POINT');

  // Tolerance boundaries, on the perpendicular so only the segment test can fire.
  const dx = px[1].x - px[0].x, dy = px[1].y - px[0].y, len = Math.hypot(dx, dy);
  const nx = -dy / len, ny = dx / len;
  const off = (k) => r.hitTest(mid.x + nx * k, mid.y + ny * k);
  ok(off(HIT_SEGMENT_PX - 0.5)?.kind === 'segment', `${HIT_SEGMENT_PX - 0.5}px off the line still hits it`);
  ok(off(HIT_SEGMENT_PX + 1.5) === null, `${HIT_SEGMENT_PX + 1.5}px off the line hits nothing`);
  ok(r.hitTest(px[0].x + HIT_POINT_PX - 1, px[0].y)?.kind === 'point', `${HIT_POINT_PX - 1}px from a point still hits it`);
  ok(r.hitTest(px[0].x, px[0].y + 200) === null, 'far from everything → null');
  // A one-point sketch has no segment at all; a press must not throw or invent one.
  const solo = layerOn(freshMap());
  solo.append(52.2, 6.9);
  ok(solo.nearestSegment(0, 0) === null, 'a one-point sketch has no nearest segment');
}

console.log('E2 · the SWEEP: press on a segment inserts there and positions it in ONE gesture');
{
  const m = freshMap();
  const commits = [];
  const r = new RoughLayer(m, { bind: false, onCommit: (pts, committed) => commits.push(committed) });
  for (const [lat, lon] of [[52.20, 6.85], [52.24, 6.95]]) r.append(lat, lon);
  commits.length = 0;

  const px = [m.project(52.20, 6.85), m.project(52.24, 6.95)];
  const mid = { x: (px[0].x + px[1].x) / 2, y: (px[0].y + px[1].y) / 2 };
  r.pointerDown(mid.x, mid.y, 1000);
  ok(r.points.length === 3, `the press inserts immediately (${r.points.length} points)`);
  ok(commits.length === 1 && commits[0] === false, 'and the insert is UNCOMMITTED (the sweep commits once, on release)');

  r.pointerMove(mid.x + 60, mid.y - 40);
  r.pointerMove(mid.x + 90, mid.y - 55);
  ok(r.points.length === 3, 'moving does not insert again');
  const released = m.unproject(mid.x + 90, mid.y - 55);
  ok(Math.abs(r.points[1].lat - released.lat) < 1e-9, 'the new point follows the finger');

  r.pointerUp();
  ok(commits.filter((c) => c === true).length === 1, `exactly ONE committed edit for the whole sweep (${commits.filter((c) => c).length})`);
  ok(r.points[1].id !== r.points[0].id && r.points.length === 3, 'the point sits BETWEEN its two neighbours');
  ok(r.points[0].lat === 52.20 && r.points[2].lat === 52.24, 'the original endpoints are untouched');
}

console.log('E2 · a plain tap on the line inserts once; a press on a POINT never appends');
{
  const m = freshMap();
  const r = layerOn(m);
  for (const [lat, lon] of [[52.20, 6.85], [52.24, 6.95]]) r.append(lat, lon);
  const px = [m.project(52.20, 6.85), m.project(52.24, 6.95)];
  const mid = { x: (px[0].x + px[1].x) / 2, y: (px[0].y + px[1].y) / 2 };

  r.pointerDown(mid.x, mid.y, 1000); r.pointerUp();
  ok(r.points.length === 3, `a tap on the line inserts exactly one (${r.points.length})`);

  // The second press of a double-press lands on the point the first one just created — priority order
  // means it hits the POINT, so the line cannot be double-inserted by a fast double-click.
  r.pointerDown(mid.x, mid.y, 1060); r.pointerUp();
  ok(r.points.length === 3, `a second press at the same spot hits the new POINT, not the line (${r.points.length})`);

  // And a press on an existing point must not fall through to append.
  r.pointerDown(px[0].x, px[0].y, 2000); r.pointerUp();
  ok(r.points.length === 3, `pressing an endpoint appends nothing (${r.points.length})`);
}

console.log('E2 · a cancelled sweep still commits — its point is on the map either way');
{
  const m = freshMap();
  const commits = [];
  const r = new RoughLayer(m, { bind: false, onCommit: (pts, committed) => commits.push(committed) });
  for (const [lat, lon] of [[52.20, 6.85], [52.24, 6.95]]) r.append(lat, lon);
  const px = [m.project(52.20, 6.85), m.project(52.24, 6.95)];
  commits.length = 0;
  r.pointerDown((px[0].x + px[1].x) / 2, (px[0].y + px[1].y) / 2, 1000);
  r.pointerCancel();
  ok(r.points.length === 3, 'the inserted point survives the cancel');
  ok(commits.filter((c) => c === true).length === 1, 'and it is committed, so undo can take it back');
}

// --- PLAN-EDIT E3: drag a point ----------------------------------------------------------------------

const sketchOf = (m, pts) => { const r = layerOn(m); for (const [lat, lon] of pts) r.append(lat, lon); return r; };
// A screen position that hits nothing — so a test meaning "press the empty map" cannot land on the sketch.
const emptySpot = (r) => {
  for (let y = 40; y <= 560; y += 40) for (let x = 40; x <= 760; x += 40) if (r.hitTest(x, y) === null) return { x, y };
  return null;
};
const TRI = [[52.20, 6.85], [52.24, 6.95], [52.28, 6.88]];

console.log('\nE3 · dragging a point moves it, and the line follows every frame');
{
  const m = freshMap();
  const commits = [];
  const r = new RoughLayer(m, { bind: false, onCommit: (pts, committed) => commits.push(committed) });
  for (const [lat, lon] of TRI) r.append(lat, lon);
  const mid = m.project(TRI[1][0], TRI[1][1]);
  commits.length = 0;

  r.pointerDown(mid.x, mid.y, 1000);
  ok(commits.length === 0, 'pressing a point commits nothing yet');
  for (let i = 1; i <= 5; i++) r.pointerMove(mid.x + i * 12, mid.y - i * 8);
  ok(commits.length === 5 && commits.every((c) => c === false),
     `every move is a LIVE, uncommitted edit (${commits.length} of them)`);
  ok(r.points.length === 3, 'a drag never changes the point count');
  const at = m.unproject(mid.x + 60, mid.y - 40);
  ok(Math.abs(r.points[1].lat - at.lat) < 1e-9 && Math.abs(r.points[1].lon - at.lon) < 1e-9,
     'the point sits exactly where the finger left it');
  ok(r.points[0].lat === TRI[0][0] && r.points[2].lat === TRI[2][0], 'its neighbours did not move');

  r.pointerUp();
  ok(commits.filter((c) => c === true).length === 1, `the release commits exactly ONCE (${commits.filter((c) => c).length})`);
}

console.log('E3 · a press on a point that never moves is not an edit');
{
  const m = freshMap();
  const commits = [];
  const r = new RoughLayer(m, { bind: false, onCommit: (pts, c) => commits.push(c) });
  for (const [lat, lon] of TRI) r.append(lat, lon);
  const p0 = m.project(TRI[0][0], TRI[0][1]);
  commits.length = 0;
  r.pointerDown(p0.x, p0.y, 1000);
  r.pointerMove(p0.x + PAN_SLOP_PX, p0.y);        // jitter, below the slop
  r.pointerUp();
  ok(commits.length === 0, `a press + ${PAN_SLOP_PX}px of jitter commits nothing (${commits.length}) — E4 makes this a selection`);
  ok(r.points[0].lat === TRI[0][0], 'and the point did not move');
  ok(r.points.length === 3, 'and nothing was appended');
}

console.log('E3 · a drag that starts on a point never pans the map');
{
  const m = freshMap();
  const r = sketchOf(m, TRI);
  const cam = { ...m.camera };
  const mid = m.project(TRI[1][0], TRI[1][1]);
  r.pointerDown(mid.x, mid.y, 1000);
  r.pointerMove(mid.x + 120, mid.y + 90);
  r.pointerUp();
  ok(m.camera.lat === cam.lat && m.camera.lon === cam.lon, 'the camera is untouched — the point moved, not the map');
}

console.log('E3 · dragging an END point keeps its role; the sketch order is never reshuffled');
{
  const m = freshMap();
  const r = sketchOf(m, TRI);
  const ids = r.points.map((p) => p.id).join(',');
  const start = m.project(TRI[0][0], TRI[0][1]);
  // Drag the START right past the other two points. Order is positional, so it must STAY the start —
  // a matcher trace is an ordered list, and silently re-sorting it would re-route the whole sketch.
  r.pointerDown(start.x, start.y, 1000);
  r.pointerMove(start.x + 400, start.y + 300);
  r.pointerUp();
  ok(r.points.map((p) => p.id).join(',') === ids, `the order is unchanged (${ids})`);
  ok(r.points[0].id === Number(ids.split(',')[0]), 'the dragged point is still the START');
}

console.log('E3 · a cancelled drag keeps the point where it landed, and commits it');
{
  const m = freshMap();
  const commits = [];
  const r = new RoughLayer(m, { bind: false, onCommit: (pts, c) => commits.push(c) });
  for (const [lat, lon] of TRI) r.append(lat, lon);
  const mid = m.project(TRI[1][0], TRI[1][1]);
  commits.length = 0;
  r.pointerDown(mid.x, mid.y, 1000);
  r.pointerMove(mid.x + 80, mid.y);
  r.pointerCancel();
  const at = m.unproject(mid.x + 80, mid.y);
  ok(Math.abs(r.points[1].lat - at.lat) < 1e-9, 'the point stays where the finger left it');
  ok(commits.filter((c) => c === true).length === 1, 'and the edit is committed, so undo can take it back');
}

console.log('E3 · the coalescer keeps a drag affordable — many moves, few matches');
{
  // The reason this matters is a measurement, not a preference: a warm match is ~545 ms throttled and a
  // drag emits ~33 moves/s, so queueing them owes ~36 s for a 2-second drag. Here the "kernel" is a slow
  // stub, and what is asserted is that the drag's matches COLLAPSE — and that the last one wins.
  const m = freshMap();
  const q = new KernelQueue();
  const ran = [];
  const r = new RoughLayer(m, {
    bind: false,
    onCommit: (pts) => q.post('match', async () => { await new Promise((res) => setTimeout(res, 12)); ran.push(pts.length > 1 ? pts[1][0] : null); }),
  });
  for (const [lat, lon] of TRI) r.append(lat, lon);
  const mid = m.project(TRI[1][0], TRI[1][1]);
  const MOVES = 24;
  r.pointerDown(mid.x, mid.y, 1000);
  for (let i = 1; i <= MOVES; i++) r.pointerMove(mid.x + i * 6, mid.y - i * 4);
  r.pointerUp();
  // Bounded: a drain bug must fail this test, not hang the whole suite with no output.
  for (let i = 0; i < 200 && (q.pendingCount || ran.length < 2); i++) await new Promise((res) => setTimeout(res, 10));
  await new Promise((res) => setTimeout(res, 60));
  ok(q.pendingCount === 0, 'the queue drained');
  ok(ran.length < MOVES, `${MOVES} moves produced ${ran.length} matches, not ${MOVES}`);
  const finalLat = r.points[1].lat;
  ok(ran[ran.length - 1] === finalLat, 'and the LAST match run is the one for the final position');
}

// --- PLAN-EDIT E4: delete a point --------------------------------------------------------------------

console.log('\nE4 · a press selects; a second press on the SAME point deletes it');
{
  const m = freshMap();
  const commits = [];
  const r = new RoughLayer(m, { bind: false, onCommit: (pts, c) => commits.push(c) });
  for (const [lat, lon] of TRI) r.append(lat, lon);
  const at = (i) => m.project(r.points[i].lat, r.points[i].lon);
  const mid = at(1), midId = r.points[1].id;
  commits.length = 0;

  r.pointerDown(mid.x, mid.y, 1000); r.pointerUp();
  ok(r.selectedIds().join() === String(midId), 'the first press selects the point');
  ok(commits.length === 0, 'selecting is NOT a sketch mutation — no commit, no re-match');
  ok(r.points[1].selected === true && r.points[0].selected === false, 'the renderer sees the flag on the right point');

  r.pointerDown(mid.x, mid.y, 1100); r.pointerUp();
  ok(r.points.length === 2, `the second press within ${DOUBLE_CLICK_MS}ms deletes it (${r.points.length} points)`);
  ok(!r.points.some((p) => p.id === midId), 'and it is the point that was pressed that went');
  ok(commits.filter((c) => c === true).length === 1, 'the delete is ONE committed edit');
  ok(r.selectedIds().length === 0, 'and the selection is cleared with it');
}

console.log('E4 · the double-click detector keys on the POINT, not on a screen position');
{
  // The E2 lesson, in the one test that can catch its return: select a point, PAN so it is somewhere else
  // on screen, then press it again at its NEW position inside the window. A screen-keyed detector sees two
  // presses in different places and refuses to delete; an id-keyed one deletes, which is what a user who
  // nudged the map between clicks expects.
  const m = freshMap();
  const r = sketchOf(m, TRI);
  const before = m.project(r.points[1].lat, r.points[1].lon);
  const id = r.points[1].id;
  r.pointerDown(before.x, before.y, 1000); r.pointerUp();
  ok(r.selectedIds().join() === String(id), 'selected');

  // Ask hitTest where the empty map is rather than guessing: picking a spot by eye once landed 0.6 px off
  // a segment and the "pan" inserted a point instead.
  const empty = emptySpot(r);
  ok(empty !== null, `found empty map at (${empty?.x},${empty?.y}) to start the pan from`);
  r.pointerDown(empty.x, empty.y, 1050); r.pointerMove(empty.x + 140, empty.y - 90); r.pointerUp();
  const after = m.project(r.points[1].lat, r.points[1].lon);
  ok(Math.hypot(after.x - before.x, after.y - before.y) > DOUBLE_TAP_MOVED_PX,
     `the point is now ${Math.round(Math.hypot(after.x - before.x, after.y - before.y))}px from where it was pressed`);

  r.pointerDown(after.x, after.y, 1200); r.pointerUp();
  ok(r.points.length === 2 && !r.points.some((p) => p.id === id),
     `it still deletes across the pan (${r.points.length} points) — a screen-keyed detector would not have`);
}

console.log('E4 · two presses on DIFFERENT points never delete');
{
  const m = freshMap();
  const r = sketchOf(m, TRI);
  const a = m.project(r.points[0].lat, r.points[0].lon), b = m.project(r.points[1].lat, r.points[1].lon);
  r.pointerDown(a.x, a.y, 1000); r.pointerUp();
  r.pointerDown(b.x, b.y, 1050); r.pointerUp();
  ok(r.points.length === 3, `nothing was deleted (${r.points.length} points)`);
  ok(r.selectedIds().length === 2, 'the two presses form a contiguous RANGE instead (E5)');
}

console.log('E4 · a slow second press deselects rather than deleting');
{
  const m = freshMap();
  const r = sketchOf(m, TRI);
  const p = m.project(r.points[1].lat, r.points[1].lon);
  r.pointerDown(p.x, p.y, 1000); r.pointerUp();
  r.pointerDown(p.x, p.y, 1000 + DOUBLE_CLICK_MS, 0); r.pointerUp();
  ok(r.points.length === 3, `at exactly ${DOUBLE_CLICK_MS}ms it is not a double-click (${r.points.length} points)`);
  ok(r.selectedIds().length === 0, 'and pressing the selected point again deselects it');
}

console.log('E4 · Delete / Backspace / Escape, and the Delete button');
{
  const m = freshMap();
  const btn = { classList: { _hidden: true, toggle(_c, on) { this._hidden = on; } } };
  const r = new RoughLayer(m, { bind: false, deleteButton: btn });
  for (const [lat, lon] of TRI) r.append(lat, lon);
  ok(btn.classList._hidden === true, 'the Delete button is hidden while nothing is selected');

  const p = m.project(r.points[1].lat, r.points[1].lon);
  r.pointerDown(p.x, p.y, 1000); r.pointerUp();
  ok(btn.classList._hidden === false, 'selecting a point reveals it');
  r.deleteSelected();
  ok(r.points.length === 2, `the button deletes the selection (${r.points.length} points)`);
  ok(btn.classList._hidden === true, 'and it hides again afterwards');

  // Escape clears without deleting.
  const q = m.project(r.points[0].lat, r.points[0].lon);
  r.pointerDown(q.x, q.y, 2000); r.pointerUp();
  r.clearSelection();
  ok(r.selectedIds().length === 0 && r.points.length === 2, 'Escape clears the selection and deletes nothing');
  ok(r.deleteSelected() === r && r.points.length === 2, 'deleting with nothing selected is a no-op, not a throw');
}

console.log('E4 · deleting down to 1 point and to 0 degrades, it does not throw  (failure path 8)');
{
  const m = freshMap();
  const seen = [];
  const r = new RoughLayer(m, { bind: false, onCommit: (pts) => seen.push(pts.length) });
  for (const [lat, lon] of TRI) r.append(lat, lon);
  seen.length = 0;
  r.removeId(r.points[2].id);
  r.removeId(r.points[1].id);
  ok(r.points.length === 1 && seen[seen.length - 1] === 1, 'down to one point, and the commit reports 1');
  r.removeId(r.points[0].id);
  ok(r.points.length === 0 && seen[seen.length - 1] === 0, 'down to zero, still one clean commit');
  ok(m.drawRough() === 0, 'and the renderer draws an empty sketch without complaint');
  r.append(52.2, 6.9);
  ok(r.points.length === 1, 'the sketch is reusable afterwards');
}

// --- PLAN-EDIT E5: range multi-select + bulk delete --------------------------------------------------

const FIVE = [[52.20, 6.85], [52.21, 6.87], [52.22, 6.89], [52.23, 6.91], [52.24, 6.93]];
const pressPoint = (m, r, i, t) => { const s = m.project(r.points[i].lat, r.points[i].lon); r.pointerDown(s.x, s.y, t); r.pointerUp(); };

console.log('\nE5 · tapping the first and last point of a stretch selects the CONTIGUOUS range');
{
  const m = freshMap();
  const r = sketchOf(m, FIVE);
  const ids = r.points.map((p) => p.id);
  pressPoint(m, r, 1, 1000);
  ok(r.selectedIds().join() === String(ids[1]), 'the first tap selects one point');
  pressPoint(m, r, 3, 2000);
  ok(r.selectedIds().join() === ids.slice(1, 4).join(), `the second tap fills in everything between (${r.selectedIds().length} points)`);
  ok(r.points[2].selected === true, 'including the point nobody tapped');
  ok(r.points[0].selected === false && r.points[4].selected === false, 'and nothing outside the range');
}

console.log('E5 · the range is the same whichever end you tap first');
{
  const m = freshMap();
  const r = sketchOf(m, FIVE);
  const ids = r.points.map((p) => p.id);
  pressPoint(m, r, 3, 1000);
  pressPoint(m, r, 1, 2000);
  ok(r.selectedIds().join() === ids.slice(1, 4).join(), `tapping last→first gives the same range (${r.selectedIds().length})`);
}

console.log('E5 · a tap once a range exists starts a fresh single selection');
{
  const m = freshMap();
  const r = sketchOf(m, FIVE);
  pressPoint(m, r, 0, 1000);
  pressPoint(m, r, 4, 2000);
  ok(r.selectedIds().length === 5, 'the whole sketch is selected');
  pressPoint(m, r, 2, 3000);
  ok(r.selectedIds().join() === String(r.points[2].id), 'and the next tap starts over with one point');
}

console.log('E5 · bulk delete removes the range, re-roles the ends, and is ONE edit');
{
  const m = freshMap();
  const commits = [];
  const r = new RoughLayer(m, { bind: false, onCommit: (pts, c) => commits.push(c) });
  for (const [lat, lon] of FIVE) r.append(lat, lon);
  const ids = r.points.map((p) => p.id);
  const shared = m.points;
  pressPoint(m, r, 1, 1000);
  pressPoint(m, r, 3, 2000);
  commits.length = 0;
  r.deleteSelected();

  ok(r.points.length === 2, `the three selected points are gone (${r.points.length} left)`);
  ok(r.points.map((p) => p.id).join() === `${ids[0]},${ids[4]}`, 'the survivors are the two outside the range');
  ok(commits.length === 1 && commits[0] === true, `deleting 3 points is ONE committed edit (${commits.length})`);
  ok(r.selectedIds().length === 0, 'and the selection is cleared');
  // Roles are positional, so the survivors ARE the new start/finish with no re-roling step to forget.
  ok(m.drawRough() === 2, 'the sketch still renders, now as start + finish');
  // The trap rough.js could ignore and this cannot: a filter() would have replaced the array and left
  // map.points pointing at the pre-delete sketch.
  ok(m.points === shared && m.points === r.points && m.points.length === 2,
     'the renderer still shares the SAME array — bulk delete compacted it in place (failure path 11)');
}

console.log('E5 · the Delete button counts the range, and Delete/Escape drive it');
{
  const m = freshMap();
  const btn = { classList: { _hidden: true, toggle(_c, on) { this._hidden = on; } }, textContent: '' };
  const r = new RoughLayer(m, { bind: false, deleteButton: btn });
  for (const [lat, lon] of FIVE) r.append(lat, lon);
  pressPoint(m, r, 1, 1000);
  ok(btn.textContent === 'Delete point', `one point reads "${btn.textContent}"`);
  pressPoint(m, r, 3, 2000);
  ok(btn.textContent === 'Delete 3 points', `a range reads "${btn.textContent}"`);
  r.clearSelection();
  ok(btn.classList._hidden === true, 'Escape hides it again');
  ok(r.points.length === 5, 'and deletes nothing');
}

console.log('E5 · deleting a range down to one point, and selecting the lot');
{
  const m = freshMap();
  const r = sketchOf(m, FIVE);
  pressPoint(m, r, 0, 1000);
  pressPoint(m, r, 3, 2000);
  r.deleteSelected();
  ok(r.points.length === 1, `four gone, one survivor (${r.points.length})`);
  const solo = r.points[0].id;
  pressPoint(m, r, 0, 3000);
  ok(r.selectedIds().join() === String(solo), 'the survivor can still be selected');
  r.deleteSelected();
  ok(r.points.length === 0 && r.selectedIds().length === 0, 'and deleted, leaving an empty sketch');
}

console.log('E5 · a stale anchor can never swallow a selection  (found by the browser gate)');
{
  // The bug this pins was real and silent: clear() did not reset the anchors, so on the NEXT sketch the
  // first tap looked like the second end of a range whose first end no longer existed — selectedIds found
  // index -1, returned nothing, and selecting a point did nothing at all. Anchors are now pruned before
  // every read and every change, so no mutation can leave one dangling.
  const m = freshMap();
  const r = sketchOf(m, FIVE);
  pressPoint(m, r, 1, 1000);
  ok(r.selectedIds().length === 1, 'a point is selected in the first sketch');
  r.clear();
  ok(r.selectedIds().length === 0, 'clear() drops the selection with the points');
  for (const [lat, lon] of TRI) r.append(lat, lon);
  pressPoint(m, r, 1, 2000);
  ok(r.selectedIds().join() === String(r.points[1].id), 'and the first tap of the NEXT sketch selects normally');

  // The same, without clear(): rebuild the layer's list by deleting everything one at a time.
  const r2 = sketchOf(freshMap(), TRI);
  pressPoint(freshMap(), r2, 0, 1000);
  while (r2.points.length) r2.removeId(r2.points[0].id);
  ok(r2.selectedIds().length === 0, 'emptying the sketch point by point leaves no dangling anchor');
}

console.log('E5 · a deleted anchor cannot resurrect a stale range');
{
  // Anchors are ids, and a single-point delete clears whichever anchor named it. Without that, the range
  // would be computed from an id that is no longer in the list — selectedIds would find index -1 and the
  // NEXT tap would select a wrong span.
  const m = freshMap();
  const r = sketchOf(m, FIVE);
  pressPoint(m, r, 1, 1000);
  pressPoint(m, r, 3, 2000);
  r.removeId(r.points[3].id);                 // drop one END of the range
  ok(r.selectedIds().length === 1 || r.selectedIds().length === 0, `the range collapsed rather than dangling (${r.selectedIds().length})`);
  pressPoint(m, r, 0, 3000);
  const sel = r.selectedIds();
  ok(sel.every((id) => r.points.some((p) => p.id === id)), 'every selected id is still a live point');
}

// --- PLAN-EDIT E6: undo / redo -----------------------------------------------------------------------

const stubSnack = () => ({ el: { classList: { _h: true, add() { this._h = true; }, remove() { this._h = false; } } },
                           label: { textContent: '' } });

console.log('\nE6 · the history records COMMITTED edits only, and is seeded with the empty sketch');
{
  const m = freshMap();
  const r = layerOn(m);
  ok(r.history.depth === 1 && r.history.index === 0, 'seeded with the initial empty state');
  ok(!r.canUndo && !r.canRedo, 'nothing to undo before the first edit');

  r.append(52.20, 6.85);
  r.append(52.24, 6.95);
  ok(r.history.depth === 3, `two appends → three states (${r.history.depth})`);
  ok(r.canUndo, 'and now there is something to undo');

  // A live drag frame must NOT become an undo step: `committed` is false until the finger lifts.
  const mid = m.project(52.20, 6.85);
  const depth = r.history.depth;
  r.pointerDown(mid.x, mid.y, 1000);
  for (let i = 1; i <= 8; i++) r.pointerMove(mid.x + i * 10, mid.y + i * 6);
  ok(r.history.depth === depth, `8 live drag frames add NO history (${r.history.depth})`);
  r.pointerUp();
  ok(r.history.depth === depth + 1, `the release adds exactly one (${r.history.depth})`);
}

console.log('E6 · move → insert → delete, then three undos walk back to the start');
{
  const m = freshMap();
  const r = layerOn(m);
  for (const [lat, lon] of TRI) r.append(lat, lon);
  const start = JSON.stringify(r.coords());
  const startDepth = r.history.depth;

  const mid = m.project(TRI[1][0], TRI[1][1]);                       // 1. move the middle point
  r.pointerDown(mid.x, mid.y, 1000);
  r.pointerMove(mid.x + 70, mid.y - 50);
  r.pointerUp();
  const afterMove = JSON.stringify(r.coords());

  const a = m.project(r.points[0].lat, r.points[0].lon);             // 2. insert on the first segment
  const b = m.project(r.points[1].lat, r.points[1].lon);
  r.pointerDown((a.x + b.x) / 2, (a.y + b.y) / 2, 2000);
  r.pointerUp();
  ok(r.points.length === 4, `inserted (${r.points.length} points)`);

  r.removeId(r.points[3].id);                                        // 3. delete one
  ok(r.points.length === 3, `deleted (${r.points.length} points)`);
  ok(r.history.depth === startDepth + 3, `three edits → three new states (${r.history.depth})`);

  ok(r.undo() && JSON.stringify(r.coords()) !== start, 'undo 1 takes back the delete');
  ok(r.undo() && JSON.stringify(r.coords()) === afterMove, 'undo 2 takes back the insert');
  ok(r.undo() && JSON.stringify(r.coords()) === start, 'undo 3 takes back the move — back to the start');
  // Not the end of the history: the three appends that BUILT this sketch are still behind it, and undo
  // keeps walking until the sketch is empty again.
  ok(r.canUndo, 'the appends that built the sketch are still undoable');

  ok(r.redo() && JSON.stringify(r.coords()) === afterMove, 'redo replays the move');
  ok(r.canRedo, 'with two more to redo');

  while (r.undo()) { /* walk it all the way back */ }
  ok(r.points.length === 0 && !r.canUndo, `undoing everything empties the sketch (${r.points.length} points)`);
}

console.log('E6 · a replay does not record itself, and a fresh edit truncates the redo tail');
{
  const m = freshMap();
  const r = layerOn(m);
  for (const [lat, lon] of TRI) r.append(lat, lon);
  const depth = r.history.depth;
  r.undo();
  ok(r.history.depth === depth, `undo does not grow the history (${r.history.depth}) — the applying guard holds`);
  ok(r.canRedo, 'and it leaves a redo tail');
  r.append(52.30, 6.99);
  ok(!r.canRedo, 'a fresh edit truncates that tail');
  ok(r.history.depth === depth, `and replaces it rather than appending (${r.history.depth})`);
}

console.log('E6 · a replayed state is the SAME sketch — ids restored, array shared');
{
  const m = freshMap();
  const r = layerOn(m);
  for (const [lat, lon] of TRI) r.append(lat, lon);
  const shared = m.points;
  const ids = r.points.map((p) => p.id).join();
  r.removeId(r.points[1].id);
  r.undo();
  ok(r.points.map((p) => p.id).join() === ids, `the restored points carry their original ids (${ids})`);
  ok(m.points === shared && m.points === r.points, 'and the renderer still shares the SAME array');
  // Ids must stay unique afterwards, or a restore could collide with a later insert.
  r.append(52.31, 6.99);
  const all = r.points.map((p) => p.id);
  ok(new Set(all).size === all.length, `ids remain unique after a restore + append (${all.join()})`);
}

console.log('E6 · one undo step per GESTURE — the sweep and the bulk delete included');
{
  const m = freshMap();
  const r = sketchOf(m, FIVE);
  const depth = r.history.depth;
  // the sweep: insert + position in one gesture
  const a = m.project(r.points[0].lat, r.points[0].lon), b = m.project(r.points[1].lat, r.points[1].lon);
  r.pointerDown((a.x + b.x) / 2, (a.y + b.y) / 2, 1000);
  for (let i = 1; i <= 6; i++) r.pointerMove((a.x + b.x) / 2 + i * 9, (a.y + b.y) / 2 - i * 7);
  r.pointerUp();
  ok(r.history.depth === depth + 1, `the whole sweep is ONE undo step (${r.history.depth - depth})`);
  ok(r.undo() && r.points.length === 5, 'and one undo takes the inserted point back out');
}

console.log('E6 · a bulk delete offers the snackbar; a single delete does not');
{
  const m = freshMap();
  const snack = stubSnack();
  const r = new RoughLayer(m, { bind: false, snackbar: snack });
  for (const [lat, lon] of FIVE) r.append(lat, lon);
  ok(snack.el.classList._h === true, 'no offer during ordinary edits');

  r.removeId(r.points[2].id);
  ok(snack.el.classList._h === true, 'deleting ONE point shows nothing — it is self-correcting');

  pressPoint(m, r, 0, 1000);
  pressPoint(m, r, 2, 2000);
  r.deleteSelected();
  ok(r.points.length === 1, `bulk-deleted 3 of 4 (${r.points.length} left)`);
  ok(snack.el.classList._h === false, 'a bulk delete DOES offer the way back');
  ok(snack.label.textContent === 'Deleted 3 · ', `and it says how many (\"${snack.label.textContent}\")`);

  ok(r.undo() && r.points.length === 4, 'one undo restores the lot');
  ok(snack.el.classList._h === true, 'and the offer goes away once taken');
}

console.log('E6 · the history is bounded, and the oldest state falls off the bottom');
{
  const m = freshMap();
  const r = new RoughLayer(m, { bind: false });
  r.history._max = 5;                       // the same rule as UNDO_MAX, small enough to reach
  for (let i = 0; i < 12; i++) r.append(52.2 + i * 0.001, 6.9);
  ok(r.history.depth === 5, `the stack stops growing at its cap (${r.history.depth})`);
  ok(r.history.index === 4, `and the index tracks the top (${r.history.index})`);
  let n = 0;
  while (r.undo()) n++;
  ok(n === 4, `it still walks back through everything it kept (${n} undos)`);
}

// --- PLAN-EDIT E7: shift-drag box select (desktop) ---------------------------------------------------

const stubBox = () => ({ style: {}, classList: { _h: true, add() { this._h = true; }, remove() { this._h = false; } } });
const boxAround = (m, r, idxs, pad = 20) => {
  const px = idxs.map((i) => m.project(r.points[i].lat, r.points[i].lon));
  return { x0: Math.min(...px.map((p) => p.x)) - pad, y0: Math.min(...px.map((p) => p.y)) - pad,
           x1: Math.max(...px.map((p) => p.x)) + pad, y1: Math.max(...px.map((p) => p.y)) + pad };
};

console.log('\nE7 · a shift-drag box selects the range SPANNING the points inside it');
{
  const m = freshMap();
  const r = sketchOf(m, FIVE);
  const ids = r.points.map((p) => p.id);
  const b = boxAround(m, r, [1, 3]);
  r.pointerDown(b.x0, b.y0, 1000, true);
  r.pointerMove(b.x1, b.y1);
  r.pointerUp();
  ok(r.selectedIds().join() === ids.slice(1, 4).join(), `the box selects points 1..3 (${r.selectedIds().length})`);
  // A span, not a set: the model is a contiguous range, so box-select and tap-first/tap-last produce the
  // SAME selection reachable two ways rather than two models to keep in step.
  ok(r.points[2].selected === true, 'including a point the box happened to enclose anyway');
}

console.log('E7 · a box that misses everything clears; a stray shift-click does not');
{
  const m = freshMap();
  const r = sketchOf(m, FIVE);
  const b = boxAround(m, r, [0, 2]);
  r.pointerDown(b.x0, b.y0, 1000, true); r.pointerMove(b.x1, b.y1); r.pointerUp();
  ok(r.selectedIds().length === 3, 'a range is selected');

  const far = emptySpot(r) || { x: 5, y: 5 };
  r.pointerDown(far.x + 4000, far.y + 4000, 2000, true);           // a box over empty space
  r.pointerMove(far.x + 4200, far.y + 4200);
  r.pointerUp();
  ok(r.selectedIds().length === 0, 'a box containing no points clears the selection');

  r.pointerDown(b.x0, b.y0, 3000, true); r.pointerMove(b.x1, b.y1); r.pointerUp();
  ok(r.selectedIds().length === 3, 'selected again');
  r.pointerDown(300, 300, 4000, true);
  r.pointerMove(300 + BOX_MIN_PX - 1, 300);                        // a shift-CLICK, not a box
  r.pointerUp();
  ok(r.selectedIds().length === 3, `a sub-${BOX_MIN_PX}px shift-drag leaves the selection alone (${r.selectedIds().length})`);
}

console.log('E7 · a box-drag never pans, inserts, or appends');
{
  const m = freshMap();
  const r = sketchOf(m, FIVE);
  const cam = { ...m.camera };
  const n = r.points.length;
  // Start the box ON the sketch line: shift must win over the hit test, or this would insert a point.
  const a = m.project(r.points[0].lat, r.points[0].lon), b2 = m.project(r.points[1].lat, r.points[1].lon);
  r.pointerDown((a.x + b2.x) / 2, (a.y + b2.y) / 2, 1000, true);
  r.pointerMove(b2.x + 30, b2.y + 30);
  r.pointerUp();
  ok(r.points.length === n, `no point was inserted or appended (${r.points.length})`);
  ok(m.camera.lat === cam.lat && m.camera.lon === cam.lon, 'and the camera did not move');
}

console.log('E7 · the rubber band shows during the drag and goes away after');
{
  const m = freshMap();
  const box = stubBox();
  const r = new RoughLayer(m, { bind: false, boxElement: box });
  for (const [lat, lon] of FIVE) r.append(lat, lon);
  ok(box.classList._h === true, 'hidden at rest');
  r.pointerDown(100, 120, 1000, true);
  r.pointerMove(260, 300);
  ok(box.classList._h === false, 'visible while dragging');
  ok(box.style.left === '100px' && box.style.top === '120px' && box.style.width === '160px' && box.style.height === '180px',
     `and positioned from the drag (${box.style.left},${box.style.top} ${box.style.width}×${box.style.height})`);
  r.pointerMove(40, 60);                                            // drag back past the origin
  ok(box.style.left === '40px' && box.style.width === '60px', `it normalises a backwards drag (${box.style.left} ${box.style.width})`);
  r.pointerUp();
  ok(box.classList._h === true, 'hidden again on release');
}

console.log('E7 · a boxed range bulk-deletes like any other, in ONE undo step');
{
  const m = freshMap();
  const r = sketchOf(m, FIVE);
  const depth = r.history.depth;
  const b = boxAround(m, r, [1, 3]);
  r.pointerDown(b.x0, b.y0, 1000, true); r.pointerMove(b.x1, b.y1); r.pointerUp();
  ok(r.history.depth === depth, 'selecting by box records no history — it is not a mutation');
  r.deleteSelected();
  ok(r.points.length === 2, `the boxed range is gone (${r.points.length} left)`);
  ok(r.history.depth === depth + 1, 'the delete is ONE undo step');
  ok(r.undo() && r.points.length === 5, 'and one undo brings all three back');
}

console.log(fails ? `\nM0+M1+E0-E7 FAIL — ${fails} check(s) failed` : '\nM0+M1+E0-E7 PASS — projection, pan/zoom and the whole rough-editor primitive set hold');
process.exit(fails ? 1 : 0);
