// Copyright (c) 2026 Jurjen Stellingwerff
// SPDX-License-Identifier: LGPL-3.0-or-later
//
// HOW LONG BEFORE THERE IS A MAP ON THE SCREEN? — measured against a real host, over a real network.
//
// Every other instrument here measures BYTES or CPU. Neither is what a user waits for. A paged read is
// a chain of HTTP requests, and if those requests are SERIAL the wait is `depth × round-trip`, which no
// amount of byte-shaving touches — an 8.1 MB viewport fetched in 136 serial requests over a 30 ms link
// costs 4 s of pure waiting and ~0 s of transfer.
//
// So this reports the two things that decide the answer, and keeps them apart:
//
//   * WHEN — navigation → first block byte → app ready → first map drawn.
//   * WHY  — request COUNT, and the concurrency that turns count into wall-clock. `sum(durations) /
//     span` is the honest measure of serialisation: ≈1 means one-at-a-time (depth is the cost), ≫1 means
//     the reads overlap and only the slowest chain matters.
//
// ⚠ IT MEASURES A COLD VISITOR. localStorage and cache are cleared, because the number that matters is
// the FIRST visit — a warm reload measures the cache, which is not the thing anyone waits for.
//
//   node browser/cdp_latency.mjs <profile-dir> <url> [cpuThrottle] [runs]
import { launch } from './cdp_transport.mjs';

const [profile, url, rateArg, runsArg] = process.argv.slice(2);
if (!profile || !url) { console.log('usage: cdp_latency.mjs <profile-dir> <url> [cpuThrottle] [runs]'); process.exit(2); }
const RATE = Number(rateArg || 1);
const RUNS = Number(runsArg || 3);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };

const runs = [];
for (let run = 0; run < RUNS; run++) {
  const browser = await launch({
    bin: process.env.CHROMIUM_BIN || 'chromium',
    userDataDir: `${profile}-${run}`,
    maxLifetimeMs: 300_000,
  });
  const { call } = browser;
  await call('Network.enable');
  await call('Page.enable');
  await call('Runtime.enable');
  if (RATE > 1) await call('Emulation.setCPUThrottlingRate', { rate: RATE });
  // A cold visitor, deliberately: no disk cache, no localStorage carried in.
  await call('Network.setCacheDisabled', { cacheDisabled: true });
  await call('Storage.clearDataForOrigin', { origin: new URL(url).origin, storageTypes: 'local_storage,cache_storage' });

  // Request timeline. `wallTime`/`timestamp` are seconds — keep everything in ms from navigation.
  const reqs = new Map();
  const done = [];
  browser.onEvent((m) => {
    if (m.method === 'Network.requestWillBeSent') {
      reqs.set(m.params.requestId, { url: m.params.request.url, start: m.params.timestamp * 1000, ranged: !!(m.params.request.headers || {}).Range });
    } else if (m.method === 'Network.loadingFinished') {
      const r = reqs.get(m.params.requestId);
      if (r) { r.end = m.params.timestamp * 1000; r.bytes = m.params.encodedDataLength || 0; done.push(r); }
    }
  });

  const t0 = Date.now();
  await call('Page.navigate', { url });

  // ⚠ THE APP'S OWN SIGNAL, not one invented here. `store-app.mjs` records `viewSeq` (completed views),
  // `viewOk` (`R=\d+` — the first view actually drew roads, rather than completing empty) and
  // `firstViewMs`, which is the only genuinely COLD view because it pays the session's store load. An
  // earlier draft of this probe polled `__map0._drawCount` and `_lastFeatureCount`; neither exists, so it
  // would have reported "never drawn" on a perfectly good load. Checked before trusting a number from it.
  let tReady = null, tDrawn = null, firstViewMs = null;
  for (let i = 0; i < 600; i++) {
    await sleep(100);
    const r = await call('Runtime.evaluate', {
      expression: `JSON.stringify({
        seq:   (window.__storeApp && window.__storeApp.viewSeq) || 0,
        ok:    !!(window.__storeApp && window.__storeApp.viewOk),
        first: (window.__storeApp && window.__storeApp.firstViewMs) || null,
      })`, returnByValue: true,
    });
    let st; try { st = JSON.parse(r.result?.result?.value || '{}'); } catch { st = {}; }
    if (st.seq > 0 && tReady === null) { tReady = Date.now() - t0; firstViewMs = st.first; }
    if (st.ok && tDrawn === null) tDrawn = Date.now() - t0;
    if (tDrawn !== null) break;
  }

  await sleep(1500);   // let the ring settle so its requests are counted honestly
  const store = done.filter((r) => /\.store(\?|$)/.test(r.url) || r.ranged);

  // ⚠ SPLIT AT FIRST PAINT, or this instrument charges the wrong work. `store-app.mjs` schedules the
  // RING after the view completes — "The screen is on the glass; NOW go and get its surroundings" — so
  // its requests exist precisely so the user does NOT wait for them. Counting them against time-to-map
  // makes the app look ~3× worse than it is and would send an optimisation at prefetch that is already
  // off the critical path. The first draft of this probe did exactly that: 764 requests / 51.7 MB, most
  // of it after the pixels were up.
  const t0abs = t0;
  const paintAt = tDrawn === null ? Infinity : t0abs + tDrawn;
  const stamp = (r) => t0abs + (r.start - (store.length ? Math.min(...store.map((x) => x.start)) : 0));
  const before = store.filter((r) => r.end && stamp(r) <= paintAt);
  const after = store.filter((r) => r.end && stamp(r) > paintAt);

  const metrics = (set) => {
    if (!set.length) return { n: 0, bytes: 0, span: 0, busy: 0, conc: 0, medReq: 0 };
    const span = Math.max(...set.map((r) => r.end)) - Math.min(...set.map((r) => r.start));
    const busy = set.reduce((a, r) => a + (r.end - r.start), 0);
    return {
      n: set.length, bytes: set.reduce((a, r) => a + (r.bytes || 0), 0),
      span, busy, conc: span > 0 ? busy / span : 0, medReq: med(set.map((r) => r.end - r.start)),
    };
  };
  const crit = metrics(before), ring = metrics(after);

  runs.push({
    ready: tReady, drawn: tDrawn, firstView: firstViewMs,
    reqs: crit.n, bytes: crit.bytes, span: crit.span, busy: crit.busy,
    concurrency: crit.conc, medReq: crit.medReq,
    ringReqs: ring.n, ringBytes: ring.bytes,
  });
  browser.close();
  await sleep(500);
}

const f = (k) => runs.map((r) => r[k]).filter((v) => v !== null && v !== undefined);
const show = (label, k, unit = 'ms') => {
  const v = f(k); if (!v.length) return console.log(`  ${label.padEnd(26)} —`);
  const lo = Math.min(...v), hi = Math.max(...v);
  console.log(`  ${label.padEnd(26)} ${Math.round(med(v))}${unit}   (${Math.round(lo)}–${Math.round(hi)}, n=${v.length})`);
};

console.log(`\n=== TIME TO A MAP — ${url}`);
console.log(`    cold each run (no cache, no localStorage) · CPU throttle ${RATE}× · ${RUNS} runs, median (range)\n`);
show('first view completed', 'ready');
show('FIRST MAP DRAWN (R>0)', 'drawn');
show("app's own firstViewMs", 'firstView');
console.log('');
show('block requests', 'reqs', '');
show('median request', 'medReq');
show('request wall-clock span', 'span');
show('sum of request time', 'busy');
const c = f('concurrency');
if (c.length) {
  const cm = med(c);
  console.log(`  effective concurrency      ${cm.toFixed(1)}×`);
  console.log(cm < 1.5
    ? '    ⚠ SERIAL — the reads happen one at a time, so latency is depth × round-trip and\n'
      + '      fetching fewer, larger ranges is the only lever that moves it.'
    : '    the reads overlap, so only the slowest chain is on the critical path, not the total.');
}
console.log(`  bytes over the wire        ${(med(f('bytes')) / 1e6).toFixed(1)} MB`);
console.log('');
