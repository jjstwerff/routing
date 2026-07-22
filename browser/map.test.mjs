// Copyright (c) 2026 Jurjen Stellingwerff  SPDX-License-Identifier: LGPL-3.0-or-later
//
// PLAN-MAP M0 check — the projection invariant, DOM-free (node). Run: node browser/map.test.mjs
//   1. the camera centre projects to the viewport centre
//   2. unproject∘project ≈ identity (< 1e-6°) and project∘unproject ≈ identity (< 1e-6 px)
//   3. a resize keeps the centre centred
//   4. orientation: east → +x, north → −y

import { makeView, projectWorld, unprojectWorld, panCenter, parseStretch, RouteMap } from './map.mjs';

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

console.log(fails ? `\nM0+M1 FAIL — ${fails} check(s) failed` : '\nM0+M1 PASS — projection + pan/zoom invariants hold');
process.exit(fails ? 1 : 0);
