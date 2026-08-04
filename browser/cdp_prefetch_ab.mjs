// Copyright (c) 2026 Jurjen Stellingwerff
// SPDX-License-Identifier: LGPL-3.0-or-later
//
// DOES PREFETCHING THE PAGES ACTUALLY MAKE THE MAP APPEAR SOONER? — the A/B that decides the design.
//
// `docs/prefetch-index-design.md` predicts 764 serial round trips collapse to one parallel batch, taking
// a cold viewport from ~16 s to ~5 s. That is a PREDICTION. This is the test.
//
//   A: load the viewport cold, as today.
//   B: hand the bridge the exact pages that viewport needs (captured by cdp_range_capture.mjs), all at
//      once, THEN load it. Same bytes, same server, same latency — only the round-trip depth differs.
//
// ⚠ SERVED LOCALLY WITH INJECTED LATENCY, and that is the point rather than a compromise. A local server
// has ~0 RTT, which is precisely the variable prefetching removes — an A/B without it would measure
// nothing. `LATENCY_MS` is set to the round trip measured against the live host (26 ms TTFB on a reused
// connection), so both arms pay the same realistic cost and the only difference is how many times.
//
//   node browser/cdp_prefetch_ab.mjs <profile-dir> <base-url> <capture.json> <store-name>
import { launch } from './cdp_transport.mjs';
import { readFileSync } from 'node:fs';

const [profile, base, capFile, storeName] = process.argv.slice(2);
if (!profile || !base || !capFile || !storeName) {
  console.log('usage: cdp_prefetch_ab.mjs <profile-dir> <base-url> <capture.json> <store-name>'); process.exit(2);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cap = JSON.parse(readFileSync(capFile, 'utf8'));
const CAM = /#(.*)$/.exec(cap.url)?.[1] || '14/52.3702/4.8952';

// The pages that viewport needs, deduplicated, in the order they were first asked for.
const seen = new Set(), ranges = [];
for (const r of cap.seq) {
  if (r.afterPaint) continue;
  if (!r.url.endsWith(storeName)) continue;
  if (r.len <= 1) continue;                         // the bytes=0-0 size probe is not a page
  const k = `${r.off}|${r.len}`;
  if (seen.has(k)) continue;
  seen.add(k); ranges.push([r.off, r.len]);
}
const storeUrl = new URL(`stores/${storeName}`, base).href;

async function run(withPrefetch) {
  const browser = await launch({
    bin: process.env.CHROMIUM_BIN || 'chromium', userDataDir: `${profile}-${withPrefetch ? 'B' : 'A'}`,
    maxLifetimeMs: 900_000,
  });
  const { call } = browser;
  await call('Network.enable'); await call('Page.enable'); await call('Runtime.enable');
  await call('Network.setCacheDisabled', { cacheDisabled: true });
  await call('Storage.clearDataForOrigin', { origin: new URL(base).origin, storageTypes: 'local_storage,cache_storage' });

  // Boot somewhere ELSE, so the store under test is not already resident when the timed step begins.
  await call('Page.navigate', { url: `${base}#8/52.1/5.3` });
  for (let i = 0; i < 900; i++) { await sleep(100); if (await ev(call, '!!(window.__storeApp&&window.__storeApp.viewSeq)')) break; }
  await sleep(2000);

  let fill = null;
  if (withPrefetch) {
    fill = JSON.parse(await ev(call, `window.__perfHooks.prefetch(${JSON.stringify(storeUrl)}, ${JSON.stringify(ranges)}).then(JSON.stringify)`) || '{}');
  }
  const before = Number(await ev(call, 'window.__storeApp?.viewSeq || 0'));
  const t = Date.now();
  const [z, lat, lon] = CAM.split('/');
  await ev(call, `(() => { const m = window.__map0; m.camera.zoom=${z}; m.camera.lat=${lat}; m.camera.lon=${lon}; m._fireMove && m._fireMove(); m.render && m.render(); return 1; })()`);
  let ms = null;
  for (let i = 0; i < 900; i++) {
    await sleep(100);
    if (Number(await ev(call, 'window.__storeApp?.viewSeq || 0')) > before) { ms = Date.now() - t; break; }
  }
  const st = JSON.parse(await ev(call, 'JSON.stringify(window.__perfHooks.kernelStats())') || '{}');
  browser.close();
  return { ms, fill, hits: st.prefetchHits || 0, miss: st.prefetchMiss || 0, held: st.prefetchHeld || 0, reads: st.rangeReads || 0 };
}
const ev = async (call, x) => (await call('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true })).result?.result?.value;

console.log(`\n=== PREFETCH A/B — ${storeName}`);
console.log(`    ${ranges.length} pages the viewport needs · camera #${CAM}`);
console.log(`    served locally with LATENCY_MS injected, so both arms pay a real round trip\n`);
const A = await run(false);
console.log(`  A  cold, as today      ${String(A.ms ?? '>90000').padStart(7)} ms   ${String(A.reads).padStart(5)} range reads`);
const B = await run(true);
console.log(`  B  pages prefetched    ${String(B.ms ?? '>90000').padStart(7)} ms   ${String(B.reads).padStart(5)} range reads`);
console.log(`       batch: ${B.fill?.ok}/${B.fill?.asked} pages in ${B.fill?.ms} ms · buffer hits ${B.hits} · misses ${B.miss} · left over ${B.held}`);
if (A.ms && B.ms) {
  console.log(`\n  ⇒ ${(A.ms / B.ms).toFixed(2)}× ${B.ms < A.ms ? 'FASTER' : 'SLOWER'} to the same view` +
              `   (${A.ms} ms → ${B.ms} ms, prefetch batch ${B.fill?.ms} ms of that)`);
  if (B.hits === 0) console.log('  ⚠ ZERO buffer hits — the kernel asked for ranges the capture did not contain, so this measured nothing.');
}
console.log('');
