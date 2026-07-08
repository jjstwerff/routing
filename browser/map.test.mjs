// Copyright (c) 2026 Jurjen Stellingwerff  SPDX-License-Identifier: LGPL-3.0-or-later
//
// PLAN-MAP M0 check — the projection invariant, DOM-free (node). Run: node browser/map.test.mjs
//   1. the camera centre projects to the viewport centre
//   2. unproject∘project ≈ identity (< 1e-6°) and project∘unproject ≈ identity (< 1e-6 px)
//   3. a resize keeps the centre centred
//   4. orientation: east → +x, north → −y

import { makeView, projectWorld, unprojectWorld } from './map.mjs';

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

console.log(fails ? `\nM0 FAIL — ${fails} check(s) failed` : '\nM0 PASS — projection invariant holds');
process.exit(fails ? 1 : 0);
