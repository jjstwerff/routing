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

console.log(ok ? 'PASS — store app renders + routes in-browser (no server)' : 'FAIL — store app gate');
process.exit(ok ? 0 : 1);
