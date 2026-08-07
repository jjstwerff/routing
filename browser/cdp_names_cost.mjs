// Copyright (c) 2026 Jurjen Stellingwerff
// SPDX-License-Identifier: LGPL-3.0-or-later
//
// WHAT DOES THE FIRST SEARCH COST? — HANDOFF §1 item 3's number, measured instead of extrapolated.
//
// The claim on file is that `coverage.names.store` "does not scale past this rung": it is read WHOLE on
// the first `find`, because `NAMES` is one URL resolved at boot and `store_load_url_trusted` ADOPTS the
// whole store. Western Europe is extrapolated at ~500 MB. That extrapolation is doing a lot of work in a
// phase-E decision, and nobody had timed the thing it extrapolates FROM.
//
// So this measures, on a cold page:
//   * wall clock of the first `find` vs the second (the second reuses the loaded store — `names_at`)
//   * the bytes and requests the first one costs, attributed to the names store alone
//   * whether it arrives whole or by range — the difference between a ceiling and a non-issue
//
// ⚠ IT MUST BE THE FIRST `find` OF A FRESH PAGE. The kernel keeps the store in `names_at` and reloads
// only when the URL changes, so a second search in the same session measures a hash lookup and would
// report the ceiling as free.
//
//   node browser/cdp_names_cost.mjs <profile-dir> <page-url> [query]
import { launch } from './cdp_transport.mjs';

const [profile, pageUrl, query = 'lonneker'] = process.argv.slice(2);
if (!profile || !pageUrl) { console.log('usage: cdp_names_cost.mjs <profile-dir> <url> [query]'); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await launch({ bin: process.env.CHROMIUM_BIN || 'chromium', userDataDir: profile });
const call = browser.call;
const close = browser.close;
const ev = async (x) => (await call('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true })).result?.result?.value;

let fail = 0;
const bad = (m) => { console.log(`  FAIL: ${m}`); fail = 1; };

try {
  await call('Network.enable', {});
  // ⚠ LOCALHOST HIDES THE ONLY COST THAT DECIDES THIS. 63.5 MB over loopback is nearly free, so an
  // unthrottled run measures the DECODE and reports the transfer — the thing that scales with the
  // store — as zero. `prefetch_gate` already made this exact mistake in the other direction (it modelled
  // latency and not throughput, and no result it could produce would have argued against prefetching).
  // THROTTLE_KBPS models the real link; 10250 KB/s is the 82 Mbps this repo measures against.
  const kbps = Number(process.env.THROTTLE_KBPS || 0);
  if (kbps > 0) {
    await call('Network.emulateNetworkConditions', {
      offline: false, latency: Number(process.env.THROTTLE_MS || 45),
      downloadThroughput: kbps * 1024, uploadThroughput: kbps * 1024,
    });
  }
  // Attribute per request, because the app is fetching blocks and tiles at the same time and a session
  // total would charge the names store for the map (HANDOFF §2: "a number is not a measurement until you
  // know what it is ATTRIBUTED to").
  await call('Page.enable', {});
  await call('Page.navigate', { url: pageUrl });

  // Ready = the app has drawn, so the map's own fetching is out of the way before the search starts.
  let ready = false;
  for (let i = 0; i < 240; i++) {
    if (await ev('!!(window.__perfHooks && window.__perfHooks.settled && window.__perfHooks.settled() && window.__searchHooks)')) { ready = true; break; }
    await sleep(500);
  }
  if (!ready) { bad('the app never became ready'); throw new Error('not ready'); }
  await sleep(500);

  const stats = async () => JSON.parse(await ev('JSON.stringify(window.__perfHooks.kernelStats())') || '{}');
  const before = await stats();

  // ⚠ A SLOW SEARCH AND A FROZEN APP ARE DIFFERENT PRODUCTS. 50 s of spinner is bad; 50 s of dead UI is
  // broken. rAF only ticks while the main thread is free, so counting frames across the call separates
  // them without guessing.
  await ev('window.__rafN = 0; (function tick(){ window.__rafN++; requestAnimationFrame(tick); })();');
  const t0 = Date.now();
  const first = JSON.parse(await ev(`(async () => {
    await window.__searchHooks.run(${JSON.stringify(query)});
    return JSON.stringify(window.__searchHooks.results());
  })()`) || '[]');
  const firstMs = Date.now() - t0;
  const frames = await ev('window.__rafN');
  const mid = await stats();

  const t1 = Date.now();
  JSON.parse(await ev(`(async () => {
    await window.__searchHooks.run(${JSON.stringify(query)}x);
    return JSON.stringify(window.__searchHooks.results());
  })()`) || '[]');
  const secondMs = Date.now() - t1;
  const after = await stats();

  // ⚠ `wholeLoads` is a MAP keyed by store, not a counter — reading it as a number gives NaN, which is
  // how the first run of this probe reported the cost it exists to measure. Bytes are `rangeBytes`.
  const d = (a, b, k) => (b[k] ?? 0) - (a[k] ?? 0);
  const wl = (a, b) => {
    const out = [];
    for (const [k, v] of Object.entries(b.wholeLoads || {})) {
      const was = (a.wholeLoads || {})[k] || 0;
      if (v > was) out.push(`${k.split('/').pop()} x${v - was}`);
    }
    return out.length ? out.join(', ') : 'none';
  };
  console.log(`  query "${query}" -> ${first.length} hit(s)`);
  console.log(`  FIRST find : ${firstMs} ms   (the store is adopted here)`);
  console.log(`  during it  : ${frames} animation frames ran (${(frames / (firstMs / 1000)).toFixed(1)}/s) — 0 means the UI was FROZEN`);
  console.log(`  SECOND find: ${secondMs} ms   (names_at hit — no load)`);
  console.log(`  first  : whole-file loads [${wl(before, mid)}]  storeLoads +${d(before, mid, 'storeLoads')}  rangeReads +${d(before, mid, 'rangeReads')}  rangeBytes +${(d(before, mid, 'rangeBytes') / 1e6).toFixed(2)} MB`);
  console.log(`  second : whole-file loads [${wl(mid, after)}]  storeLoads +${d(mid, after, 'storeLoads')}  rangeReads +${d(mid, after, 'rangeReads')}  rangeBytes +${(d(mid, after, 'rangeBytes') / 1e6).toFixed(2)} MB`);
  if (!first.length) bad(`"${query}" returned nothing — the name store did not load`);
  const ratio = secondMs > 0 ? (firstMs / secondMs) : Infinity;
  console.log(`  the ceiling: the first search pays ${ratio === Infinity ? '∞' : ratio.toFixed(1)}x the second`);
} catch (e) {
  bad(String(e && e.message || e));
} finally {
  await close();
}
process.exit(fail);
