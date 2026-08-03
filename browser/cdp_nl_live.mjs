// Copyright (c) 2026 Jurjen Stellingwerff
// SPDX-License-Identifier: LGPL-3.0-or-later
//
// PLAN-SCALE N3's observable, driven: a visitor who lands OUTSIDE Enschede routes anyway, on a country
// block, with NO BASE MAP.
//
// Every other browser gate opens the app on Enschede, where a small committed block supplies both roads
// and a base map — the one place in the country where nothing about coverage is exercised. Here the
// camera opens in Amsterdam, which resolves to one of the four country regions: a paged roads block plus
// a base map served from its own Pages host (§6f F4).
//
// Four things, each a distinct way N3 could be broken while looking fine:
//   1. the app BOOTS on a region whose base map is on ANOTHER ORIGIN, and DRAWS it;
//   2. it resolves to the COUNTRY block, not the small one it happens to ship with;
//   3. it MATCHES there — the product claim, and what a 404 on the block would silently deny;
//   4. it reads that block BY RANGE — 222 MB down the wire is not a page load.
//
//   node browser/cdp_nl_live.mjs <host:port> <page-url>
const [target, pageUrl] = process.argv.slice(2);
if (!target || !pageUrl) { console.log('usage: cdp_nl_live.mjs <host:port> <url>'); process.exit(2); }

const listTargets = async () => (await (await fetch(`http://${target}/json/list`)).json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Amsterdam, in the app's own fragment form (zoom/lat/lon) — far from Enschede and WEST of the 5.40°E
// seam, so the block that must answer is nl-west and nothing else.
const CAM = '#14/52.3702/4.8952';
// A sketch a few streets long through central Amsterdam. Short on purpose: this gate is about which
// block answers and how it is read, not about route quality, which the corpus gates own.
const SPEC = '52.3702,4.8952;52.3660,4.9000;52.3625,4.9065';

let ws, id = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const msg = { id: ++id, method, params };
  pending.set(msg.id, { resolve, reject });
  ws.send(JSON.stringify(msg));
});
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval threw');
  return r.result?.value;
};

const t = (await listTargets()).find((x) => x.type === 'page');
ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
ws.addEventListener('message', (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pending.has(d.id)) { pending.get(d.id).resolve(d.result); pending.delete(d.id); }
});

await send('Page.enable');
// PLAN-EDIT E9 — the sketch autosave lives in localStorage, and every gate reuses its chromium
// --user-data-dir, so one run's sketch would restore into the next one's assertions. Cleared here, in
// EVERY driver, and map_render_gate checks the line is present: the app's camera comment predicted
// the "eighth one forgets" case exactly, so it is closed by a check rather than by discipline.
await send('Storage.clearDataForOrigin', { origin: new URL(pageUrl).origin, storageTypes: 'local_storage' });
await send('Runtime.enable');
await send('Page.navigate', { url: pageUrl + CAM });
for (let i = 0; i < 120; i++) { if (await ev('!!(window.__perfHooks && window.__perfHooks.matchSpec)')) break; await sleep(500); }
if (!(await ev('!!(window.__perfHooks && window.__perfHooks.matchSpec)'))) {
  // The most likely reason is exactly what this gate exists for: the app threw reading `.base.url` on a
  // block that has no base, so it never finished booting. Report what the page says rather than a bare
  // timeout, because the two failures need different fixes.
  const hud = await ev(`(document.querySelector('#hud')||{}).textContent || '(no hud)'`).catch(() => '(unreadable)');
  console.log(`  FAIL: the app never became ready in Amsterdam — hud: "${String(hud).slice(0, 160)}"`);
  process.exit(1);
}

let ok = true;
const fail = (m) => { console.log('  FAIL: ' + m); ok = false; };

const cov = await ev(`JSON.stringify({
  id: window.__coverage?.block?.id ?? null,
  hasBase: !!window.__coverage?.block?.base,
  outside: !!window.__coverage?.outside,
  readMode: window.__readMode ?? null })`);
const c = JSON.parse(cov);
console.log(`  camera Amsterdam → block=${c.id} base=${c.hasBase ? 'yes' : 'NONE'} read=${c.readMode}`);
// PLAN-SCALE §6f F5 — THIS ASSERTION IS THE INVERSE OF WHAT IT WAS, and the inversion is the point.
// It used to require `base: null`, because the country's base map was 2.87 GB on a release the browser
// cannot read. F4 put it on four Pages hosts it CAN read, so a region that reports no base map is now
// the failure — and this gate proving routing and search while never asking whether anything was DRAWN
// is exactly how a blank map shipped and stayed shipped.
if (!/^nl-/.test(c.id)) fail(`resolved to ${c.id}, not one of the country regions`);
if (!c.hasBase) fail(`${c.id} reports NO base map — the site index must name its Pages host (F4)`);
if (c.outside) fail('Amsterdam reported as OUTSIDE coverage');

const before = JSON.parse(await ev('JSON.stringify(window.__perfHooks.kernelStats())'));
const m = JSON.parse(await ev(`(async () => JSON.stringify(await window.__perfHooks.matchSpec(${JSON.stringify(SPEC)})))()`));
const after = JSON.parse(await ev('JSON.stringify(window.__perfHooks.kernelStats())'));

console.log(`  ${m.summary || '(no SUMMARY emitted)'}`);
if (m.blocks !== 1) fail(`the sketch named ${m.blocks} blocks; one country half covers it`);
const pts = /route_pts=(\d+)/.exec(m.summary || '');
if (!pts || +pts[1] < 5) fail(`no route in Amsterdam (summary="${m.summary}")`);
else console.log(`  ✓ routed on the country block: ${pts[1]} route points`);

// …and paged. Measured over the WHOLE SESSION, not around the match.
//
// The delta across `matchSpec` was the first thing tried and it is the wrong window: the opening `view`
// already pages in the cells the camera sits on, so a match in the same place needs none of its own and
// the delta is legitimately zero. Reading that as "the block was fetched whole" accused the app of the
// exact opposite of what it did — 271 range reads for 78 MB of wasm against a 222.4 MB block.
//
// What matters is the session total: did this page ever read nl-west by range, and did it stay far below
// downloading the thing?
// ⚠ ATTRIBUTED TO THE ROADS BLOCK, not the session. The base map now rides the app's own origin (the way
// production does — one host, different paths), so its pages land in the same session counter and a
// roads-block budget measured on the total fails on base-map bytes. The claim here is about the roads
// block, so it reads the roads block's own row.
const per = after.perStore || {};
const roadsKey = Object.keys(per).find((k) => k.endsWith('.roads.store'));
const reads = roadsKey ? per[roadsKey].reads : (after.rangeReads ?? 0);
const mb = (roadsKey ? per[roadsKey].bytes : (after.rangeBytes ?? 0)) / 1e6;
if (reads <= 0) fail(`no RANGE reads at all — the 222.4 MB block was fetched whole`);
else {
  console.log(`  \u2713 read BY RANGE: ${reads} reads, ${mb.toFixed(1)} MB of a 222.4 MB block (${(mb / 222.4 * 100).toFixed(1)}%) [${roadsKey || 'session total'}]`);
  if (mb > 60) fail(`${mb.toFixed(0)} MB fetched — that is not a paged read of one camera and one corridor`);
}
// The match itself needing no NEW pages is the incremental path working, so it is reported, not judged.
const fresh = (after.rangeReads ?? 0) - (before.rangeReads ?? 0);
console.log(`  (the match itself asked for ${fresh} new page(s) — the view had already paged its cells in)`);

// PLAN-RESTORE R4 — and it can FIND something there. A country you can route across but cannot search
// is half a product, and the name store is the only thing in the app that works without a base map AND
// without roads, so nothing else would notice if it stopped shipping.
const found = JSON.parse(await ev(`(async () => {
  await window.__searchHooks.run('lonneker');
  return JSON.stringify(window.__searchHooks.results());
})()`));
if (!found.length) fail('search returned nothing for "lonneker" — the name store did not load');
else {
  const top = found[0];
  console.log(`  \u2713 search "lonneker" \u2192 ${found.length} hits, best "${top.name}" (${top.kind === 1 ? 'place' : 'street'}) at ${top.lat.toFixed(4)},${top.lon.toFixed(4)}`);
  if (top.kind !== 1) fail(`the best hit for "lonneker" is a street, not the village`);
  if (Math.abs(top.lat - 52.2506) > 0.02 || Math.abs(top.lon - 6.9117) > 0.02) {
    fail(`"lonneker" resolved to ${top.lat},${top.lon}, not the village`);
  }
}
const none = JSON.parse(await ev(`(async () => {
  await window.__searchHooks.run('zzzznotathing');
  return JSON.stringify(window.__searchHooks.results());
})()`));
if (none.length) fail(`an unknown name returned ${none.length} hit(s) — it must return nothing`);
else console.log('  \u2713 an unknown name returns nothing, not a nearest guess');

// F5's own question, asked last because it is the one nobody asked: IS THERE A MAP?
const drawn = await ev(`JSON.stringify(window.__storeApp?.layerCounts || {})`);
const lc = JSON.parse(drawn || '{}');
const total = ['areas','buildings','lines','pois','places','streetLabels'].reduce((n,k)=>n+(lc[k]||0),0);
if (total > 0) console.log(`  ✓ the map is DRAWN: ${total} features (${JSON.stringify(lc)})`);
else fail('the base map drew NOTHING — a route on a blank background is what this rung exists to end');

console.log(ok ? 'PASS — a visitor outside Enschede routes, searches AND sees a map'
               : 'FAIL — NL live gate');
process.exit(ok ? 0 : 1);
