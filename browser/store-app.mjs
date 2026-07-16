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

// Perf hook (headless profiler, browser/cdp_profile.mjs): run a view/match with each phase timed
// separately, so the bottleneck is ATTRIBUTED — wasm-side (store decode + text serialize) vs JS-side
// (text parse) vs render — instead of assumed. Test-only; the app itself never calls it.
window.__perfHooks = {
  async timedView() {
    const box = viewportBox(0.6);
    const bbox = `${box.mnla.toFixed(6)},${box.mnlo.toFixed(6)},${box.mxla.toFixed(6)},${box.mxlo.toFixed(6)}`;
    const t0 = performance.now();
    const text = await kernel.runKernel(`${LAYOUT}\n${ROADS}\nview\n${bbox}`);
    const t1 = performance.now();
    map.loadView(text);
    const t2 = performance.now();
    map.render();
    const t3 = performance.now();
    return { kernel: t1 - t0, parse: t2 - t1, render: t3 - t2, total: t3 - t0,
             bytes: text.length, lines: text.split('\n').length };
  },
  // Isolate the per-call store_load_url cost. TWO probes, because the two commands load DIFFERENT
  // stores: `view` loads layout+roads, `match` loads ONLY roads (the kernel skips layout for match).
  // A degenerate arg makes the command's own work ≈ 0, so what's left is the decode.
  async timedDecodeBoth() {   // empty bbox ⇒ view serialize ≈ 0 ⇒ kernel ≈ decode(layout + roads)
    const t0 = performance.now();
    const text = await kernel.runKernel(`${LAYOUT}\n${ROADS}\nview\n0.0,0.0,0.000001,0.000001`);
    return { kernel: performance.now() - t0, bytes: text.length };
  },
  async timedDecodeRoads() {  // 2 identical pts ⇒ match compute ≈ 0 ⇒ kernel ≈ decode(roads only)
    const t0 = performance.now();
    const text = await kernel.runKernel(`${LAYOUT}\n${ROADS}\nmatch\n0.0,0.0;0.0,0.0\n${PROFILE}`);
    return { kernel: performance.now() - t0, bytes: text.length };
  },
  // Is the MAIN THREAD blocked while the kernel runs? Lag is not slowness — it is a frozen frame.
  // Drive rAF across a kernel call: count the frames that actually landed and the longest gap between
  // them. A responsive app keeps ~16ms gaps; a blocked one shows one gap ≈ the whole call.
  async frameBlocking(kind) {
    const gaps = []; let last = performance.now(), stop = false;
    const tick = () => { const t = performance.now(); gaps.push(t - last); last = t; if (!stop) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    const t0 = performance.now();
    if (kind === 'match') {
      await kernel.runKernel(`${LAYOUT}\n${ROADS}\nmatch\n52.2412299,6.8834496;52.2694705,6.9164085;52.3116272,6.9088554\n${PROFILE}`);
    } else {
      const b = viewportBox(0.6);
      await kernel.runKernel(`${LAYOUT}\n${ROADS}\nview\n${b.mnla.toFixed(6)},${b.mnlo.toFixed(6)},${b.mxla.toFixed(6)},${b.mxlo.toFixed(6)}`);
    }
    const total = performance.now() - t0;
    stop = true;
    await new Promise((r) => setTimeout(r, 50));
    return { kind, total, frames: gaps.length, longestGap: Math.max(...gaps), expectedFrames: Math.round(total / 16.7) };
  },
  async timedMatch(pts) {
    const spec = pts.map(([a, b]) => `${a},${b}`).join(';');
    const t0 = performance.now();
    const text = await kernel.runKernel(`${LAYOUT}\n${ROADS}\nmatch\n${spec}\n${PROFILE}`);
    const t1 = performance.now();
    map.loadMatch(text);
    const t2 = performance.now();
    map.render();
    const t3 = performance.now();
    return { kernel: t1 - t0, parse: t2 - t1, render: t3 - t2, total: t3 - t0, bytes: text.length };
  },
};

// Test hook: drive a match programmatically (headless gate), given [[lat,lon],…].
window.__match = async (pts) => {
  const spec = pts.map(([a, b]) => `${a},${b}`).join(';');
  const text = await kernel.runKernel(`${LAYOUT}\n${ROADS}\nmatch\n${spec}\n${PROFILE}`);
  const sum = map.loadMatch(text); map.render();
  window.__storeApp = { ...(window.__storeApp || {}), matchOk: /ways=\d+/.test(sum), summary: sum, routePts: map.route.length };
  return sum;
};
