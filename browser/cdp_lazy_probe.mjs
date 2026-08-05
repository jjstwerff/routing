// Copyright (c) 2026 Jurjen Stellingwerff
// SPDX-License-Identifier: LGPL-3.0-or-later
//
// DOES A LOOKUP FETCH, IN THE BROWSER? — @PLN129 arc A against the app's own wasm kernel and bridge.
//
// Every read this app performs has to be TOLD what to fetch. `store_load_keys` takes the cell keys a
// command decided it needs, and that requirement is the root of the whole read architecture: the
// covering set, the page index, the prefetch batch, the ring, `PREFETCH_PAD`, and the `loadedBox`
// bookkeeping that decides when to read again. Its failure mode is the expensive one — a cell nobody
// predicted is not fetched late, it is silently ABSENT, which is what "roads went missing after a pan"
// looks like from the outside.
//
// `store_bind_lazy` inverts that: the collection starts empty and a MISS goes to the source. This asks
// whether that holds where the app actually lives, and it asks two things a native probe cannot:
//
//   1. does the fault travel through OUR bridge (`loft_host_http_range` in store-kernel.mjs)? If it
//      does, every mechanism already sitting on that chokepoint — the prefetch buffer, the range
//      counters, the retention cap — serves lazy faults for free, and the page index stops being a
//      correctness requirement and becomes purely a latency one.
//   2. is an unreachable source distinguishable from an absent key, here? That is the distinction the
//      app cannot currently make, and the reason a failed read leaves ground the view records as held.
//
// It drives the REAL kernel through the REAL bridge, and reads `kernelStats()` on both sides of the
// call so the range reads are attributed to this command rather than to the session.
//
//   node browser/cdp_lazy_probe.mjs <profile-dir> <page-url> <store-url> <key[,key…]>
import { launch } from './cdp_transport.mjs';

const [profile, pageUrl, storeUrl, keys] = process.argv.slice(2);
if (!profile || !pageUrl || !storeUrl || !keys) {
  console.log('usage: cdp_lazy_probe.mjs <profile-dir> <page-url> <store-url> <key[,key…]>');
  process.exit(2);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (call, x) => (await call('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true })).result?.result?.value;
const json = async (call, x) => { try { return JSON.parse(await ev(call, `JSON.stringify(${x})`) || 'null'); } catch { return null; } };

const browser = await launch({ bin: process.env.CHROMIUM_BIN || 'chromium', userDataDir: profile });
const { call } = browser;
let fails = 0;
const ok = (cond, msg) => { if (!cond) { fails++; console.error('  ✗ ' + msg); } else console.log('  ✓ ' + msg); };

try {
  await call('Page.enable'); await call('Runtime.enable'); await call('Network.enable');
  await call('Network.setCacheDisabled', { cacheDisabled: true });
  await call('Storage.clearDataForOrigin', { origin: new URL(pageUrl).origin, storageTypes: 'local_storage' });
  await call('Page.navigate', { url: pageUrl });
  for (let i = 0; i < 600; i++) { await sleep(100); if (await ev(call, '!!(window.__perfHooks && window.__perfHooks.kernelStats)')) break; }
  if (!await ev(call, '!!(window.__perfHooks && window.__perfHooks.kernelStats)')) {
    console.error('  ✗ the app never became ready'); process.exit(1);
  }
  await sleep(1500);

  // The probe command's own line protocol: no layout, the store as the roads URL, `paged` so nothing is
  // loaded eagerly — the whole point is that the collection starts EMPTY.
  const cmd = (url, k, verb = 'lazyprobe') => `\n${url}\n${verb}\n${k}\n\npaged\n\nwhole`;
  const runIt = async (url, k, verb) => {
    const before = await json(call, 'window.__perfHooks.kernelStats()') || {};
    const text = await ev(call, `window.__kernelForLazy.runKernel(${JSON.stringify(cmd(url, k, verb))})`);
    const after = await json(call, 'window.__perfHooks.kernelStats()') || {};
    return { line: String(text || '').split('\n').find((l) => /^(LAZY|KEYSLOAD)/.test(l)) || String(text || '').trim(),
             reads: (after.rangeReads || 0) - (before.rangeReads || 0),
             bytes: (after.rangeBytes || 0) - (before.rangeBytes || 0),
             failed: (after.rangeFailed || 0) - (before.rangeFailed || 0),
             hits: (after.prefetchHits || 0) - (before.prefetchHits || 0) };
  };

  console.log(`\n=== LAZY BIND IN THE BROWSER — ${storeUrl}`);
  const a = await runIt(storeUrl, keys);
  console.log(`  ${a.line}`);
  console.log(`  through OUR bridge: ${a.reads} range read(s), ${(a.bytes / 1024).toFixed(1)} kB, ${a.failed} failed`);
  const got = /got=(\d+)/.exec(a.line), miss = /miss=(\d+)/.exec(a.line);
  ok(/bound=true/.test(a.line), 'the collection bound to the block');
  ok(got && +got[1] > 0, `a lookup on an EMPTY collection returned a record (got=${got ? got[1] : '?'}, miss=${miss ? miss[1] : '?'})`);
  ok(a.reads > 0, `the fetch went through loft_host_http_range — ${a.reads} ranged read(s) attributed to this command`);
  ok(/faults=0/.test(a.line), 'no failed fetches');

  // ⚠ WHAT IT COSTS, AND WHETHER THE BUFFER PAYS IT. A fault is round trips per RECORD, and the app's
  // whole measured problem is round-trip DEPTH — so lazy binding is only affordable if the pages a fault
  // wants can already be in hand. The prefetch buffer sits on `loft_host_http_range`, which the first
  // section just proved a fault travels through, so this is the test of the combination: prefetch the
  // block's pages, then fault a FRESH collection over the same keys and see who answers.
  if (process.env.LAZY_MANY) {
    console.log(`\n=== ${process.env.LAZY_MANY.split(',').length} keys, cold`);
    const cold = await runIt(storeUrl, process.env.LAZY_MANY);
    console.log(`  ${cold.line}`);
    console.log(`  ${cold.reads} range read(s), ${(cold.bytes / 1024).toFixed(0)} kB, ${cold.hits} from the buffer`);

    // The baseline: the same keys through `store_load_keys`, the path the app uses today.
    console.log(`\n=== the SAME keys through store_load_keys (today's path)`);
    const base = await runIt(storeUrl, process.env.LAZY_MANY, 'keysprobe');
    console.log(`  ${base.line}`);
    console.log(`  ${base.reads} range read(s), ${(base.bytes / 1024).toFixed(0)} kB`);
    console.log(`  ⇒ lazy costs ${(cold.reads / Math.max(base.reads, 1)).toFixed(1)}× the reads and ` +
                `${(cold.bytes / Math.max(base.bytes, 1)).toFixed(1)}× the bytes of the batched path`);

    const pages = Number(process.env.LAZY_PAGES || 72);
    const fill = await json(call, `window.__perfHooks.prefetch(${JSON.stringify(storeUrl)}, ${JSON.stringify([...Array(pages).keys()])})`);
    console.log(`\n=== the same keys, with the block's pages prefetched first`);
    console.log(`  batch: ${fill?.pages} pages in ${fill?.requests} request(s), ${fill?.ms} ms`);
    const warm = await runIt(storeUrl, process.env.LAZY_MANY);
    console.log(`  ${warm.line}`);
    console.log(`  ${warm.reads} range read(s), ${(warm.bytes / 1024).toFixed(0)} kB, ${warm.hits} from the buffer`);
    ok(warm.hits > 0, `a lazy fault is served BY THE PREFETCH BUFFER — ${warm.hits} of ${warm.reads} reads never left the page`);
  }

  // The other half: an unreachable source must not read as an absent key.
  console.log('\n=== an unreachable source');
  const b = await runIt(`${new URL(storeUrl).origin}/does-not-exist.store`, keys);
  console.log(`  ${b.line}`);
  ok(/got=0/.test(b.line), 'nothing came back');
  ok(!/err=''/.test(b.line), 'and it SAYS why — an unreachable source is not an absent key');
} finally { browser.close(); }

console.log(fails ? `\n  FAIL: ${fails} check(s)` : '\n  LAZY BIND WORKS IN THE BROWSER, THROUGH THIS APP\'S OWN BRIDGE');
process.exit(fails ? 1 : 0);
