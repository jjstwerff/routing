// Copyright (c) 2026 Jurjen Stellingwerff
// SPDX-License-Identifier: LGPL-3.0-or-later
//
// CAN YOU WALK THE ROUTE WITH THE RADIO OFF? — the only question that decides whether the pack works.
//
// Everything else about persistence is an optimisation that can be wrong quietly: a page that fails to
// persist costs a fetch, and nobody notices. This one cannot be wrong quietly, because the failure is a
// person on a hill looking at a blank screen. So the gate is the trip, not the counters:
//
//   1. save a pack for a route, with a stated width and set of zooms
//   2. **go offline** (`Network.emulateNetworkConditions offline`) — not "clear the cache", OFFLINE
//   3. reload, follow the route camera by camera, and require the map to DRAW at every step
//
// ⚠ A RELOAD IS PART OF IT. The in-memory buffer would answer every read without ever touching the
// persistent tier, so a test that packs and then pans in the same page proves only that the buffer works.
// The reload is what forces the bytes to come off the disk.
//
// ⚠ AND "IT DREW SOMETHING" IS NOT THE ASSERTION. A blank map is a map. Each step must draw a feature
// count comparable to what the SAME camera drew online — an offline map that quietly holds a tenth of the
// data is the failure this exists to catch.
//
//   node browser/cdp_offline_pack.mjs <profile-dir> <page-url> [half-width-m] [zooms]
import { launch } from './cdp_transport.mjs';

const [profile, pageUrl, halfWidth = '800', zoomList = '14'] = process.argv.slice(2);
if (!profile || !pageUrl) { console.log('usage: cdp_offline_pack.mjs <profile-dir> <url> [m] [zooms]'); process.exit(2); }
const zooms = zoomList.split(',').map(Number);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (call, x) => (await call('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true })).result?.result?.value;
const json = async (call, x) => { try { return JSON.parse(await ev(call, `JSON.stringify(${x})`) || 'null'); } catch { return null; } };
// ⚠ A PROMISE STRINGIFIES TO `{}`. `packPlan`/`savePack` are async, so `JSON.stringify(hook(...))`
// serialises the Promise and every field reads `undefined` — which is exactly what the first run of this
// gate reported, and it looked like an empty plan rather than a broken probe.
const jsonAwait = async (call, x) => { try { return JSON.parse(await ev(call, `(${x}).then(v => JSON.stringify(v))`) || 'null'); } catch { return null; } };

// ⚠ A WALK THROUGH LUXEMBOURG, NOT ENSCHEDE. The committed Enschede fixture is not in the coverage page
// index (`coverage.pagesx` is built from the generated blocks), so a pack there plans ZERO pages — which
// is what the first run of this gate reported, correctly. A pack can only cover ground the index covers,
// and that is a property worth knowing rather than working around: an unindexed block is readable online
// and cannot be taken offline.
const ROUTE = [[49.6116, 6.1319], [49.6150, 6.1400], [49.6190, 6.1480], [49.6230, 6.1560]];
const CAMS = ROUTE.map(([lat, lon]) => ({ lat, lon, zoom: zooms[zooms.length - 1] }));

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.error('  ✗ ' + m); } else console.log('  ✓ ' + m); };

// ⚠ THIS GATE IS THE SUITE'S LONGEST, so it reports where its own time goes rather than leaving the next
// person to guess. `build-site.mjs` costs 0 s and the ten rebuilds across the suite are free — the cost is
// here, in walking a route twice with a ring behind every camera.
const T0 = Date.now();
const lap = (what) => console.log(`    [${String(((Date.now() - T0) / 1000).toFixed(0)).padStart(3)}s] ${what}`);
const browser = await launch({ bin: process.env.CHROMIUM_BIN || 'chromium', userDataDir: profile });
const { call } = browser;
const ready = async () => { for (let i = 0; i < 900; i++) { await sleep(100); if (await ev(call, '!!(window.__storeApp&&window.__storeApp.ready)')) return true; } return false; };
const settle = async () => { for (let i = 0; i < 600; i++) { if (await ev(call, 'window.__perfHooks.settled()')) return true; await sleep(200); } return false; };

// Drive the camera along the route and report what each step drew.
async function walk(call, label) {
  const drew = [];
  for (const c of CAMS) {
    const before = Number(await ev(call, 'window.__storeApp?.viewSeq || 0'));
    await ev(call, `(() => { const m = window.__map0; m.camera.lat=${c.lat}; m.camera.lon=${c.lon}; m.camera.zoom=${c.zoom};
                             m._fireMove && m._fireMove(); m.render && m.render(); return 1; })()`);
    for (let i = 0; i < 300; i++) { await sleep(200); if (Number(await ev(call, 'window.__storeApp?.viewSeq || 0')) > before) break; }
    await settle();
    const counts = await json(call, 'window.__storeApp.layerCounts') || {};
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    drew.push(total);
    console.log(`    ${label}  ${c.lat.toFixed(4)},${c.lon.toFixed(4)}  drew ${total}`);
  }
  return drew;
}

try {
  await call('Page.enable'); await call('Runtime.enable'); await call('Network.enable');
  await call('Storage.clearDataForOrigin', { origin: new URL(pageUrl).origin, storageTypes: 'local_storage,cache_storage' });
  // ⚠ THE TIER IS PINNED, AND IT IS WHAT MAKES THIS GATE AFFORDABLE. Measured: 495 s, of which 244 s was
  // the online walk alone — a ring of eight neighbouring screens is paged behind every camera, twice
  // (once to record, once to replay). The ring is not what this gate claims: the claim is that a SAVED
  // ROUTE draws with no network, and the ring is ground beyond it. `minimal` turns it off on both sides,
  // so the pack and the trip still agree with each other, which is the property that matters.
  await call('Page.addScriptToEvaluateOnNewDocument', { source: "window.__deviceTier = 'minimal';" });
  await call('Page.navigate', { url: pageUrl });
  if (!await ready()) { console.error('  ✗ the app never became ready'); process.exit(1); }
  await settle();

  lap('app ready');
  console.log(`\n=== ONLINE: what the route looks like with a network`);
  const online = await walk(call, 'online ');
  lap('online walk done');

  console.log(`\n=== SAVING A PACK — ${halfWidth} m either side, zooms ${zooms.join(',')}`);
  const plan = await jsonAwait(call, `window.__perfHooks.packPlan(${JSON.stringify(ROUTE)}, ${JSON.stringify({ halfWidthM: +halfWidth, zooms })})`);
  console.log(`  plan: ${plan ? `${(plan.bytes / 1e6).toFixed(1)} MB · ${plan.pages} pages · ${plan.stores} store(s) · ${plan.boxes} corridor boxes` : '(none)'}`);
  ok(plan && plan.pages > 0, `the plan names pages before anything is fetched (${plan ? plan.pages : 0})`);
  const saved = await jsonAwait(call, `window.__perfHooks.savePack(${JSON.stringify(ROUTE)}, ${JSON.stringify({ halfWidthM: +halfWidth, zooms, id: 'gate-route' })})`);
  console.log(`  saved: ${saved ? `${saved.done} pages, ${saved.failed} failed` : '(failed)'}`);
  ok(saved && saved.done > 0 && saved.failed === 0, `the pack downloaded whole (${saved ? saved.done : 0} pages, ${saved ? saved.failed : '?'} failed)`);
  lap('pack saved');
  const cs = await json(call, 'window.__perfHooks.pageCacheStats()') || {};
  ok((cs.writes || 0) > 0, `and reached persistent storage (${cs.writes} writes, ${(cs.bytesIn / 1e6).toFixed(1)} MB)`);

  // ⚠ THE RELOAD. Without it the in-memory buffer answers everything and the disk is never consulted.
  console.log(`\n=== OFFLINE: radio off, page reloaded — the trip`);
  await call('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  await call('Page.navigate', { url: 'about:blank' });
  await sleep(300);
  await call('Page.navigate', { url: pageUrl });
  const bootedOffline = await ready();
  ok(bootedOffline, 'the app boots with no network at all');
  if (bootedOffline) {
    await settle();
    lap('offline boot');
    const offline = await walk(call, 'offline');
    lap('offline walk done');
    const cs2 = await json(call, 'window.__perfHooks.pageCacheStats()') || {};
    console.log(`  cache served ${cs2.hits} page(s), ${(cs2.bytesOut / 1e6).toFixed(1)} MB, ${cs2.misses} miss(es)`);
    ok(offline.every((n) => n > 0), `every step of the route drew something (${offline.join(', ')})`);
    // The real bar: comparable to online, not merely non-zero.
    const worst = Math.min(...offline.map((n, i) => (online[i] ? n / online[i] : 1)));
    ok(worst >= 0.9, `and drew what it draws online — worst step ${(worst * 100).toFixed(0)}% of the online count`);
    ok((cs2.hits || 0) > 0, 'the bytes came from the persistent cache');
  }
} finally { browser.close(); }

console.log(fails ? `\n  FAIL: ${fails} check(s)` : '\n  THE ROUTE IS WALKABLE OFFLINE');
process.exit(fails ? 1 : 0);
