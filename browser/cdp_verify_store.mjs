// Copyright (c) 2026 Jurjen Stellingwerff  SPDX-License-Identifier: LGPL-3.0-or-later
//
// Headless-Chromium gate for the standalone store app (browser/index.html, PLAN-BUILD): loads the site over
// HTTP (the app fetches its stores by URL, so same-origin http, not file://), proves `view <bbox>` renders
// the region on load, then drives a `match` and proves the route draws.
//   node browser/cdp_verify_store.mjs <dt-host:port> <http-url>
const [dt, app] = process.argv.slice(2);
setTimeout(() => { console.log('  FAIL: hard timeout'); process.exit(3); }, 90000);

const list = await (await fetch(`http://${dt}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map(); const errs = [];
const call = (m, p) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  else if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
});
await new Promise((r) => ws.addEventListener('open', r));
await call('Runtime.enable'); await call('Page.enable');
const ev = async (x) => (await call('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true })).result?.result?.value;

await call('Page.navigate', { url: app });
let ok = true;

// 1. view <bbox> renders the visible region on load.
let st = null;
for (let i = 0; i < 160; i++) { await new Promise((r) => setTimeout(r, 500)); const s = await ev('window.__storeApp?JSON.stringify(window.__storeApp):""'); if (s) { st = JSON.parse(s); if (st.viewOk || st.ready) break; } }
if (!st || !st.viewOk) { console.log('  FAIL: view <bbox> did not render —', JSON.stringify(st), errs.slice(-2)); ok = false; }
else console.log(`  ✓ view <bbox> rendered on load (${st.view})`);

// 1b. PLAN-PERF §0 step 12 — areas RENDER from the exposed store now, and loft's text emit is kept as
// the running parity check until step 13 deletes it. Assert on the app's own last view, so a divergence
// fails here on every gate run rather than only when someone remembers to run tools/deliver_probe.sh.
// PLAN-PERF §0 step 13 — every layout kind renders from the exposed store and `view` is roads-only, so
// there is no layout text left to diff per view. Assert here that the store path actually produced the
// layers (a silent fall-back to an empty map is the failure this catches); the store-vs-text EQUALITY is
// checked against the gate-only `viewtext` command in tools/deliver_probe.sh.
if (st && st.areaSource !== 'store') { console.log(`  FAIL: layers fell back to the text path (areaSource=${st.areaSource}) — the store handle was missing`); ok = false; }
else if (st && st.layerCounts) {
  const kinds = Object.keys(st.layerCounts);
  if (!kinds.length) { console.log('  FAIL: no layer kinds render from the store'); ok = false; }
  // Every kind but `places` is populous in this viewport; places is legitimately tiny (2), so only the
  // bulk kinds are required non-empty — a zero there means the store read silently produced nothing.
  for (const k of ['areas', 'buildings', 'lines', 'pois', 'streetLabels']) {
    if (!st.layerCounts[k]) { console.log(`  FAIL: ${k} rendered 0 features from the store`); ok = false; }
  }
  if (ok) console.log(`  ✓ all layers from the store: ${kinds.map((k) => `${k} ${st.layerCounts[k]}`).join(' · ')}`);
}
if (st && /[AB]=\d+/.test(st.view || '')) { console.log(`  FAIL: view still serialises the layout — ${st.view}`); ok = false; }
else if (st) console.log(`  ✓ view is roads-only (${st.view})`);

// 2. a match draws the matched route.
const sum = await ev('window.__match?window.__match([[52.2412299,6.8834496],[52.2694705,6.9164085],[52.3116272,6.9088554]]):""');
const s2 = JSON.parse((await ev('JSON.stringify(window.__storeApp||{})')) || '{}');
if (!s2.matchOk || !(s2.routePts > 2)) { console.log('  FAIL: match/route —', sum, JSON.stringify(s2)); ok = false; }
else console.log(`  ✓ match drew the route (${sum}, ${s2.routePts} pts)`);

// 2b. PLAN-PERF §6b(2) — and it drew it PROGRESSIVELY, on the app's own match path.
// `growSteps` counts the times the drawn route actually advanced mid-match. This asserts on the code the
// click handler runs (streamedMatch), not on a probe beside it: a regression that reverts the app to
// "draw once at #EOR" while leaving the driver able to stream would still fail here. A 3-point sketch is
// 2 stretches, so 2 advances is the whole route arriving in two visible steps.
if (!(s2.growSteps >= 2)) { console.log(`  FAIL: the route did not grow during the match (growSteps=${s2.growSteps})`); ok = false; }
else if (!(s2.streamedPts >= s2.routePts)) { console.log(`  FAIL: streamed ${s2.streamedPts} pts but the finished route has ${s2.routePts} — stretches lost, not stitched`); ok = false; }
else if (JSON.stringify(s2.streamedEnds) !== JSON.stringify(s2.routeEnds)) { console.log(`  FAIL: the growing line ended somewhere else than the route — ${JSON.stringify(s2.streamedEnds)} vs ${JSON.stringify(s2.routeEnds)}`); ok = false; }
else console.log(`  ✓ the line grew as it matched (${s2.growSteps} steps, ${s2.streamedPts} pts → ${s2.routePts} after spur removal, same endpoints)`);

// 3. PLAN-PERF §6b(2) — the route ARRIVES progressively, not in one burst at #EOR.
//
// A count, not a timing, so it holds on a loaded machine: `deliveries` is the number of yield points at
// which output actually reached JS. A buffered response delivers ONCE however many stretches it carries,
// so `deliveries >= stretches` is only reachable if each stretch crossed into JS during the match. 10
// points ⇒ 9 stretches — enough that a single-burst regression cannot pass by coincidence.
const sa = JSON.parse((await ev('(async () => (window.__perfHooks ? JSON.stringify(await window.__perfHooks.streamArrival(10)) : "null"))()')) || 'null');
if (!sa) { console.log('  FAIL: streamArrival hook missing'); ok = false; }
else if (!(sa.stretches >= 2)) { console.log(`  FAIL: the match emitted ${sa.stretches} stretches — nothing to stream`, JSON.stringify(sa)); ok = false; }
else if (sa.earlyStretches !== sa.stretches || sa.afterDone) { console.log(`  FAIL: stretches did not all arrive before the response resolved —`, JSON.stringify(sa)); ok = false; }
else if (sa.deliveries < sa.stretches) { console.log(`  FAIL: ${sa.stretches} stretches arrived in only ${sa.deliveries} batch(es) — buffered, not streamed`, JSON.stringify(sa)); ok = false; }
else if (!sa.contained) { console.log(`  FAIL: the finished ROUTE is not contained in the streamed stretches — the growing line drew a different path`, JSON.stringify(sa)); ok = false; }
else console.log(`  ✓ the route streams: ${sa.stretches} stretches in ${sa.deliveries} delivery batches, all before #EOR`);
if (sa && sa.contained) console.log(`  ✓ the streamed line CONTAINS the final route in order (${sa.streamedPts} pts streamed → ${sa.routePts} after spur removal)`);

// 4. PLAN-PERF §6c — a ring in the store IS an interleaved Int32Array, readable with ZERO copy.
//
// The whole "where does the loft/JS split live" question turns on this one fact, so it is asserted
// rather than assumed: loft-deliver stores struct vector elements INLINE at storeBase + vRec*8 + 8 with
// stride sizeOf(elem), so a vector<Coord> of two 4-byte ints is already the flat layout a renderer wants.
// If loft's record layout ever changes — Coord growing a field, a different stride, padding — the render
// path would silently read garbage coordinates, which is exactly the failure a count cannot see. The
// probe compares every coordinate of a real ring against loft's own reader.
const cl = JSON.parse((await ev('(async () => JSON.stringify(window.__perfHooks.coordLayout()))()')) || 'null');
if (!cl || cl.err) { console.log('  FAIL: coordLayout —', JSON.stringify(cl)); ok = false; }
else if (!cl.zeroCopyOk) { console.log(`  FAIL: a ring is NOT a zero-copy Int32Array —`, JSON.stringify(cl)); ok = false; }
else console.log(`  ✓ a ring is a zero-copy Int32Array view: Coord ${cl.layout.size}B (x@${cl.layout.fields[0].pos}, y@${cl.layout.fields[1].pos}), ${cl.ringLen} coords, 0 mismatches vs loft's reader`);

// 5. PLAN-PERF §6c — the store-backed render path draws EXACTLY what the object path draws.
//
// The additive-before-subtractive gate. Both paths are live, so this renders the same view twice — once
// with the store index off, once on — and compares a hash of the actual PIXELS. Counts cannot settle
// this: a ring read at a wrong offset still yields plausible integers and a plausible count, and only the
// pixels show it drew somewhere else. This assertion is what licenses deleting the object path.
const sp = JSON.parse((await ev('(async () => JSON.stringify(window.__perfHooks.storeRenderParity()))()')) || 'null');
if (!sp || sp.err) { console.log('  FAIL: storeRenderParity —', JSON.stringify(sp)); ok = false; }
else if (!sp.equal) { console.log(`  FAIL: the store path drew DIFFERENT pixels — objects ${sp.objects} vs store ${sp.store}`, JSON.stringify(sp.objectCounts), JSON.stringify(sp.storeCounts)); ok = false; }
else if (JSON.stringify(sp.objectCounts) !== JSON.stringify(sp.storeCounts)) { console.log('  FAIL: same pixels but different draw counts —', JSON.stringify(sp.objectCounts), JSON.stringify(sp.storeCounts)); ok = false; }
else if (!sp.streetsFlat || !sp.streetsFlat.n) { console.log('  FAIL: streets did not parse into the flat column —', JSON.stringify(sp.streetsFlat)); ok = false; }
else console.log(`  ✓ store-backed render is pixel-identical (${sp.store}) for ${sp.kinds.join(', ')} — ${JSON.stringify(sp.indexed)} indexed`);
if (ok && sp) console.log(`  ✓ streets render from a FLAT column too (${sp.streetsFlat.n} roads, ${sp.streetsFlat.verts} vertices, 0 boxed pairs)`);

// 6. PLAN-PERF §0 step 15 / §6d — the block raster cache. Currently OFF in the app; the gate drives it
// explicitly so it cannot rot while disabled.
const br = JSON.parse((await ev('(async () => JSON.stringify(window.__perfHooks.blockRaster()))()')) || 'null');
if (!br) { console.log('  FAIL: blockRaster hook missing'); ok = false; }
else if (br.roundTrip !== 0) { console.log(`  FAIL: an offscreen round-trip is not exact (${br.roundTrip} px) — the platform assumption broke`); ok = false; }
else if (br.coldVsWarm !== 0) { console.log(`  FAIL: a CACHED block frame differs from a freshly baked one (${br.coldVsWarm} px) — the cache is stale`); ok = false; }
else if (br.staleness !== 0) { console.log(`  FAIL: a data load did NOT invalidate the block cache (${br.staleness} px stale) — the map would show old tiles`); ok = false; }
else if (br.labelDiffs.places || br.labelDiffs.streets || br.labelDiffs.buildings) { console.log('  FAIL: a label pass differs under block rendering —', JSON.stringify(br.labelDiffs)); ok = false; }
else if (br.vsSnappedMaxDelta > 16) { console.log(`  FAIL: blocked vs snapped-direct differs STRUCTURALLY (maxDelta ${br.vsSnappedMaxDelta} > 16), not just by rasterisation rounding`); ok = false; }
else console.log(`  ✓ block cache ON: cached==baked, data-load invalidates, labels exact, vs snapped-direct ${br.pct}% of px at maxDelta ${br.vsSnappedMaxDelta} (canvas-size rounding) · pan ${br.warmMs}ms warm · settles in ${br.settleFrames} frames, worst ${br.worstFrameMs}ms, ${br.blocks} blocks`);

// 7. THE CLICK PATH — real mouse events, not window.__match.
//
// Every other match assertion here drives `window.__match(...)`, which skips the canvas listener
// entirely. So the interaction a USER performs — click to drop a rough point, from the 2nd on re-match —
// was never gated, and a regression in it would be invisible to this file while everything stayed green.
// It is also hard to see by eye: the rough points render as DOTS with no line between them, so "did my
// click land?" has no visual answer beyond a single 4-px marker.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mouse = (type, x, y, extra = {}) =>
  call('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0, ...extra });
const click = async (x, y, settle = 250) => { await mouse('mousePressed', x, y); await mouse('mouseReleased', x, y); await sleep(settle); };
const drag = async (x0, y0, x1, y1) => {
  await mouse('mousePressed', x0, y0);
  for (let i = 1; i <= 6; i++) { await mouse('mouseMoved', x0 + ((x1 - x0) * i) / 6, y0 + ((y1 - y0) * i) / 6); await sleep(16); }
  await mouse('mouseReleased', x1, y1);
  await sleep(250);
};
// Assert on the LAYER's array, not on map.points: they are the same array by reference, and the layer is
// what owns it (PLAN-EDIT failure path 11).
const nPts = () => ev('window.__rough.points.length');
// Reset the CAMERA as well as the sketch. The P1 assertion below deliberately pans, so without this each
// gesture test would run wherever its predecessors left the map — and a route's length depends on where
// you drew it. That coupling already bit once: E4's assertion failed not because the delete was broken
// but because the clicks had drifted somewhere with a genuinely 2-point route.
const HOME = { lat: 52.2215, lon: 6.8937, zoom: 16 };
const resetSketch = async () => {
  await ev(`window.__rough.clear();
    Object.assign(window.__map0.camera, ${JSON.stringify(HOME)});
    window.__map0.render();
    window.__storeApp.routePts = 0; window.__storeApp.matchRuns = 0;`);
  await sleep(400);
};

await resetSketch();
const seen = [];
for (const [x, y] of [[300, 200], [520, 330], [700, 180]]) {
  await click(x, y);
  const st3 = JSON.parse((await ev('(() => JSON.stringify({ pts: window.__rough.points.length, route: window.__storeApp.routePts || 0 }))()')) || '{}');
  seen.push(st3);
}
// A click must ALWAYS add a rough point; the route only appears from the 2nd click on.
const ptsOk = seen.length === 3 && seen[0].pts === 1 && seen[1].pts === 2 && seen[2].pts === 3;
if (!ptsOk) { console.log('  FAIL: clicks did not add rough points —', JSON.stringify(seen)); ok = false; }
else if (!(seen[2].route > 2)) { console.log('  FAIL: three clicks drew no route —', JSON.stringify(seen)); ok = false; }
else console.log(`  ✓ the click path works: 3 clicks → 3 rough points, route ${seen[2].route} pts`);

// 7a. PLAN-EDIT E1 — the sketch is VISIBLE: a dashed line between the points, not just isolated dots.
//
// Asserted by isolating the sketch's own pixels: capture a box on the segment BETWEEN two rough points,
// re-render with the points hidden, and capture again. If the two differ, something was drawn there — and
// the box is placed away from every point, so that something can only be the line. Comparing colours
// instead would be fragile: the route's #1a73e8 and the sketch's #2b6cff are near-neighbours, and a 0.9
// alpha over the map shifts both.
const lineSeen = JSON.parse(await ev(`(() => {
  const m = window.__map0, p = m.points, d = m.dpr, ctx = m.canvas.getContext('2d');
  if (p.length < 2) return JSON.stringify({ err: 'need 2 points' });
  const a = m.project(p[0].lat, p[0].lon), b = m.project(p[1].lat, p[1].lon);
  const sum = (box) => { let s = 0; for (let i = 0; i < box.length; i++) s = (s * 31 + box[i]) >>> 0; return s; };
  const grab = (t, half) => {
    const x = Math.round((a.x + (b.x - a.x) * t) * d), y = Math.round((a.y + (b.y - a.y) * t) * d);
    return ctx.getImageData(x - half, y - half, 2 * half + 1, 2 * half + 1).data;
  };
  const mids = [0.35, 0.5, 0.65];
  const withSketch = mids.map((t) => sum(grab(t, 8)));
  const saved = m.points;
  m.points = []; m.render();                                  // hide ONLY the sketch; route untouched
  const without = mids.map((t) => sum(grab(t, 8)));
  m.points = saved; m.render();                               // restore the shared array by reference
  const dist = Math.round(Math.hypot(b.x - a.x, b.y - a.y));
  return JSON.stringify({ changed: mids.filter((_, i) => withSketch[i] !== without[i]).length,
                          of: mids.length, segPx: dist, rough: m._stats.rough, shared: m.points === saved });
})()`));
if (lineSeen.err) { console.log(`  FAIL: could not sample the sketch line — ${lineSeen.err}`); ok = false; }
else if (lineSeen.rough !== 3) { console.log(`  FAIL: render() drew ${lineSeen.rough} rough points (want 3)`); ok = false; }
else if (lineSeen.changed === 0) { console.log(`  FAIL: nothing is drawn BETWEEN the rough points — the sketch is still isolated dots (segment ${lineSeen.segPx}px)`); ok = false; }
else if (!lineSeen.shared) { console.log('  FAIL: map.points is no longer the layer\'s array after a re-render'); ok = false; }
else console.log(`  ✓ the sketch draws a LINE: ${lineSeen.changed}/${lineSeen.of} mid-segment samples change when it is hidden (E1)`);

// 7b. PLAN-EDIT E0 / §2 P1 — a PAN DRAG must not append a point.
// map.mjs bound mousedown→pan and store-app.mjs bound click→append, and a browser fires `click` after a
// mouseup even if the pointer travelled 200 px: every pan silently dropped a rough point into the sketch.
// It hid for two months because a rough point is one unlabelled dot.
await resetSketch();
const camBefore = await ev('JSON.stringify(window.__map0.camera)');
await drag(300, 200, 520, 330);
const afterPan = await nPts();
const camAfter = await ev('JSON.stringify(window.__map0.camera)');
if (afterPan !== 0) { console.log(`  FAIL: a pan drag appended ${afterPan} rough point(s) — pan and append are not separated`); ok = false; }
else if (camBefore === camAfter) { console.log('  FAIL: the drag did not pan the camera either — input dispatch is broken, not just fixed'); ok = false; }
else console.log('  ✓ a pan drag appends 0 points and DOES pan the camera (P1)');

// 7c. PLAN-EDIT E0 / §2 P2 — a double-click must drop ONE point, not two.
// This is also the precondition for E4's double-click-to-delete: that gesture is unreachable while the
// first click of it appends a point.
await resetSketch();
await click(400, 300, 60);
await click(401, 301, 400);
const afterDbl = await nPts();
if (afterDbl !== 1) { console.log(`  FAIL: a double-click produced ${afterDbl} points (want 1) — the 250ms dedupe is not holding`); ok = false; }
else console.log('  ✓ a double-click drops exactly 1 point (P2)');

// 7c2. PLAN-EDIT E2 — press ON the line and drag: one gesture inserts a point AND positions it.
//
// Driven with real mouse events, because the whole gesture only exists in the browser: the press must
// resolve to a segment, the move must carry the new point, and the release must leave exactly one extra
// point between the right neighbours. The unit tier pins the geometry; this pins that the wiring is real.
await resetSketch();
await click(260, 180); await click(720, 460);
await sleep(2500);
const sweep = JSON.parse(await ev(`(() => {
  const m = window.__map0, r = window.__rough;
  const a = m.project(r.points[0].lat, r.points[0].lon), b = m.project(r.points[1].lat, r.points[1].lon);
  return JSON.stringify({ n: r.points.length, midx: Math.round((a.x + b.x) / 2), midy: Math.round((a.y + b.y) / 2) });
})()`));
await mouse('mousePressed', sweep.midx, sweep.midy);
for (let i = 1; i <= 6; i++) { await mouse('mouseMoved', sweep.midx + i * 12, sweep.midy - i * 9); await sleep(16); }
await mouse('mouseReleased', sweep.midx + 72, sweep.midy - 54);
await sleep(300);
const after = JSON.parse(await ev(`(() => {
  const m = window.__map0, r = window.__rough;
  const p = r.points, s = p.length === 3 ? m.project(p[1].lat, p[1].lon) : null;
  return JSON.stringify({ n: p.length, x: s ? Math.round(s.x) : -1, y: s ? Math.round(s.y) : -1,
                          ids: p.map((q) => q.id).join(','), rough: m._stats.rough }); })()`));
const wantX = sweep.midx + 72, wantY = sweep.midy - 54;
if (after.n !== 3) { console.log(`  FAIL: the sweep left ${after.n} points (want 3) — press-on-segment did not insert`); ok = false; }
else if (Math.abs(after.x - wantX) > 6 || Math.abs(after.y - wantY) > 6) {
  console.log(`  FAIL: the inserted point sits at (${after.x},${after.y}), not where the drag released (${wantX},${wantY})`); ok = false;
} else if (after.rough !== 3) { console.log(`  FAIL: the sketch rendered ${after.rough} points after the sweep`); ok = false; }
else console.log(`  ✓ press-on-line + drag inserts ONE point between its neighbours, at the release (ids ${after.ids}) (E2)`);

// 7c3. PLAN-EDIT E3 — drag a point: the route follows, and the drag does not queue a match per frame.
//
// Two things are asserted, and the second is the one with a number behind it: a warm match is ~545 ms
// throttled while a drag emits ~33 moves/s, so matching per move would owe ~36 s for a two-second drag.
// The coalescer must collapse them — AND the route that survives must be the one for where the point
// finally landed, which is checked by re-matching the settled sketch and requiring an identical route.
await resetSketch();
await click(300, 220); await click(560, 400); await click(760, 200);
await sleep(3000);
const grab = JSON.parse(await ev(`(() => { const m = window.__map0, p = window.__rough.points[1];
  const s = m.project(p.lat, p.lon);
  window.__storeApp.matchRuns = 0;
  return JSON.stringify({ x: Math.round(s.x), y: Math.round(s.y) }); })()`));
const MOVES = 20;
await mouse('mousePressed', grab.x, grab.y);
for (let i = 1; i <= MOVES; i++) { await mouse('mouseMoved', grab.x + i * 5, grab.y + i * 4); await sleep(16); }
await mouse('mouseReleased', grab.x + MOVES * 5, grab.y + MOVES * 4);
for (let i = 0; i < 60 && (await ev('window.__jobs.pendingCount')) > 0; i++) await sleep(500);
await sleep(2000);
const dragged = JSON.parse(await ev(`(() => { const m = window.__map0, r = window.__rough;
  const p = r.points[1], s = m.project(p.lat, p.lon);
  const h = m.route.reduce((a, c) => (((a * 31 + Math.round(c[0] * 1e6)) >>> 0) * 31 + Math.round(c[1] * 1e6)) >>> 0, 7);
  return JSON.stringify({ n: r.points.length, x: Math.round(s.x), y: Math.round(s.y),
                          runs: window.__storeApp.matchRuns, route: m.route.length, hash: h }); })()`));
// Re-match the settled sketch: if the drag's final position was dropped, the displayed route differs.
const reHash = await ev(`(async () => { await window.__match(window.__rough.coords());
  return window.__map0.route.reduce((a, c) => (((a * 31 + Math.round(c[0] * 1e6)) >>> 0) * 31 + Math.round(c[1] * 1e6)) >>> 0, 7); })()`);
const wx = grab.x + MOVES * 5, wy = grab.y + MOVES * 4;
if (dragged.n !== 3) { console.log(`  FAIL: the drag changed the point count to ${dragged.n}`); ok = false; }
else if (Math.abs(dragged.x - wx) > 6 || Math.abs(dragged.y - wy) > 6) {
  console.log(`  FAIL: the dragged point is at (${dragged.x},${dragged.y}), not where it was released (${wx},${wy})`); ok = false;
} else if (!(dragged.runs < MOVES)) {
  console.log(`  FAIL: ${MOVES} move events produced ${dragged.runs} matches — the drag is matching per frame, not coalescing`); ok = false;
} else if (dragged.hash !== reHash) {
  console.log(`  FAIL: the drawn route is STALE — re-matching the settled sketch gives a different route (${dragged.hash} vs ${reHash})`); ok = false;
} else console.log(`  ✓ drag: the point follows and the route is the settled sketch's, in ${dragged.runs} matches for ${MOVES} moves (E3)`);

// 7c4. PLAN-EDIT E4 — delete a point: double-click (mouse) and select + the Delete button (touch).
await resetSketch();
await click(300, 220); await click(560, 400); await click(760, 200);
await sleep(3000);
const midAt = JSON.parse(await ev(`(() => { const m = window.__map0, p = window.__rough.points[1];
  const s = m.project(p.lat, p.lon); return JSON.stringify({ x: Math.round(s.x), y: Math.round(s.y), id: p.id }); })()`));
await click(midAt.x, midAt.y, 120);
const sel = JSON.parse(await ev(`JSON.stringify({ selected: window.__rough.selected,
  btn: document.getElementById('rough-delete').classList.contains('hidden'), n: window.__rough.points.length })`));
await click(midAt.x, midAt.y, 120);          // the second click of a double-click, inside 250 ms
await sleep(2500);
const del = JSON.parse(await ev(`JSON.stringify({ n: window.__rough.points.length,
  gone: !window.__rough.points.some((p) => p.id === ${midAt.id}), route: window.__map0.route.length,
  hash: window.__map0.route.reduce((a, c) => (((a * 31 + Math.round(c[0] * 1e6)) >>> 0) * 31 + Math.round(c[1] * 1e6)) >>> 0, 7),
  btn: document.getElementById('rough-delete').classList.contains('hidden') })`));
// Same anti-staleness check as E3, and for the same reason: "the route is non-empty" would pass on a
// route left over from before the delete. Re-matching the settled sketch must reproduce it exactly.
const delRe = await ev(`(async () => { await window.__match(window.__rough.coords());
  return window.__map0.route.reduce((a, c) => (((a * 31 + Math.round(c[0] * 1e6)) >>> 0) * 31 + Math.round(c[1] * 1e6)) >>> 0, 7); })()`);
if (sel.selected !== midAt.id) { console.log(`  FAIL: a single click did not select the point (selected=${sel.selected})`); ok = false; }
else if (sel.btn !== false) { console.log('  FAIL: selecting a point did not reveal the Delete button'); ok = false; }
else if (sel.n !== 3) { console.log(`  FAIL: selecting changed the sketch (${sel.n} points)`); ok = false; }
else if (del.n !== 2 || !del.gone) { console.log(`  FAIL: the double-click left ${del.n} points, target gone=${del.gone}`); ok = false; }
else if (!(del.route >= 2)) { console.log(`  FAIL: the route did not re-match after the delete (${del.route} pts)`); ok = false; }
else if (del.hash !== delRe) { console.log(`  FAIL: the route after the delete is STALE — a re-match differs (${del.hash} vs ${delRe})`); ok = false; }
else if (del.btn !== true) { console.log('  FAIL: the Delete button stayed visible after the point went'); ok = false; }
else console.log(`  ✓ click selects (button shown), double-click deletes and re-matches to the settled sketch (${del.route} route pts) (E4)`);

// 7c5. PLAN-EDIT E4 / failure path 8 — deleting below 2 points must DEGRADE, not throw.
// The matcher needs two points; the app must say so and clear the route rather than leave a stale line
// on screen describing a sketch that no longer exists.
await ev('window.__rough.select(window.__rough.points[1].id);');
await ev("document.getElementById('rough-delete').click();");
await sleep(2000);
const one = JSON.parse(await ev(`JSON.stringify({ n: window.__rough.points.length, route: window.__map0.route.length,
  hud: document.getElementById('hud').textContent })`));
if (one.n !== 1) { console.log(`  FAIL: the Delete button left ${one.n} points (want 1)`); ok = false; }
else if (one.route !== 0) { console.log(`  FAIL: a 1-point sketch still shows a ${one.route}-pt route — it is stale`); ok = false; }
else if (!/add ≥2/.test(one.hud)) { console.log(`  FAIL: the HUD does not say a point is missing — "${one.hud}"`); ok = false; }
else console.log(`  ✓ the Delete button works and 1 point degrades cleanly: "${one.hud}" (E4)`);

// 7d. PLAN-EDIT E0 / §2 P4 — an edit arriving DURING a match must not be dropped.
// `if (sketch.length < 2 || busy) return` added the point and skipped the re-match, and `busy` was shared
// with the view loader, so the drawn route silently described an older sketch: measured 1417 m from the
// last rough point. The queue coalesces instead — latest wins, nothing is dropped.
await resetSketch();
await click(300, 200); await click(520, 330);
await sleep(2500);
await click(700, 180, 120);        // these two land inside the previous match
await click(760, 420, 120);
for (let i = 0; i < 40 && (await ev('window.__jobs.pendingCount')) > 0; i++) await sleep(500);
await sleep(1500);
const fresh = JSON.parse(await ev(`(() => { const p = window.__rough.points, r = window.__map0.route;
  if (!p.length || !r.length) return JSON.stringify({ gapM: -1, pts: p.length, route: r.length, runs: window.__storeApp.matchRuns });
  const last = p[p.length - 1], end = r[r.length - 1];
  return JSON.stringify({ gapM: Math.round(Math.hypot((last.lat - end[0]) * 111000, (last.lon - end[1]) * 68000)),
                          pts: p.length, route: r.length, runs: window.__storeApp.matchRuns }); })()`));
if (fresh.pts !== 4) { console.log(`  FAIL: rapid clicks lost a point (${fresh.pts} of 4)`); ok = false; }
else if (!(fresh.gapM >= 0 && fresh.gapM < 200)) { console.log(`  FAIL: the route is STALE — it ends ${fresh.gapM} m from the last rough point (a click during a match was dropped)`); ok = false; }
// `runs` is reported, not asserted: whether the last two clicks coalesce depends on how fast the machine
// finishes the match between them, and a gate that asserted a coalesce count would fail on a fast box for
// being fast. What must ALWAYS hold is freshness — the route describes the sketch that exists now. The
// coalescing itself is pinned deterministically in map.test.mjs, where the timing is ours to choose.
else console.log(`  ✓ a click during a match still matches: route ends ${fresh.gapM} m from the last point (${fresh.runs} match runs for 3 requests) (P4)`);

console.log(ok ? 'PASS — store app renders + routes in-browser (no server)' : 'FAIL — store app gate');
process.exit(ok ? 0 : 1);
