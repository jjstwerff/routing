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
//   * ⚠ and the bytes that actually CROSSED THE WIRE, which is not the size of the store
//
// ⚠ IT MUST BE THE FIRST `find` OF A FRESH PAGE. The kernel keeps the store in `names_at` and reloads
// only when the URL changes, so a second search in the same session measures a hash lookup and would
// report the ceiling as free.
//
// ⚠⚠ AND THE HOST DECIDES THE ANSWER, NOT THE STORE. GitHub Pages gzips a whole-file GET — the live
// site sends 21 397 927 bytes for a 63 468 112-byte store, 3.0x — while `tools/range_server.py` sends
// no `Content-Encoding` at all. So a THROTTLE_KBPS run against `_site` carries 3x the bytes the real
// link carries, and the first version of this probe reported that as the product's ceiling: 7.2 s on
// the 82 Mbps link and 49.9 s on a phone, against ~2.1 s and ~17 s live (`docs/name-search-index.md`
// §1a). Same family as `prefetch_gate`'s harness — an emulator generous with one resource is not a
// slower reality, it is a different question. The wire report below exists so that can never be read
// off this output again.
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

// WHAT CROSSED THE WIRE, per request — from CDP's own accounting rather than Resource Timing.
// `performance.getEntriesByName(url)[0].encodedBodySize` is the obvious source and it is ZERO for a
// cross-origin resource without `Timing-Allow-Origin`, which is exactly the shape that matters here (a
// localhost app reading Pages-hosted data). `Network.loadingFinished.encodedDataLength` is reported
// regardless of origin.
//
// ⚠ `loadingFinished` IS THE ONLY TRUSTWORTHY SOURCE, AND IT ARRIVES LATE. Two ways to get this wrong,
// both measured against the live site on 2026-08-07:
//   * Summing `Network.dataReceived.encodedDataLength` looks like the same number arriving in pieces.
//     It is not: Chrome charges the first ~20 chunks and then reports `encodedDataLength: 0` while
//     `dataLength` keeps climbing in 2 MB steps. Summing it under-counts a 21.4 MB store by ~10x.
//   * Reading the map as soon as the search returns races the request that the search kicked off — the
//     first `find` can resolve before the body is fully accounted, leaving `wireBytes` at 0 and printing
//     a ratio in the hundreds of thousands. So WAIT for it, and when it still has not arrived, say
//     "unfinished" rather than printing a zero that reads as a fact.
// Keyed by requestId because neither `loadingFinished` nor `dataReceived` carries a url — a url filter
// silently drops exactly the events this needs.
const wire = new Map();   // requestId -> { url, encoding, status, wireBytes, declared, finished, failed }
const isNameStore = (e) => e.url.includes('.names.store') && !e.url.endsWith('.dschema');
browser.onEvent((m) => {
  if (m.method === 'Network.responseReceived') {
    const r = m.params?.response || {};
    const h = {};
    for (const [k, v] of Object.entries(r.headers || {})) h[k.toLowerCase()] = v;
    wire.set(m.params.requestId, {
      url: r.url || '',
      encoding: h['content-encoding'] || '',
      status: r.status,
      declared: Number(h['content-length'] || 0),
      wireBytes: 0,
      finished: false,
      failed: '',
    });
  } else if (m.method === 'Network.loadingFinished') {
    const e = wire.get(m.params?.requestId);
    if (e) { e.wireBytes = Number(m.params.encodedDataLength || 0); e.finished = true; }
  } else if (m.method === 'Network.loadingFailed') {
    const e = wire.get(m.params?.requestId);
    if (e) { e.finished = true; e.failed = m.params?.errorText || 'failed'; }
  }
});
// Give every names-store request its `loadingFinished` before reporting. Generous, because a throttled
// run is deliberately slow at exactly this: 63.5 MB at 10 Mbps is ~51 s.
const settleWire = async (ms = Number(process.env.WIRE_SETTLE_MS || 90_000)) => {
  const t = Date.now();
  for (;;) {
    const pending = [...wire.values()].filter((e) => isNameStore(e) && !e.finished);
    if (!pending.length) return true;
    if (Date.now() - t > ms) return false;
    await sleep(100);
  }
};

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
  // The sketch autosave lives in localStorage and every driver reuses its --user-data-dir, so one
  // run's sketch restores into the next one's assertions. map_render_gate CHECKS for this line
  // rather than trusting discipline — and it caught both of these probes on their first run.
  await call('Storage.clearDataForOrigin', { origin: new URL(pageUrl).origin, storageTypes: 'local_storage' });
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

  // ⚠ THE WIRE, which is what the ceiling is actually made of. Resource Timing gives the decoded size
  // when it is same-origin; when it does not, say so rather than printing a zero that reads as a fact.
  const settled = await settleWire();
  const nameReqs = [...wire.values()].filter(isNameStore);
  if (!nameReqs.length) {
    console.log('  wire       : no .names.store request seen — the store was cached, or it is not fetched by URL');
  } else if (!settled) {
    // Never fold an unfinished request into a total: 0 bytes summed with real ones reads as compression.
    for (const e of nameReqs.filter((x) => !x.finished)) {
      bad(`${e.url.split('/').pop()} never reported loadingFinished — wire bytes unknown, NOT zero`);
    }
  } else {
    // Per request, not summed, so a stray small one (a redirect, a probe read) is visible rather than
    // quietly averaged into the number this probe exists to produce.
    for (const e of nameReqs) {
      console.log(`  request    : ${e.url.split('/').pop()} ${e.status} ${e.encoding || 'identity'}` +
        ` — ${(e.wireBytes / 1e6).toFixed(2)} MB on the wire${e.failed ? ` (${e.failed})` : ''}`);
    }
    const wireBytes = nameReqs.reduce((a, e) => a + e.wireBytes, 0);
    const enc = [...new Set(nameReqs.map((e) => e.encoding || 'identity'))].join(',');
    const url = nameReqs[0].url;
    const decoded = Number(await ev(
      `(performance.getEntriesByName(${JSON.stringify(url)})[0] || {}).decodedBodySize || 0`)) || 0;
    const mb = (n) => `${(n / 1e6).toFixed(2)} MB`;
    console.log(`  wire       : ${mb(wireBytes)} crossed the link as \`${enc}\`` +
      (decoded ? `, decoding to ${mb(decoded)} (${(decoded / Math.max(1, wireBytes)).toFixed(1)}x)`
               : ' (decoded size not visible — cross-origin without Timing-Allow-Origin)'));
    // The one line that stops this probe from reporting a harness property as the product's ceiling.
    if (kbps > 0 && !nameReqs.some((e) => e.encoding)) {
      console.log(`  ⚠ THIS HOST DID NOT COMPRESS, so the ${kbps} KB/s above was spent on ${mb(wireBytes)}.`);
      console.log('    GitHub Pages gzips this store ~3.0x, so the LIVE cost is roughly a third of the');
      console.log('    time printed here. This number describes the harness — see docs/name-search-index.md §1a.');
    }
  }

  const ratio = secondMs > 0 ? (firstMs / secondMs) : Infinity;
  console.log(`  the ceiling: the first search pays ${ratio === Infinity ? '∞' : ratio.toFixed(1)}x the second`);
} catch (e) {
  bad(String(e && e.message || e));
} finally {
  await close();
}
process.exit(fail);
