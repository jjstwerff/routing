// Copyright (c) 2026 Jurjen Stellingwerff
// SPDX-License-Identifier: LGPL-3.0-or-later
//
// PLAN-SCALE §6i — DOES THE APP OPEN ON THE COUNTRY, AND DOES THE HANDOVER HOLD?
//
// Three behaviours shipped with §6i and none of them had an assertion. This repo already knows what that
// costs: F5 exists because a blank map passed every gate that never asked whether anything was DRAWN.
//
//   1. a BARE url — no fragment, the camera a first visitor actually gets — draws the country from the
//      overview alone, in ONE request, with no detailed roads read;
//   2. the HANDOVER is exclusive in both directions: below it the overview answers and no detailed block
//      is touched; above it the detailed block answers and the overview is not;
//   3. the densified retry does NOT fire on an ordinary sketch (the property that keeps every working
//      match byte-identical) and DOES fire on one the matcher hands back.
//
//   node browser/cdp_overview.mjs <devtools host:port> <app url>
const [dt, app] = process.argv.slice(2);
const list = await (await fetch(`http://${dt}/json/list`)).json();
const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
let id = 0; const pending = new Map(); const byId = new Map();
let reqs = [];
const call = (m, p) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  else if (m.method === 'Network.requestWillBeSent') byId.set(m.params.requestId, m.params.request.url);
  else if (m.method === 'Network.responseReceived') reqs.push((byId.get(m.params.requestId) || '').split('/').pop());
});
await new Promise((r) => ws.addEventListener('open', r));
await call('Runtime.enable'); await call('Page.enable'); await call('Network.enable');
await call('Network.setCacheDisabled', { cacheDisabled: true });
const ev = async (x) => (await call('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true })).result?.result?.value;

let fails = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗'} ${m}`); if (!c) fails++; };

// A COLD load at `cam` ('' = bare, which is the point of check 1), settled.
async function load(cam) {
  await call('Page.navigate', { url: 'about:blank' });
  await new Promise((r) => setTimeout(r, 400));
  reqs = []; byId.clear();
  await call('Page.navigate', { url: app + cam });
  for (let i = 0; i < 240; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const s = await ev('window.__storeApp?JSON.stringify(window.__storeApp):""');
    if (s && JSON.parse(s).viewSeq) break;
  }
  const st = JSON.parse(await ev(`JSON.stringify({
    counts: window.__storeApp?.layerCounts || {}, view: window.__storeApp?.view || '',
    zoom: window.__map0?.camera.zoom })`) || '{}');
  st.drawn = ['areas', 'buildings', 'lines', 'pois', 'places', 'streetLabels']
    .reduce((n, k) => n + (st.counts[k] || 0), 0);
  st.stores = [...new Set(reqs.filter((u) => /\.store$/.test(u)))];
  st.roads = +(/R=(\d+)/.exec(st.view)?.[1] ?? -1);
  return st;
}

console.log('== §6i: the app opens on the country, and the handover is exclusive ==');

// 1 — a BARE url. Not a pinned camera: the thing a first visitor gets.
const bare = await load('');
ok(bare.drawn > 50000, `a bare visit draws the country: ${bare.drawn} features at z${bare.zoom?.toFixed?.(1)}`);
ok(bare.stores.length === 1 && /overview/.test(bare.stores[0]),
   `from ONE store, the overview: ${JSON.stringify(bare.stores)}`);
ok(bare.roads === 0, `and reads NO detailed roads (R=${bare.roads})`);

// 1b — the ladder is consulted by the path that actually DRAWS.
//
// ⚠ This check exists because its absence shipped a no-op. The ladder was extended in `areaMinZoom`, six
// unit tests passed, and the map was unchanged — because areas render from the STORE index through
// `_drawAreasFromStore`, which carried its own inline copy of the thresholds, and `areaMinZoom` only
// feeds the parity path. A rule is not in force until the drawing code asks it.
const drawn = JSON.parse(await ev(`JSON.stringify((() => {
  const m = window.__map0;
  return { at8: m._drawAreasFromStore(8), at16: m._drawAreasFromStore(16) };
})())`) || '{}');
ok(drawn.at16 > 0 && drawn.at8 * 4 < drawn.at16,
   `the DRAW path applies the ladder: ${drawn.at8} areas at z8 against ${drawn.at16} at z16`);

// 2 — the handover, both directions. Below it the overview alone; above it the detailed block alone.
// THREE bands now (§6i O3b): the overview below z12, the middle-zoom block at z12–13, the detailed
// regions from z14. Each must answer ALONE — a set mixing them is a `whole` block sharing a working set
// with a `paged` one, and at z12 the detailed blocks would name ~10 000 cell keys.
const mid = await load('#12/52.2215/6.8937');
ok(mid.drawn > 0 && mid.stores.every((u) => /nl-mid/.test(u)),
   `z12 reads the middle-zoom block alone: ${JSON.stringify(mid.stores)}`);
ok(mid.roads === 0, `and no detailed roads at z12 (R=${mid.roads})`);

const below = await load('#11/52.2215/6.8937');
ok(below.drawn > 0 && below.stores.every((u) => /overview/.test(u)),
   `below it (z11) only the overview is read: ${JSON.stringify(below.stores)}`);
ok(below.roads === 0, `and still no detailed roads (R=${below.roads})`);

const above = await load('#16/52.2215/6.8937');
ok(above.stores.length > 0 && !above.stores.some((u) => /overview/.test(u)),
   `above it (z16) the overview is NOT read: ${JSON.stringify(above.stores)}`);
ok(above.roads > 0, `and the detailed roads are (R=${above.roads})`);

// 2b — ZOOMING IN FROM THE COUNTRY MUST SWITCH TO THE DETAIL. Reported from the live site and the reason
// this check exists: booting on the country loads a box that CONTAINS every later viewport, so the
// "already loaded" test skipped the reload and z15 kept drawing country data — viewSeq stuck at 1, R=0,
// no buildings, while a direct load of the same camera drew 51 350. A box test cannot see a change of
// SOURCE, and crossing the handover is exactly that.
await load('');
const zoomed = JSON.parse(await ev(`(async () => {
  const before = window.__storeApp.viewSeq;
  const m = window.__map0;
  m.camera.zoom = 15; m.camera.lat = 52.2159; m.camera.lon = 6.8960; m._fireMove();
  for (let i = 0; i < 120; i++) { await new Promise((r) => setTimeout(r, 250));
    if (window.__storeApp.viewSeq > before && !window.__jobs?.busy) break; }
  return JSON.stringify({ before, after: window.__storeApp.viewSeq, view: window.__storeApp.view,
                          buildings: window.__storeApp.layerCounts?.buildings || 0 });
})()`) || '{}');
ok(zoomed.after > zoomed.before, `zooming in from the country re-views (seq ${zoomed.before} → ${zoomed.after})`);
ok(zoomed.buildings > 1000, `and the DETAILED layout arrives: ${zoomed.buildings} buildings, ${zoomed.view}`);

// 3 — the densified retry. The load-bearing half is that it stays OFF for a sketch that already matches.
const near = await ev(`(async () => {
  const r = window.__rough; r.points.length = 0;
  let s = 0;
  for (const p of [[52.2412, 6.8834], [52.2450, 6.8900], [52.2500, 6.8950]]) r.points.push({ id: ++s, lat: p[0], lon: p[1] });
  window.__storeApp = { ...(window.__storeApp || {}), densifyRetries: 0 };
  r.commitEdit(true);
  for (let i = 0; i < 240; i++) { await new Promise((x) => setTimeout(x, 250));
    if (window.__storeApp?.summary && !window.__jobs?.busy) break; }
  return JSON.stringify({ retries: window.__storeApp?.densifyRetries || 0, pts: window.__storeApp?.routePts });
})()`);
const n = JSON.parse(near || '{}');
ok(n.retries === 0, `an ordinary sketch matches with NO densified retry (${n.retries}, route ${n.pts} pts)`);
ok(n.pts > 3, `and it really routed (${n.pts} points)`);

// …and that the retry is WIRED to the right decision. The firing itself is not gateable against the
// small local block — an echo needs a corridor with ways but no path, and this block routes everything at
// the distances where Amsterdam echoes — so this asserts the app consults the app's own functions at the
// app's own spacing. `map.test.mjs` covers the functions; the firing was measured live (3 km → 134 pts).
const probe = JSON.parse(await ev(`JSON.stringify((() => {
  const pts = [[52.3626, 4.8735], [52.0907, 5.1214]];
  return { echoed: window.__perfHooks.densifyProbe(pts, pts.map((p) => p.slice())),
           routed: window.__perfHooks.densifyProbe(pts, [[52.3626, 4.8735], [52.2, 5.0], [52.0907, 5.1214]]) };
})())`) || '{}');
ok(probe.echoed?.echo === true && probe.echoed?.dense === 36,
   `the retry's decision: a returned trace IS an echo, and densifies 2 → ${probe.echoed?.dense} at ${probe.echoed?.step} m`);
ok(probe.routed?.echo === false, 'and a real route is not treated as one');

console.log(fails ? `FAIL — ${fails} check(s)` : 'PASS — the country view, the handover and the retry all hold');
process.exit(fails ? 1 : 0);
