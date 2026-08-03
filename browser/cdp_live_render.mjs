// Copyright (c) 2026 Jurjen Stellingwerff
// SPDX-License-Identifier: LGPL-3.0-or-later
//
// PLAN-SCALE §6f F5 — does the DEPLOYED site actually DRAW a base map, at a given camera?
//
// Every gate before this one proved routing and search against the live site and never asked whether
// anything was rendered, which is exactly how a blank map shipped and stayed shipped. This asks the only
// question a visitor asks: at this URL, is there a map?
//
//   node browser/cdp_live_render.mjs <devtools host:port> <app url with #zoom/lat/lon>
//
// It reports what the app RESOLVED (which block, which base URLs, which read mode) alongside what it
// DREW, because the two failure modes look identical from the outside: a block that was never named, and
// a block that was named and fetched nothing.
const [dt, app] = process.argv.slice(2);
const list = await (await fetch(`http://${dt}/json/list`)).json();
const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
let id = 0; const pending = new Map(); const errs = []; const reqs = [];
const call = (m, p) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  else if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
  else if (m.method === 'Network.responseReceived') reqs.push({ url: m.params.response.url, status: m.params.response.status });
});
await new Promise((r) => ws.addEventListener('open', r));
await call('Runtime.enable'); await call('Page.enable'); await call('Network.enable');
// PLAN-EDIT E9 — the sketch autosave lives in localStorage, and every gate reuses its chromium
// --user-data-dir, so one run's sketch would restore into the next one's assertions. Cleared here, in
// EVERY driver, and map_render_gate checks the line is present: the app's camera comment predicted
// the "eighth one forgets" case exactly, so it is closed by a check rather than by discipline.
await call('Storage.clearDataForOrigin', { origin: new URL(app).origin, storageTypes: 'local_storage' });
// A visitor's first load is a COLD one. The app installs a service worker and caches stores in
// IndexedDB, so a warm profile can render the previous dataset perfectly and tell you nothing.
await call('Network.setCacheDisabled', { cacheDisabled: true });
const ev = async (x) => {
  const r = await call('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true });
  return r.result?.result?.value;
};
await call('Page.navigate', { url: app });
let st = null;
for (let i = 0; i < 160; i++) {
  await new Promise((r) => setTimeout(r, 500));
  const s = await ev('window.__storeApp?JSON.stringify(window.__storeApp):""');
  if (s) { st = JSON.parse(s); if (st.ready && st.viewSeq) break; }
}
const resolved = await ev(`JSON.stringify({
  version: window.__coverage?.index?.version || '?',
  block:   window.__coverage?.block?.id || '?',
  outside: !!window.__coverage?.outside,
  base:    (window.__coverage?.block?.base?.url) || null,
  readMode: window.__readMode, baseReadMode: window.__baseReadMode,
  cam: window.__map0 ? [window.__map0.camera.zoom, window.__map0.camera.lat, window.__map0.camera.lon] : null,
  counts: window.__storeApp?.layerCounts || {},
  view: window.__storeApp?.view || '',
  stats: window.__perfHooks?.kernelStats?.() || null,
})`);
const r = JSON.parse(resolved || '{}');
const c = r.counts || {};
const drawn = ['areas','buildings','lines','pois','places','streetLabels'].reduce((n,k)=>n+(c[k]||0),0);
console.log(`  index ${r.version} · camera z${r.cam?.[0]?.toFixed?.(2)} ${r.cam?.[1]?.toFixed?.(4)},${r.cam?.[2]?.toFixed?.(4)}`);
console.log(`  resolved block: ${r.block}${r.outside ? ' (OUTSIDE coverage)' : ''} · readMode ${r.readMode}/${r.baseReadMode}`);
console.log(`  block.base    : ${r.base || 'NULL'}`);
console.log(`  view line     : ${r.view || '(none)'}`);
console.log(`  layers drawn  : ${JSON.stringify(c)}  → ${drawn} features`);
if (r.stats) console.log(`  range reads   : ${r.stats.rangeReads} requests, ${(r.stats.rangeBytes/1048576).toFixed(1)} MB`);
const base = reqs.filter((q) => /routing-data-nl-|\.base\.store|layout\.store/.test(q.url));
console.log(`  base-store requests: ${base.length}${base.length ? ' — ' + [...new Set(base.map((q)=>q.url.split('/').slice(-1)[0] + ':' + q.status))].slice(0,4).join(', ') : ''}`);
if (errs.length) console.log(`  page errors: ${errs.slice(-2).join(' | ')}`);
console.log(drawn > 0 ? 'DREW a base map' : 'DREW NOTHING — blank background');
process.exit(drawn > 0 ? 0 : 1);
