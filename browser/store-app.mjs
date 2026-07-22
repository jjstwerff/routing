// Copyright (c) 2026 Jurjen Stellingwerff
// SPDX-License-Identifier: LGPL-3.0-or-later
//
// PLAN-BUILD B5–B7 — the standalone base-map + routing app. Fetches the two loft stores, runs the
// loft-wasm kernel for the visible viewport (`view <bbox>`) and the matched route (`match`), and renders
// on a 2D canvas. No server: JS does pixels (map.mjs), loft does the map/route (store-kernel.mjs).
import { RouteMap, parseView, parseStretch, areasFromStore, viewFromStore, viewRenderLists } from './map.mjs';
import { createKernel } from './store-kernel.mjs';
import { flatCount, flatElement, flatField, flatFields } from './loft-store.mjs';
import { buildIndex, storeLayout } from './store-geom.mjs';
import { RoughLayer, KernelQueue } from './rough.mjs';

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

let loadedBox = null, loadedBbox = null, lastViewText = null;
// PLAN-EDIT E0, chokepoint 3 — the one way to reach the kernel. `runKernel` keeps a single resolve slot,
// so commands must be serialized; this does that AND coalesces per key, which the old shared `busy`
// boolean could not. Previously `busy` was held by both the view loader and the matcher, so a view in
// flight made a click return without matching and the route silently went stale (PLAN-EDIT §2 P4).
const jobs = new KernelQueue();

// Load a viewport view only when the camera leaves the already-loaded area (a generous pad ⇒ small pans
// just re-draw the cached layers — no re-decode). Whole-region view would be ~230k lines and freeze.
//
// The `covers` test lives INSIDE the job, so it is judged when the view actually runs rather than when it
// was queued — a camera that moved back over the loaded box while another job ran skips the load entirely.
function ensureView() { return jobs.post('view', ensureViewNow); }
async function ensureViewNow() {
  if (covers(loadedBox, viewportBox(0.05))) { map.render(); return; }
  const box = viewportBox(0.6);
  const bbox = `${box.mnla.toFixed(6)},${box.mnlo.toFixed(6)},${box.mxla.toFixed(6)},${box.mxlo.toFixed(6)}`;
  hud.textContent = 'loading map…';
  const t0 = performance.now();
  const text = await kernel.runKernel(`${LAYOUT}\n${ROADS}\nview\n${bbox}`);
  map.loadRoadsFlat(text);
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
    for (const k of STORE_GEOM_KINDS) counts[k] = idx[k].n;
  }
  loadedBox = box; loadedBbox = bbox; lastViewText = text;
  map.render();
  const sum = text.split('\n').find((l) => l.startsWith('# view')) || '(no view)';
  hud.textContent = `${sum.replace('# view: ', '')} · ${Math.round(performance.now() - t0)}ms — click to route`;
  // The app's OWN first view is the only genuinely cold one — it pays the session's store load. Every
  // __perfHooks.timedView after it is warm, so the profiler cannot see the load unless we record it here.
  const ms = performance.now() - t0;
  window.__storeApp = { ...(window.__storeApp || {}), viewOk: /R=\d+/.test(sum), view: sum,
                        firstViewMs: window.__storeApp?.firstViewMs ?? ms, lastViewMs: ms,
                        layerCounts: counts, areaSource: h ? 'store' : 'text' };
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
async function streamedMatch(spec, isCurrent) {
  map.beginStretches();
  let growSteps = 0, lastLen = 0;
  const text = await kernel.runKernel(`${LAYOUT}\n${ROADS}\nmatch\n${spec}\n${PROFILE}`, (line) => {
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
const rough = new RoughLayer(map, {
  onCommit: (pts) => requestMatch(pts),
  deleteButton: document.getElementById('rough-delete'),   // bound BY the layer — see rough.mjs bind()
  snackbar: { el: document.getElementById('undo-snackbar'),
              label: document.getElementById('undo-snack-label'),
              button: document.getElementById('undo-snack-btn') },
  boxElement: document.getElementById('select-box'),
});

// Below two points there is no route to draw. Clearing it here rather than leaving the last one on screen
// is what makes a delete-down-to-one-point degrade instead of lying (PLAN-EDIT failure path 8).
function requestMatch(pts) {
  if (pts.length < 2) {
    map.setRoute([]); map.render();
    hud.textContent = `sketch ${pts.length} pt — add ≥2 to route`;
    window.__storeApp = { ...(window.__storeApp || {}), routePts: 0, summary: '' };
    return Promise.resolve();
  }
  hud.textContent = 'matching…';
  return jobs.post('match', async (isCurrent) => {
    const text = await streamedMatch(pts.map(([a, b]) => `${a},${b}`).join(';'), isCurrent);
    // A superseded match's route must not land: the user has already edited past it, and drawing it would
    // put a route on screen for a sketch that no longer exists. The newer job is already queued.
    if (!isCurrent()) return;
    const sum = map.loadMatch(text);
    map.render();
    hud.textContent = sum || '(no route)';
    window.__storeApp = { ...(window.__storeApp || {}), matchOk: /ways=\d+/.test(sum), summary: sum,
                          routePts: map.route.length, matchRuns: (window.__storeApp?.matchRuns || 0) + 1 };
  });
}

map.onMove(ensureView);   // re-view when the camera settles outside the loaded area
await ensureView();       // initial load
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
    map.loadRoadsFlat(text);
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
        M.drawRoute(); M.layoutLabels();
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
    M.loadRoadsFlat('');                                    // a real data change — must invalidate
    const staleness = this.renderDiff(() => { M.blocked = true; M.render(); },
                                      () => { M.blocked = true; M._blocks = new Map(); M._blockZoom = null; M.render(); }).diff;
    M.loadRoadsFlat(lastViewText || '');                    // restore the real roads
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
    const text = await kernel.runKernel(`${LAYOUT}\n${ROADS}\nmatch\n${spec}\n${PROFILE}`, (line) => {
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
                      : await kernel.runKernel(`${LAYOUT}\n${ROADS}\nmatch\n${spec}\n${PROFILE}`);
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
  const f = map.route;
  window.__storeApp = { ...(window.__storeApp || {}), matchOk: /ways=\d+/.test(sum), summary: sum, routePts: f.length,
                        routeEnds: f.length ? [f[0], f[f.length - 1]] : null,
                        matchRuns: (window.__storeApp?.matchRuns || 0) + 1 };
  return sum;
});
