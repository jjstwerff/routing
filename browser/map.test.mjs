// Copyright (c) 2026 Jurjen Stellingwerff  SPDX-License-Identifier: LGPL-3.0-or-later
//
// PLAN-MAP M0 check — the projection invariant, DOM-free (node). Run: node browser/map.test.mjs
//   1. the camera centre projects to the viewport centre
//   2. unproject∘project ≈ identity (< 1e-6°) and project∘unproject ≈ identity (< 1e-6 px)
//   3. a resize keeps the centre centred
//   4. orientation: east → +x, north → −y

import { makeView, projectWorld, unprojectWorld, panCenter, parseStretch, RouteMap } from './map.mjs';
import { RoughLayer, KernelQueue, isDoubleTap, PAN_SLOP_PX, DOUBLE_TAP_MS, DOUBLE_TAP_PX } from './rough.mjs';

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

  // Jitter below the slop is still a tap — a finger is never perfectly still.
  const before = m.camera.lat;
  r.pointerDown(500, 400, 9000);
  r.pointerMove(500 + PAN_SLOP_PX, 400);
  r.pointerUp();
  ok(r.points.length === 2, `${PAN_SLOP_PX}px of jitter is still a tap (${r.points.length} points)`);
  ok(m.camera.lat === before, 'and it did not pan the camera');
}

console.log('E0 · the double-tap dedupe collapses the 2nd click  (PLAN-EDIT §2 P2)');
{
  ok(isDoubleTap(null, 0, 0, 0) === false, 'the first tap of a session is never a double');
  ok(isDoubleTap({ t: 0, x: 100, y: 100 }, DOUBLE_TAP_MS - 1, 100, 100), 'same spot, just inside the window → double');
  ok(!isDoubleTap({ t: 0, x: 100, y: 100 }, DOUBLE_TAP_MS, 100, 100), `at exactly ${DOUBLE_TAP_MS}ms it is a fresh tap`);
  ok(!isDoubleTap({ t: 0, x: 100, y: 100 }, 50, 100 + DOUBLE_TAP_PX, 100), `${DOUBLE_TAP_PX}px away is a fresh tap, however fast`);

  const r = layerOn(freshMap());
  const tap = (x, y, t) => { r.pointerDown(x, y, t); r.pointerUp(); };
  tap(400, 300, 0);
  tap(401, 301, 60);                       // the 2nd click of a double-click
  ok(r.points.length === 1, `a double-click drops ONE point, not two (${r.points.length})`);
  tap(401, 301, 400);                      // a deliberate later tap at the same spot still lands
  ok(r.points.length === 2, `a tap after the window still appends (${r.points.length})`);
  tap(600, 300, 430);                      // fast, but far away — a different place, not a double
  ok(r.points.length === 3, `a fast tap ELSEWHERE appends (${r.points.length})`);
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

console.log(fails ? `\nM0+M1+E0 FAIL — ${fails} check(s) failed` : '\nM0+M1+E0 PASS — projection, pan/zoom and the edit chokepoints hold');
process.exit(fails ? 1 : 0);
