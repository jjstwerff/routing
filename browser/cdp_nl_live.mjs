// Copyright (c) 2026 Jurjen Stellingwerff
// SPDX-License-Identifier: LGPL-3.0-or-later
//
// PLAN-SCALE N3's observable, driven: a visitor who lands OUTSIDE Enschede routes anyway, on a country
// block, with NO BASE MAP.
//
// Every other browser gate opens the app on Enschede, where a small committed block supplies both roads
// and a base map — the one place in the country where nothing about N3 is exercised. Here the camera
// opens in Amsterdam, which resolves to `nl-west`: a paged 222 MB block whose index entry has
// `base: null`, because the NL base map is 2.87 GB and does not fit the ~1 GB Pages cap.
//
// Four things, each a distinct way N3 could be broken while looking fine:
//   1. the app BOOTS with no base map (LAYOUT === '' rather than a crash reading `.base.url`);
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
if (c.id !== 'nl-west') fail(`resolved to ${c.id}, not the country block nl-west`);
if (c.hasBase) fail('nl-west reports a base map — the site index must not name the 2.87 GB one');
if (c.outside) fail('Amsterdam reported as OUTSIDE coverage');

const before = JSON.parse(await ev('JSON.stringify(window.__perfHooks.kernelStats())'));
const m = JSON.parse(await ev(`(async () => JSON.stringify(await window.__perfHooks.matchSpec(${JSON.stringify(SPEC)})))()`));
const after = JSON.parse(await ev('JSON.stringify(window.__perfHooks.kernelStats())'));

console.log(`  ${m.summary || '(no SUMMARY emitted)'}`);
if (m.blocks !== 1) fail(`the sketch named ${m.blocks} blocks; one country half covers it`);
const pts = /route_pts=(\d+)/.exec(m.summary || '');
if (!pts || +pts[1] < 5) fail(`no route in Amsterdam (summary="${m.summary}")`);
else console.log(`  ✓ routed on the country block with NO base map: ${pts[1]} route points`);

// …and paged. Measured over the WHOLE SESSION, not around the match.
//
// The delta across `matchSpec` was the first thing tried and it is the wrong window: the opening `view`
// already pages in the cells the camera sits on, so a match in the same place needs none of its own and
// the delta is legitimately zero. Reading that as "the block was fetched whole" accused the app of the
// exact opposite of what it did — 271 range reads for 78 MB of wasm against a 222.4 MB block.
//
// What matters is the session total: did this page ever read nl-west by range, and did it stay far below
// downloading the thing?
const reads = after.rangeReads ?? 0;
const mb = (after.rangeBytes ?? 0) / 1e6;
if (reads <= 0) fail(`no RANGE reads at all — the 222.4 MB block was fetched whole`);
else {
  console.log(`  \u2713 read BY RANGE: ${reads} reads, ${mb.toFixed(1)} MB of a 222.4 MB block (${(mb / 222.4 * 100).toFixed(1)}%)`);
  if (mb > 60) fail(`${mb.toFixed(0)} MB fetched — that is not a paged read of one camera and one corridor`);
}
// The match itself needing no NEW pages is the incremental path working, so it is reported, not judged.
const fresh = (after.rangeReads ?? 0) - (before.rangeReads ?? 0);
console.log(`  (the match itself asked for ${fresh} new page(s) — the view had already paged its cells in)`);

console.log(ok ? 'PASS — a visitor outside Enschede routes on the country block, paged, with no base map'
               : 'FAIL — NL live gate');
process.exit(ok ? 0 : 1);
