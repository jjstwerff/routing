// Copyright (c) 2026 Jurjen Stellingwerff
// SPDX-License-Identifier: LGPL-3.0-or-later
//
// WHAT DOES LAZY FAULTING COST A PHONE? — the half of the comparison the read counts cannot answer.
//
// Behind the page index, lazy faulting and `store_load_keys` fetch the SAME bytes over the wire: the
// index named 404 pages / 25.2 MB for one Amsterdam viewport, and 1 167 of 1 178 lazy faults were served
// out of that buffer without leaving the page. So the wire is a wash, and what is left is 65 MB copied
// out of the buffer against 26 MB — memory traffic, not network.
//
// ⚠ MEMORY TRAFFIC IS FREE ON THIS BOX AND IS NOT FREE ON THE TARGET. PLAN-PERF measures everything at
// `CPU_THROTTLE=4` because that is the mid-range phone the app is for, and a desktop flatters the app
// ~4x. A 2.5x copy amplification is exactly the kind of cost that hides on a laptop and decides the
// product on a phone — so this times both arms at 1x and at 4x, with the pages ALREADY PREFETCHED so
// the clock measures the copy rather than the fetch.
//
// Both arms alternate within one session (A B A B A B) so drift cancels, and medians are reported with
// their spread — a profile without its spread is not a measurement (PLAN-PERF §7e).
//
//   node browser/cdp_lazy_cost.mjs <profile-dir> <page-url> <store-url> <kind> <keys-file> <pages-file> [rates]
import { launch } from './cdp_transport.mjs';
import { readFileSync } from 'node:fs';

const [profile, pageUrl, storeUrl, kind, keysFile, pagesFile, rates = '1,4'] = process.argv.slice(2);
if (!profile || !pageUrl || !storeUrl || !kind || !keysFile || !pagesFile) {
  console.log('usage: cdp_lazy_cost.mjs <profile-dir> <page-url> <store-url> <kind> <keys-file> <pages-file> [rates]');
  process.exit(2);
}
const keys = readFileSync(keysFile, 'utf8').trim();
const pages = readFileSync(pagesFile, 'utf8').trim().split(',').map(Number);
const N = Number(process.env.LAZY_N || 3);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (call, x) => (await call('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true })).result?.result?.value;
const json = async (call, x) => { try { return JSON.parse(await ev(call, `JSON.stringify(${x})`) || 'null'); } catch { return null; } };
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

async function atRate(rate) {
  const browser = await launch({ bin: process.env.CHROMIUM_BIN || 'chromium', userDataDir: `${profile}-${rate}` });
  const { call } = browser;
  try {
    await call('Page.enable'); await call('Runtime.enable'); await call('Network.enable');
    await call('Network.setCacheDisabled', { cacheDisabled: true });
    await call('Storage.clearDataForOrigin', { origin: new URL(pageUrl).origin, storageTypes: 'local_storage' });
    await call('Page.navigate', { url: pageUrl });
    for (let i = 0; i < 900; i++) { await sleep(100); if (await ev(call, '!!(window.__kernelForLazy)')) break; }
    await sleep(1500);

    // Fill the buffer BEFORE throttling: the batch is network, and network is not what this measures.
    const fill = await json(call, `window.__perfHooks.prefetch(${JSON.stringify(storeUrl)}, ${JSON.stringify(pages)})`);
    // ⚠ Throttle AFTER the page is up and the buffer is full, or the boot pays for it and the timings
    // drift with how long the app took to start rather than with the work under test.
    if (rate > 1) await call('Emulation.setCPUThrottlingRate', { rate });
    await sleep(500);

    const cmd = (verb) => `\n${storeUrl}\n${verb}\n${keys}\n${kind}\npaged\n\nwhole`;
    const once = async (verb) => {
      const b = await json(call, 'window.__perfHooks.kernelStats()') || {};
      const t = Date.now();
      await ev(call, `window.__kernelForLazy.runKernel(${JSON.stringify(cmd(verb))})`);
      const ms = Date.now() - t;
      const a = await json(call, 'window.__perfHooks.kernelStats()') || {};
      return { ms, hits: (a.prefetchHits || 0) - (b.prefetchHits || 0),
               reads: (a.rangeReads || 0) - (b.rangeReads || 0),
               bytes: (a.rangeBytes || 0) - (b.rangeBytes || 0),
               wasm: a.wasmBytes || 0 };
    };
    const lazy = [], batched = [];
    for (let i = 0; i < N; i++) { batched.push(await once('keysprobe')); lazy.push(await once('lazyprobe')); }
    const heap = Number(await ev(call, '(performance.memory && performance.memory.usedJSHeapSize) || 0')) || 0;
    return { rate, fill, lazy, batched, heap };
  } finally { browser.close(); }
}

console.log(`\n=== WHAT LAZY FAULTING COSTS A PHONE — ${storeUrl.split('/').pop()} · ${keys.split(',').length} cells · ${kind}`);
console.log(`    pages prefetched first (${pages.length}), so the clock measures the COPY, not the fetch\n`);
const rows = [];
for (const r of rates.split(',').map(Number)) rows.push(await atRate(r));

for (const r of rows) {
  const lm = median(r.lazy.map((x) => x.ms)), bm = median(r.batched.map((x) => x.ms));
  const ls = `${Math.min(...r.lazy.map((x) => x.ms))}-${Math.max(...r.lazy.map((x) => x.ms))}`;
  const bs = `${Math.min(...r.batched.map((x) => x.ms))}-${Math.max(...r.batched.map((x) => x.ms))}`;
  console.log(`  CPU ${r.rate}x`);
  console.log(`    store_load_keys  ${String(bm).padStart(6)} ms  (${bs})   ${r.batched[0].reads} reads, ` +
              `${(r.batched[0].bytes / 1e6).toFixed(1)} MB, ${r.batched[0].hits} from the buffer`);
  console.log(`    lazy faulting    ${String(lm).padStart(6)} ms  (${ls})   ${r.lazy[0].reads} reads, ` +
              `${(r.lazy[0].bytes / 1e6).toFixed(1)} MB, ${r.lazy[0].hits} from the buffer`);
  console.log(`    ⇒ lazy is ${(lm / bm).toFixed(2)}x the wall time   ·   wasm ${(r.lazy.at(-1).wasm / 1e6).toFixed(0)} MB · JS heap ${(r.heap / 1e6).toFixed(0)} MB`);
}
// The number that decides it: does the amplification GROW when the machine slows? A cost that is flat in
// the throttle is a fetch; one that scales with it is CPU, and CPU is what a phone has least of.
if (rows.length > 1) {
  const ratio = (r) => median(r.lazy.map((x) => x.ms)) / median(r.batched.map((x) => x.ms));
  console.log(`\n  the amplification across the throttle: ` +
              rows.map((r) => `${r.rate}x → ${ratio(r).toFixed(2)}×`).join('   '));
}
console.log('');
