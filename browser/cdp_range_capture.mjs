// Copyright (c) 2026 Jurjen Stellingwerff
// SPDX-License-Identifier: LGPL-3.0-or-later
//
// CAPTURE THE ANSWER: the exact byte ranges a cold read actually asks for, in order.
//
// This is the generative instrument for the prefetch-index design, not a gate. The design's invariant —
// *the ranges a cold read of cell set K touches are a pure function of (block bytes, K)* — cannot be
// argued from the desk; it has to be read off a real capture. Two captures of the same camera either
// diff to nothing, or the invariant is false and the design dies here rather than after it is built.
//
// It records from CDP, so the app and the kernel are untouched: `Network.requestWillBeSent` carries the
// `Range` header we want. Nothing is instrumented, so nothing can be perturbed by instrumenting it.
//
//   node browser/cdp_range_capture.mjs <profile-dir> <url> <out.json> [cpuThrottle]
import { launch } from './cdp_transport.mjs';
import { writeFileSync } from 'node:fs';

const [profile, url, out, rateArg] = process.argv.slice(2);
if (!profile || !url || !out) { console.log('usage: cdp_range_capture.mjs <profile-dir> <url> <out.json> [rate]'); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await launch({
  bin: process.env.CHROMIUM_BIN || 'chromium', userDataDir: profile, maxLifetimeMs: 900_000,
});
const { call } = browser;
await call('Network.enable'); await call('Page.enable'); await call('Runtime.enable');
if (Number(rateArg || 1) > 1) await call('Emulation.setCPUThrottlingRate', { rate: Number(rateArg) });
await call('Network.setCacheDisabled', { cacheDisabled: true });
await call('Storage.clearDataForOrigin', { origin: new URL(url).origin, storageTypes: 'local_storage,cache_storage' });

const seq = [];
let paintedAt = null;
browser.onEvent((m) => {
  if (m.method !== 'Network.requestWillBeSent') return;
  const h = m.params.request.headers || {};
  const range = h.Range || h.range;
  if (!range) return;
  const mm = /bytes=(\d+)-(\d+)/.exec(range);
  if (!mm) return;
  seq.push({
    url: m.params.request.url.replace(/^https?:\/\/[^/]+/, ''),
    off: Number(mm[1]), len: Number(mm[2]) - Number(mm[1]) + 1,
    afterPaint: paintedAt !== null,
  });
});

const t0 = Date.now();
await call('Page.navigate', { url });
for (let i = 0; i < 900; i++) {
  await sleep(100);
  const r = await call('Runtime.evaluate', {
    expression: '!!(window.__storeApp && window.__storeApp.viewOk)', returnByValue: true,
  });
  if (r.result?.result?.value) { paintedAt = Date.now() - t0; break; }
}
await sleep(4000);   // let the ring finish, so its ranges are captured and LABELLED as after-paint
browser.close();

const crit = seq.filter((r) => !r.afterPaint);
const byStore = {};
for (const r of seq) (byStore[r.url] ||= []).push(r);

// The falsifier for the whole design: how BIG would a published range index be? If the distinct ranges
// for one camera are already megabytes, a per-block index over every camera cannot be small, and the
// design is dead before it is built.
const distinct = new Set(seq.map((r) => `${r.url}|${r.off}|${r.len}`));
const idxBytes = distinct.size * 12;   // off:u64-ish + len:u32, packed — the floor for a binary form

writeFileSync(out, JSON.stringify({ url, paintedAt, seq }, null, 0));
console.log(`  captured ${seq.length} ranged request(s) → ${out}`);
console.log(`    before first paint : ${crit.length}   (the critical path)`);
console.log(`    after  first paint : ${seq.length - crit.length}   (the ring — user waits for none of it)`);
console.log(`    first paint at     : ${paintedAt === null ? 'NEVER' : paintedAt + 'ms'}`);
console.log(`    distinct ranges    : ${distinct.size}  ⇒ a packed index would be ~${(idxBytes / 1024).toFixed(1)} kB for THIS camera`);
for (const [u, rs] of Object.entries(byStore)) {
  const bytes = rs.reduce((a, r) => a + r.len, 0);
  console.log(`    ${u.split('/').pop().padEnd(26)} ${String(rs.length).padStart(4)} reads · ${(bytes / 1e6).toFixed(1)} MB · median len ${Math.round(rs.map((r) => r.len).sort((a, b) => a - b)[rs.length >> 1] / 1024)} kB`);
}
