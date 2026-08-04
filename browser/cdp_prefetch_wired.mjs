// Copyright (c) 2026 Jurjen Stellingwerff
// SPDX-License-Identifier: LGPL-3.0-or-later
//
// THE WIRED PREFETCH — the app's own view, planned by the app's own index, measured against itself.
//
// `cdp_prefetch_ab.mjs` proved the MECHANISM by hand-feeding the bridge a capture of the exact pages a
// viewport turned out to need (4.79×). That answers "would prefetching help", not "does the app know
// what to prefetch": the capture was recorded from the same camera it was replayed on, so nothing about
// the INDEX was under test. Here nothing is pre-arranged — the app reads `coverage.pagesx`, picks the
// chunks its viewport covers, and prefetches what they name, exactly as a visitor's browser does.
//
// Two arms of the same camera in the same browser:
//
//   A  __perfHooks.setPrefetch(false)  — the index is never consulted; today's read path
//   B  setPrefetch(true)               — one batch first, then the kernel's reads hit the buffer
//
// ⚠ AND IT ASSERTS THE MAP, NOT ONLY THE CLOCK. A prefetch that named the wrong pages would still draw
// a correct map (a page number is a fetch hint — the bytes still come from the store), so a timing alone
// cannot tell a working index from a broken one that fell through to normal reads. The view summary and
// the per-layer feature counts must be IDENTICAL across the two arms, and the buffer must actually have
// answered: `prefetchHits` counts reads served without a round trip, and a hit rate under the floor means
// the index is naming pages the kernel does not ask for (design §5.3).
//
// ⚠ SERVE IT WITH LATENCY_MS SET. A local server has ~0 RTT, which is precisely the variable prefetching
// removes; without it arm B can only look slower, because it pays for a batch that saves nothing.
//
//   node browser/cdp_prefetch_wired.mjs <profile-dir> <base-url> [camera] [hit-floor-pct]
import { launch } from './cdp_transport.mjs';

// ⚠ THE LINK IS EMULATED, LATENCY *AND* THROUGHPUT — and leaving the second one out is what made this
// harness disagree with the live site. A localhost server has ~0 RTT and effectively infinite bandwidth;
// injecting only the round trip models the first half and leaves over-fetching FREE, so a prefetch that
// pulled 643 MB to serve 75 MB scored 2.9x here and lost live. Defaults are this box's measured link to
// GitHub Pages: 82 Mbps sustained, 45 ms for a 1-byte range (docs/prefetch-index-design.md §0).
const [profile, base, cam = '14/52.3702/4.8952', floorPct = '80', pad = '',
       mbps = '82', rtt = '45'] = process.argv.slice(2);
if (!profile || !base) {
  console.log('usage: cdp_prefetch_wired.mjs <profile-dir> <base-url> [camera] [hit-floor-pct]');
  process.exit(2);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (call, x) => (await call('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true })).result?.result?.value;
const json = async (call, x) => { try { return JSON.parse(await ev(call, `JSON.stringify(${x})`) || 'null'); } catch { return null; } };

// A view is only finished when the ring it scheduled has finished too: the ring keeps paging after the
// view reported its milliseconds, so a counter read before it settles describes a session still working
// (HANDOFF §2 — "the command returned" stopped meaning "nothing is in flight").
async function settle(call, timeoutMs = 120000) {
  const t = Date.now();
  while (Date.now() - t < timeoutMs) {
    if (await ev(call, 'window.__perfHooks && window.__perfHooks.settled()')) return true;
    await sleep(200);
  }
  return false;
}

async function arm(on) {
  const browser = await launch({
    bin: process.env.CHROMIUM_BIN || 'chromium', userDataDir: `${profile}-${on ? 'B' : 'A'}`,
    maxLifetimeMs: 900_000,
  });
  const { call } = browser;
  try {
    await call('Page.enable'); await call('Runtime.enable'); await call('Network.enable');
    await call('Network.setCacheDisabled', { cacheDisabled: true });
    if (Number(mbps) > 0) {
      const bps = (Number(mbps) * 1e6) / 8;
      await call('Network.emulateNetworkConditions',
                 { offline: false, latency: Number(rtt), downloadThroughput: bps, uploadThroughput: bps });
    }
    await call('Storage.clearDataForOrigin', { origin: new URL(base).origin, storageTypes: 'local_storage,cache_storage' });

    // Boot on a DIFFERENT camera, so the store under test is not already resident when the timed view
    // begins — and so the index's session read is paid in the boot, where a visitor pays it too.
    // The pad is read at module scope, so it has to be in place BEFORE the app's script runs.
    if (pad) await call('Page.addScriptToEvaluateOnNewDocument', { source: `window.__prefetchPad = ${Number(pad)};` });
    await call('Page.navigate', { url: `${base}#8/52.1/5.3` });
    for (let i = 0; i < 900; i++) { await sleep(100); if (await ev(call, '!!(window.__storeApp&&window.__storeApp.viewSeq)')) break; }
    if (!await settle(call)) return { error: 'the boot view never settled' };

    await ev(call, `window.__perfHooks.setPrefetch(${on ? 'true' : 'false'})`);
    const before = Number(await ev(call, 'window.__storeApp?.viewSeq || 0'));
    const st0 = await json(call, 'window.__perfHooks.kernelStats()') || {};
    const [z, lat, lon] = cam.split('/');
    const t = Date.now();
    await ev(call, `(() => { const m = window.__map0; m.camera.zoom=${z}; m.camera.lat=${lat}; m.camera.lon=${lon}; m._fireMove && m._fireMove(); m.render && m.render(); return 1; })()`);
    let ms = null, st1 = null;
    for (let i = 0; i < 1200; i++) {
      await sleep(100);
      if (Number(await ev(call, 'window.__storeApp?.viewSeq || 0')) > before) {
        ms = Date.now() - t;
        // ⚠ SAMPLED HERE, BEFORE THE RING. The view's own reads are what the index planned; the ring
        // pages eight more screens afterwards and its reads are NOT prefetched, so a session-wide hit
        // rate charges the index for work it was never asked about. "A number is not a measurement until
        // you know what it is attributed to" (HANDOFF §2) — this is that split.
        st1 = await json(call, 'window.__perfHooks.kernelStats()') || {};
        break;
      }
    }
    const settled = await settle(call);
    // The view is what the user waits for; SETTLED is when the session stops working — the ring included.
    // They are different claims and the ring is most of the reads, so both are reported.
    const settleMs = Date.now() - t;
    const app = await json(call, 'window.__storeApp') || {};
    const st = await json(call, 'window.__perfHooks.kernelStats()') || {};
    const ix = await json(call, 'window.__perfHooks.pageIndexStats()') || {};
    const pf = await json(call, 'window.__perfHooks.prefetchStats()') || {};
    const d = (a, b, k) => (a[k] || 0) - (b[k] || 0);
    return {
      ms, settled, settleMs,
      view: app.view || '', layers: app.layerCounts || {},
      reads: d(st, st0, 'rangeReads'), bytes: d(st, st0, 'rangeBytes'),
      hits: d(st, st0, 'prefetchHits'), miss: d(st, st0, 'prefetchMiss'),
      dl: d(st, st0, 'prefetchDownloadBytes'),
      // The VIEW alone — everything above also carries the ring that ran after it.
      vreads: st1 ? d(st1, st0, 'rangeReads') : 0,
      vhits: st1 ? d(st1, st0, 'prefetchHits') : 0,
      vmiss: st1 ? d(st1, st0, 'prefetchMiss') : 0,
      index: ix, batch: pf,
    };
  } finally { browser.close(); }
}

console.log(`\n=== WIRED PREFETCH — the app plans its own viewport, camera #${cam}`);
console.log(`    link: ${mbps} Mbps · ${rtt} ms RTT (emulated) · pad ${pad || 'default'}`);
const A = await arm(false);
const B = await arm(true);
let fails = 0;
const ok = (cond, msg) => { if (!cond) { fails++; console.error('  ✗ ' + msg); } else console.log('  ✓ ' + msg); };

for (const [n, r] of [['A', A], ['B', B]]) {
  if (r.error) { console.error(`  ✗ arm ${n}: ${r.error}`); process.exit(1); }
  console.log(`  ${n}  prefetch ${n === 'B' ? 'ON ' : 'OFF'}   ${String(r.ms ?? '>120000').padStart(7)} ms to the view, ${String(r.settleMs).padStart(6)} ms to settled · ` +
              `${String(r.reads).padStart(5)} range reads · ${(r.bytes / 1e6).toFixed(1)} MB · buffer hits ${r.hits}, misses ${r.miss}`);
  console.log(`         the VIEW alone: ${r.vreads} reads · ${r.vhits} hits, ${r.vmiss} misses` +
              `   · the ring after it: ${r.reads - r.vreads} reads, ${r.miss - r.vmiss} of them unprefetched`);
  if (r.batch && r.batch.batches) {
    console.log(`         the BATCHES: ${r.batch.batches} of them, ${r.batch.ms} ms total, ` +
                `${r.batch.pages} pages in ${r.batch.requests} request(s)` +
                `  ← this is time the view WAITS FOR, before the kernel runs`);
    const used = r.batch.pages ? (100 * r.hits) / r.batch.pages : 0;
    console.log(`         USED ${used.toFixed(1)}% of what it fetched (${r.hits} of ${r.batch.pages} pages, ` +
                `${(r.dl / 1e6).toFixed(1)} MB down the wire)` +
                `  ← waste is free on localhost and is NOT free on a real link`);
  }
}
const ix = B.index || {};
console.log(`      index: ${(ix.stores || []).length} stores · ${ix.cells || 0} cells · ${ix.leaves || 0} leaves · ` +
            `${ix.chunkReads || 0} chunk reads (${((ix.chunkBytes || 0) / 1024).toFixed(0)} kB) · ${ix.subdirsHeld || 0} sub-dirs`);
if ((ix.refusedSha || []).length) console.log(`      ⚠ refused: ${ix.refusedSha.join(' · ')}`);
if ((ix.unknownStores || []).length) console.log(`      ⚠ not in the index: ${ix.unknownStores.join(' · ')}`);

ok(A.settled && B.settled, 'both arms settled — the counters describe a session that has STOPPED');
ok(ix.open, 'the coverage index opened');
ok((ix.stores || []).length > 0 && (ix.cells || 0) > 0, `the index is not vacuous — ${(ix.stores || []).length} stores, ${ix.cells || 0} cells`);
ok((ix.chunkReads || 0) > 0, `the viewport actually read leaf chunks (${ix.chunkReads || 0})`);
ok(B.hits > 0, `the kernel's reads were answered from the buffer (${B.hits} hits)`);
// ⚠ ASSERTED ON THE VIEW, REPORTED FOR THE SESSION. The index's claim is about the viewport it was
// asked to plan; the ring that follows pages eight more screens and asks for nothing in advance, so a
// session-wide rate measures the ring's policy, not the index's accuracy.
const rate = B.vhits + B.vmiss ? (100 * B.vhits) / (B.vhits + B.vmiss) : 0;
const sess = B.hits + B.miss ? (100 * B.hits) / (B.hits + B.miss) : 0;
ok(rate >= Number(floorPct), `the VIEW's hit rate ${rate.toFixed(1)}% ≥ ${floorPct}% — the index names the pages the kernel asks for (§5.3)`);
console.log(`      session hit rate ${sess.toFixed(1)}% (view + the ring behind it)`);
// ⚠ THE MAP MUST BE THE SAME MAP. This is the check a timing cannot make.
ok(A.view === B.view, `the same view summary either way  ${JSON.stringify(B.view)}${A.view === B.view ? '' : `\n      A: ${JSON.stringify(A.view)}`}`);
ok(JSON.stringify(A.layers) === JSON.stringify(B.layers),
   `the same feature counts per layer${JSON.stringify(A.layers) === JSON.stringify(B.layers) ? '' : `\n      A: ${JSON.stringify(A.layers)}\n      B: ${JSON.stringify(B.layers)}`}`);

if (A.ms && B.ms) {
  console.log(`\n  ⇒ ${(A.ms / B.ms).toFixed(2)}× ${B.ms < A.ms ? 'FASTER' : 'SLOWER'} to the same view` +
              `   (${A.ms} ms → ${B.ms} ms), and ${(A.settleMs / B.settleMs).toFixed(2)}× to a settled session ` +
              `(${A.settleMs} ms → ${B.settleMs} ms — the ring is most of the reads)`);
  // Reported, not asserted: one camera on one box is a number, not a distribution, and a gate that fails
  // on a ratio fails on a loaded machine (PLAN-PERF §7e — a profile without its spread is not a
  // measurement). What IS asserted above is structural and holds at any load.
}
console.log(fails ? `\n  FAIL: ${fails} check(s)` : '\n  WIRED PREFETCH OK');
process.exit(fails ? 1 : 0);
