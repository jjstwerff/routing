// Copyright (c) 2026 Jurjen Stellingwerff
// SPDX-License-Identifier: LGPL-3.0-or-later
//
// PLAN-BUILD B5–B7 — the standalone base-map + routing app. Fetches the two loft stores, runs the
// loft-wasm kernel for the visible viewport (`view <bbox>`) and the matched route (`match`), and renders
// on a 2D canvas. No server: JS does pixels (map.mjs), loft does the map/route (store-kernel.mjs).
import { RouteMap, parseView, areasFromStore, viewFromStore, viewRenderLists } from './map.mjs';
import { createKernel } from './store-kernel.mjs';
import { flatCount, flatElement, flatField, flatFields } from './loft-store.mjs';

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

// PLAN-PERF §0 step 13 — which layer kinds render from the EXPOSED STORE rather than from loft's text.
// Grown one kind per commit, each proved equal to the text path before the next is added; loft's emit
// stays until every kind is here, and only then can it be deleted (§7f: that deletion is also what
// collapses step 9's per-view expose bracket).
const STORE_KINDS = ['areas', 'buildings', 'lines', 'pois', 'places', 'streetLabels'];

// The viewport box in FIXED POINT (deg*1e7), built from the same 6-decimal strings the kernel parses so
// both sides round identically — `parse_fbox` reads exactly this text.
const fboxOf = (bbox) => {
  const p = bbox.split(',').map((s) => Math.round(parseFloat(s) * 1e7));
  return { mnla: p[0], mnlo: p[1], mxla: p[2], mxlo: p[3] };
};

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
    const lists = viewRenderLists(viewFromStore(kernel.memory(), h, fboxOf(bbox), { flatCount, flatField }, STORE_KINDS));
    for (const k of STORE_KINDS) { counts[k] = lists[k].length; map[k] = lists[k]; }
  }
  loadedBox = box;
  map.render();
  const sum = text.split('\n').find((l) => l.startsWith('# view')) || '(no view)';
  hud.textContent = `${sum.replace('# view: ', '')} · ${Math.round(performance.now() - t0)}ms — click to route`;
  // The app's OWN first view is the only genuinely cold one — it pays the session's store load. Every
  // __perfHooks.timedView after it is warm, so the profiler cannot see the load unless we record it here.
  const ms = performance.now() - t0;
  window.__storeApp = { ...(window.__storeApp || {}), viewOk: /R=\d+/.test(sum), view: sum,
                        firstViewMs: window.__storeApp?.firstViewMs ?? ms, lastViewMs: ms,
                        layerCounts: counts, areaSource: h ? 'store' : 'text' };
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
  kernelStats: () => (kernel.stats ? kernel.stats() : null),
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
    const box = viewportBox(0.6);
    const bbox = `${box.mnla.toFixed(6)},${box.mnlo.toFixed(6)},${box.mxla.toFixed(6)},${box.mxlo.toFixed(6)}`;
    // `viewtext` is the FULL text emit, kept in the kernel purely as this gate's reference — the app's
    // own `view` no longer serialises the layout at all. Asking for it explicitly is what keeps the
    // comparison possible after step 13 without charging every user-facing view for it.
    const text = await kernel.runKernel(`${LAYOUT}\n${ROADS}\nviewtext\n${bbox}`);
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
      const text = await kernel.runKernel(`${LAYOUT}\n${ROADS}\nmatch\n${spec}\n${PROFILE}`);
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
      return kernel.runKernel(`${LAYOUT}\n${ROADS}\nmatch\n52.2412299,6.8834496;52.2694705,6.9164085;52.3116272,6.9088554\n${PROFILE}`);
    }
    const b = viewportBox(0.6);
    return kernel.runKernel(`${LAYOUT}\n${ROADS}\nview\n${b.mnla.toFixed(6)},${b.mnlo.toFixed(6)},${b.mxla.toFixed(6)},${b.mxlo.toFixed(6)}`);
  },
  // C0 — is cost growing with session history? Run the SAME command N times and report wasm memory and
  // duration for each, so growth is attributed rather than averaged away.
  async repeat(kind, n) {
    const rows = [];
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      if (kind === 'match') {
        await kernel.runKernel(`${LAYOUT}\n${ROADS}\nmatch\n52.2412299,6.8834496;52.2694705,6.9164085;52.3116272,6.9088554\n${PROFILE}`);
      } else {
        const b = viewportBox(0.6);
        await kernel.runKernel(`${LAYOUT}\n${ROADS}\nview\n${b.mnla.toFixed(6)},${b.mnlo.toFixed(6)},${b.mxla.toFixed(6)},${b.mxlo.toFixed(6)}`);
      }
      rows.push({ i, ms: performance.now() - t0, wasmMB: +(kernel.stats().wasmBytes / 1048576).toFixed(1) });
    }
    return rows;
  },
  async timedView() {
    const box = viewportBox(0.6);
    const bbox = `${box.mnla.toFixed(6)},${box.mnlo.toFixed(6)},${box.mxla.toFixed(6)},${box.mxlo.toFixed(6)}`;
    const t0 = performance.now();
    const text = await kernel.runKernel(`${LAYOUT}\n${ROADS}\nview\n${bbox}`);
    const t1 = performance.now();
    map.loadView(text);
    const t2 = performance.now();
    // PLAN-PERF §0 step 13 — the layout layers come from the EXPOSED STORE, not from `text`. `ensureView`
    // does this on every view, so this probe must too: leaving it out would report a view the app never
    // performs, which is exactly the class of instrument bug §7e was written about. Timed as its own
    // phase so the bridge's cost stays attributable instead of hiding inside `render`.
    const h = kernel.exposedValue ? kernel.exposedValue(1) : null;
    if (h) {
      const lists = viewRenderLists(viewFromStore(kernel.memory(), h, fboxOf(bbox), { flatCount, flatField }, STORE_KINDS));
      for (const k of STORE_KINDS) map[k] = lists[k];
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
    const text = await kernel.runKernel(`${LAYOUT}\n${ROADS}\nview\n0.0,0.0,0.000001,0.000001`);
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
    const text = await kernel.runKernel(`${LAYOUT}\n${ROADS}\nmatch\n${spec}\n${PROFILE}`);
    const total = performance.now() - t0;
    stop = true; await new Promise((r) => setTimeout(r, 50));
    const stretches = text.split('\n').filter((l) => l.startsWith('STRETCH ')).length;
    return { n, total, stretches, frames: gaps.length, longestGap: Math.max(...gaps), expectedFrames: Math.round(total / 16.7) };
  },
  // Reset first: a cold match is the case that streams, and it is the one whose freeze this measures.
  async streamProgress() {
    await kernel.runKernel(`${LAYOUT}\n${ROADS}\nreset`);
    const gaps = []; let last = performance.now(), stop = false;
    const tick = () => { const t = performance.now(); gaps.push(t - last); last = t; if (!stop) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    const t0 = performance.now();
    const text = await kernel.runKernel(`${LAYOUT}\n${ROADS}\nmatch\n52.2412299,6.8834496;52.2694705,6.9164085;52.3116272,6.9088554\n${PROFILE}`);
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
};

// Shared body for the two match probes above.
async function timeMatch(pts) {
  const spec = pts.map(([a, b]) => `${a},${b}`).join(';');
  const t0 = performance.now();
  const text = await kernel.runKernel(`${LAYOUT}\n${ROADS}\nmatch\n${spec}\n${PROFILE}`);
  const t1 = performance.now();
  map.loadMatch(text);
  const t2 = performance.now();
  map.render();
  const t3 = performance.now();
  return { kernel: t1 - t0, parse: t2 - t1, render: t3 - t2, total: t3 - t0, bytes: text.length, pts: pts.length };
}

// Test hook: drive a match programmatically (headless gate), given [[lat,lon],…].
window.__match = async (pts) => {
  const spec = pts.map(([a, b]) => `${a},${b}`).join(';');
  const text = await kernel.runKernel(`${LAYOUT}\n${ROADS}\nmatch\n${spec}\n${PROFILE}`);
  const sum = map.loadMatch(text); map.render();
  window.__storeApp = { ...(window.__storeApp || {}), matchOk: /ways=\d+/.test(sum), summary: sum, routePts: map.route.length };
  return sum;
};
