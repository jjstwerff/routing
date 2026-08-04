// Copyright (c) 2026 Jurjen Stellingwerff
// SPDX-License-Identifier: LGPL-3.0-or-later
//
// REPLAY A CAMERA JOURNEY AND COST EVERY STEP — because a session is never a teleport.
//
// `cdp_latency.mjs` measures a cold deep link. That is the worst case and an unrepresentative one: real
// use is continuous, and the steps of a walk have wildly different costs that a single cold number hides.
// This replays `data/journeys.json` and reports each step on its own line, so the expensive kind of
// movement is named rather than averaged away.
//
// The three kinds it separates, and why each is its own thing:
//
//   * PAN INSIDE THE RING — should be ~free. `scheduleRing` pages 3x3 screens after each view precisely
//     so the next pan is a redraw.
//   * PAN PAST THE RING — new cells, same block.
//   * SCALE CHANGE — a DIFFERENT store, cold. z11->z13 leaves `overview` for `*-mid`; z13->z14 leaves
//     `*-mid` for a region block. Nothing prefetches across that boundary today, and "zoom out to get
//     your bearings, then back in" crosses it twice.
//
// The block that answered is READ FROM THE APP (`window.__coverage.block.id`), never inferred from the
// timing — so a scale change is reported as a fact, and a step whose `expect` was wrong says so.
//
//   node browser/cdp_journey.mjs <profile-dir> <base-url> <journey-id> [cpuThrottle]
import { launch } from './cdp_transport.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const [profile, base, id, rateArg] = process.argv.slice(2);
if (!profile || !base || !id) { console.log('usage: cdp_journey.mjs <profile-dir> <base-url> <journey-id> [rate]'); process.exit(2); }
const doc = JSON.parse(readFileSync(join(here, '..', 'data', 'journeys.json'), 'utf8'));
const journey = doc.journeys.find((j) => j.id === id);
if (!journey) { console.log(`no journey "${id}" — have: ${doc.journeys.map((j) => j.id).join(', ')}`); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await launch({
  bin: process.env.CHROMIUM_BIN || 'chromium', userDataDir: profile, maxLifetimeMs: 2_400_000,
});
const { call } = browser;
await call('Network.enable'); await call('Page.enable'); await call('Runtime.enable');
if (Number(rateArg || 1) > 1) await call('Emulation.setCPUThrottlingRate', { rate: Number(rateArg) });
await call('Network.setCacheDisabled', { cacheDisabled: true });
await call('Storage.clearDataForOrigin', { origin: new URL(base).origin, storageTypes: 'local_storage,cache_storage' });

let reqs = 0, bytes = 0;
const touched = new Set();
browser.onEvent((m) => {
  if (m.method === 'Network.requestWillBeSent') {
    const h = m.params.request.headers || {};
    if (h.Range || h.range) { reqs++; touched.add(m.params.request.url.split('/').pop().replace('.store', '')); }
  } else if (m.method === 'Network.loadingFinished') bytes += m.params.encodedDataLength || 0;
});
const ev = async (x) => (await call('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true })).result?.result?.value;

const first = journey.steps[0];
const t0 = Date.now();
await call('Page.navigate', { url: `${base}#${first.zoom}/${first.lat}/${first.lon}` });
let ok = false;
for (let i = 0; i < 1200; i++) { await sleep(100); if (await ev('!!(window.__storeApp&&window.__storeApp.viewOk)')) { ok = true; break; } }

console.log(`\n=== JOURNEY: ${journey.name}`);
console.log(`    ${journey.why}`);
console.log(`    ${base} · CPU throttle ${rateArg || 1}× · cold entry, then a walk\n`);
console.log(`  ${'#'.padStart(2)} ${'the user…'.padEnd(34)} ${'z'.padStart(2)} ${'ms'.padStart(7)} ${'reqs'.padStart(5)} ${'MB'.padStart(6)}  block`);

const rows = [];
let prevBlock = null;
const line = (n, why, z, ms, rq, mb, blk, note) =>
  console.log(`  ${String(n).padStart(2)} ${why.padEnd(34)} ${String(z).padStart(2)} ${String(ms).padStart(7)} ${String(rq).padStart(5)} ${mb.toFixed(1).padStart(6)}  ${blk}${note}`);

let blk = String(await ev('window.__coverage?.block?.id ?? "?"'));
prevBlock = blk;
line(1, first.why, first.zoom, ok ? Date.now() - t0 : '>120000', reqs, bytes / 1e6, blk, blk === first.expect ? '' : `  ⚠ expected ${first.expect}`);
rows.push({ ...first, ms: Date.now() - t0, reqs, mb: bytes / 1e6, blk, scale: false });

for (let i = 1; i < journey.steps.length; i++) {
  const s = journey.steps[i];
  await sleep(2500);                                  // let the previous view's ring finish
  reqs = 0; bytes = 0; touched.clear();
  const before = Number(await ev('window.__storeApp?.viewSeq || 0'));
  const t = Date.now();
  await ev(`(() => { const m = window.__map0; m.camera.lat=${s.lat}; m.camera.lon=${s.lon}; m.camera.zoom=${s.zoom}; m._fireMove && m._fireMove(); m.render && m.render(); return 1; })()`);
  let ms = null;
  for (let k = 0; k < 600; k++) {
    await sleep(100);
    if (Number(await ev('window.__storeApp?.viewSeq || 0')) > before) { ms = Date.now() - t; break; }
  }
  blk = String(await ev('window.__coverage?.block?.id ?? "?"'));
  const scale = blk !== prevBlock;
  const note = (blk === s.expect ? '' : `  ⚠ expected ${s.expect}`) + (scale ? '   ⇐ SCALE CHANGE' : '');
  line(i + 1, s.why, s.zoom, ms === null ? '>60000' : ms, reqs, bytes / 1e6, blk, note);
  rows.push({ ...s, ms: ms ?? 60000, reqs, mb: bytes / 1e6, blk, scale });
  prevBlock = blk;
}

const sc = rows.filter((r) => r.scale), pan = rows.filter((r) => !r.scale).slice(1);
const sum = (a, k) => a.reduce((x, r) => x + r[k], 0);
const avg = (a, k) => (a.length ? sum(a, k) / a.length : 0);
console.log(`\n  ${rows.length} steps · ${Math.round(sum(rows, 'ms') / 1000)}s total · ${sum(rows, 'reqs')} requests · ${sum(rows, 'mb').toFixed(1)} MB`);
console.log(`  scale changes   ${String(sc.length).padStart(2)}  ·  mean ${Math.round(avg(sc, 'ms'))}ms  ${Math.round(avg(sc, 'reqs'))} reqs  ${avg(sc, 'mb').toFixed(1)} MB`);
console.log(`  moves at scale  ${String(pan.length).padStart(2)}  ·  mean ${Math.round(avg(pan, 'ms'))}ms  ${Math.round(avg(pan, 'reqs'))} reqs  ${avg(pan, 'mb').toFixed(1)} MB`);
console.log(sc.length && avg(sc, 'ms') > 2 * avg(pan, 'ms')
  ? '\n  ⇒ THE SCALE CHANGE IS THE EXPENSIVE MOVE, and nothing prefetches across it today.\n'
  : '\n  ⇒ scale changes are not the dominant cost in this journey.\n');
browser.close();
