// Copyright (c) 2026 Jurjen Stellingwerff
// SPDX-License-Identifier: LGPL-3.0-or-later
//
// PLAN-BUILD B5–B7 — the standalone base-map + routing app. Fetches the two loft stores, runs the
// loft-wasm kernel for the visible viewport (`view <bbox>`) and the matched route (`match`), and renders
// on a 2D canvas. No server: JS does pixels (map.mjs), loft does the map/route (store-kernel.mjs).
import { RouteMap } from './map.mjs';
import { createKernel } from './store-kernel.mjs';

const LAYOUT = new URL('./stores/enschede.layout.store', location.href).href;
const ROADS  = new URL('./stores/enschede.roads.store', location.href).href;
const PROFILE = 'cycling_road';

const canvas = document.getElementById('map');
const hud = document.getElementById('hud');
const map = new RouteMap(canvas, { lat: 52.2215, lon: 6.8937, zoom: 16 });

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

let loadedBox = null, busy = false, again = false;
// Load a viewport view only when the camera leaves the already-loaded area (a generous pad ⇒ small pans
// just re-draw the cached layers — no re-decode). Whole-region view would be ~230k lines and freeze.
async function ensureView() {
  if (busy) { again = true; return; }
  if (covers(loadedBox, viewportBox(0.05))) { map.render(); return; }
  busy = true;
  const box = viewportBox(0.6);
  const bbox = `${box.mnla.toFixed(6)},${box.mnlo.toFixed(6)},${box.mxla.toFixed(6)},${box.mxlo.toFixed(6)}`;
  hud.textContent = 'loading map…';
  const t0 = performance.now();
  const text = await kernel.runKernel(`${LAYOUT}\n${ROADS}\nview\n${bbox}`);
  map.loadView(text);
  loadedBox = box;
  map.render();
  const sum = text.split('\n').find((l) => l.startsWith('# view')) || '(no view)';
  hud.textContent = `${sum.replace('# view: ', '')} · ${Math.round(performance.now() - t0)}ms — click to route`;
  window.__storeApp = { ...(window.__storeApp || {}), viewOk: /R=\d+/.test(sum), view: sum };
  busy = false;
  if (again) { again = false; ensureView(); }
}

// Rough sketch: each click adds a point; from the 2nd on, re-match and draw the route (read-only line).
const sketch = [];
canvas.addEventListener('click', async (e) => {
  const r = canvas.getBoundingClientRect();
  const g = map.unproject(e.clientX - r.left, e.clientY - r.top);
  sketch.push([g.lat, g.lon]);
  map.points = sketch.map(([lat, lon]) => ({ lat, lon }));
  map.render();
  if (sketch.length < 2 || busy) return;
  busy = true; hud.textContent = 'matching…';
  const spec = sketch.map(([a, b]) => `${a},${b}`).join(';');
  const text = await kernel.runKernel(`${LAYOUT}\n${ROADS}\nmatch\n${spec}\n${PROFILE}`);
  const sum = map.loadMatch(text);
  map.render();
  hud.textContent = sum || '(no route)';
  window.__storeApp = { ...(window.__storeApp || {}), matchOk: /ways=\d+/.test(sum), summary: sum, routePts: map.route.length };
  busy = false;
});

map.onMove(ensureView);   // re-view when the camera settles outside the loaded area
await ensureView();       // initial load
window.__storeApp = { ...(window.__storeApp || {}), ready: true };

// Test hook: drive a match programmatically (headless gate), given [[lat,lon],…].
window.__match = async (pts) => {
  const spec = pts.map(([a, b]) => `${a},${b}`).join(';');
  const text = await kernel.runKernel(`${LAYOUT}\n${ROADS}\nmatch\n${spec}\n${PROFILE}`);
  const sum = map.loadMatch(text); map.render();
  window.__storeApp = { ...(window.__storeApp || {}), matchOk: /ways=\d+/.test(sum), summary: sum, routePts: map.route.length };
  return sum;
};
