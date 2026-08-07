// Copyright (c) 2026 Jurjen Stellingwerff
// SPDX-License-Identifier: LGPL-3.0-or-later
//
// WHAT CAN THE APP ACTUALLY KNOW ABOUT THE MACHINE IT IS RUNNING ON?
//
// The retention cap, the debut ladder and the ring all want the same answer — *is this a phone or a
// laptop* — and the honest way to pick a signal is to change the machine and see which signals move.
// CDP's CPU throttle does exactly that: it slows the renderer by a factor, which is what a mid-range
// phone IS relative to this box (`CPU_THROTTLE=4` is the target device throughout PLAN-PERF).
//
// So this reports, at each throttle level:
//
//   * the STATIC hints — `navigator.deviceMemory`, `hardwareConcurrency`, `userAgentData.mobile`. They
//     describe the machine, and the question is whether they describe it WELL.
//   * `performance.memory.jsHeapSizeLimit` — Chrome's per-tab heap ceiling, which is the OOM boundary the
//     retention cap is really trying to respect.
//   * a MEASURED signal: the wall time of N trivial kernel round trips. Each one is JS → wasm → loft's
//     loop → back, so it is the app's own machinery rather than a synthetic loop, and it needs no data.
//   * the same work in pure JS, so the two can be compared.
//
// ⚠ wasm cannot INTROSPECT the machine — the sandbox exposes no CPU, no memory, no device. What it can do
// is be TIMED. That is the whole point of the comparison below: a static hint is a claim, a timing is a
// measurement, and only one of them changes when the machine does.
//
//   node browser/cdp_device_probe.mjs <profile-dir> <url> [throttles]
import { launch } from './cdp_transport.mjs';

const [profile, url, throttles = '1,4,8'] = process.argv.slice(2);
if (!profile || !url) { console.log('usage: cdp_device_probe.mjs <profile-dir> <url> [throttles]'); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (call, x) => (await call('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true })).result?.result?.value;
const json = async (call, x) => { try { return JSON.parse(await ev(call, `JSON.stringify(${x})`) || 'null'); } catch { return null; } };

const ROUNDS = 40;

async function at(rate) {
  const browser = await launch({ bin: process.env.CHROMIUM_BIN || 'chromium', userDataDir: `${profile}-${rate}` });
  const { call } = browser;
  try {
    await call('Page.enable'); await call('Runtime.enable');
    if (rate > 1) await call('Emulation.setCPUThrottlingRate', { rate });
    // Every driver clears this: the sketch autosave lives in localStorage and each gate reuses its
    // `--user-data-dir`, so one run's sketch would restore into the next one's measurements. The gate
    // that enforces it is the reason "the eighth one forgets" is a closed case rather than a habit.
    await call('Storage.clearDataForOrigin', { origin: new URL(url).origin, storageTypes: 'local_storage' });
    await call('Page.navigate', { url });
    for (let i = 0; i < 900; i++) { await sleep(100); if (await ev(call, '!!(window.__storeApp&&window.__storeApp.ready)')) break; }
    await sleep(1500);

    const stat = JSON.parse(await ev(call, `JSON.stringify({
      deviceMemory: navigator.deviceMemory ?? null,
      cores: navigator.hardwareConcurrency ?? null,
      mobile: navigator.userAgentData ? navigator.userAgentData.mobile : null,
      heapLimit: performance.memory ? performance.memory.jsHeapSizeLimit : null,
      heapUsed: performance.memory ? performance.memory.usedJSHeapSize : null })`) || '{}');

    // The MEASURED signal: N trivial kernel round trips. `reset` reads nothing and computes nothing —
    // what it times is the path every command pays, which is the machinery this app is made of.
    const wasmMs = Number(await ev(call, `(async () => {
      const t = performance.now();
      for (let i = 0; i < ${ROUNDS}; i++) await window.__perfHooks.kernelPing();
      return performance.now() - t;
    })()`)) || 0;
    // ⚠ THE SIGNAL THE TIER ACTUALLY USES: features indexed-and-drawn per millisecond, taken from the
    // app's own view path rather than from a synthetic loop. The thresholds in device.mjs are set from
    // this table, so it has to be the same number the app feeds `device.observe`.
    // The samples the BOOT view already produced under this throttle — no need to provoke another, and
    // provoking one is unreliable anyway (a camera nudge inside the loaded box is a redraw, not a view).
    const dev0 = await json(call, 'window.__perfHooks.deviceStats()') || { samples: [] };
    const perMs = dev0.samples.length ? dev0.samples[dev0.samples.length - 1] : 0;
    const allSamples = dev0.samples.join(' ');
    const dev = await json(call, 'window.__perfHooks.deviceStats()') || {};
    // ⚠ DOES THE APP OBEY THE TIER, or merely report it? The tier is only worth having if the pad, the
    // ring and the drawn detail actually follow it — a stat nothing acts on is decoration.
    // Sampled once the session has STOPPED: the ring publishes its plan when it is scheduled, which is
    // after the view reports. Reading before that reported `null` and proved nothing.
    for (let i = 0; i < 300; i++) { if (await ev(call, 'window.__perfHooks.settled()')) break; await sleep(200); }
    const obeys = await json(call, `({ pad: window.__storeApp.viewPad ?? null,
                                       ring: window.__storeApp.ringCells ?? null,
                                       detail: window.__map0.detailShift ?? null })`) || {};

    // Real wasm COMPUTATION, not just a round trip: the app's own matcher over a fixed sketch, on data
    // that is already resident. This is the work a slow device actually struggles with.
    const matchMs = Number(await ev(call, `(async () => {
      const t = performance.now();
      await window.__perfHooks.matchSpec('52.2412299,6.8834496;52.2694705,6.9164085;52.3116272,6.9088554');
      return performance.now() - t;
    })()`)) || 0;
    // The same amount of wall time asked of pure JS, for comparison.
    const jsMs = Number(await ev(call, `(() => {
      const t = performance.now(); let x = 0;
      for (let i = 0; i < 3e6; i++) x += Math.sqrt(i) % 7;
      return performance.now() - t + (x > -1 ? 0 : 1);
    })()`)) || 0;
    return { rate, ...stat, perMs, allSamples, tier: dev.tier, source: dev.source, obeys, dev,
             wasmMs: Math.round(wasmMs), matchMs: Math.round(matchMs), jsMs: Math.round(jsMs) };
  } finally { browser.close(); }
}

const rows = [];
for (const r of throttles.split(',').map(Number)) rows.push(await at(r));

console.log('\n=== what the app can know about the machine ===\n');
console.log('  CPU throttle is the machine getting slower. A signal that does not move with it cannot');
console.log('  tell a phone from a laptop, however true it is.\n');
console.log(`  ${'throttle'.padEnd(9)}${'deviceMem'.padStart(10)}${'cores'.padStart(7)}${'mobile'.padStart(8)}` +
            `${'heapLimit'.padStart(12)}${'wasm ' + ROUNDS + 'x'.padStart(4)}`.padStart(24) + `${'js loop'.padStart(10)}`);
for (const r of rows) {
  console.log(`  ${(r.rate + '×').padEnd(9)}${String(r.deviceMemory).padStart(10)}${String(r.cores).padStart(7)}` +
              `${String(r.mobile).padStart(8)}${(r.heapLimit ? (r.heapLimit / 1e6).toFixed(0) + ' MB' : 'null').padStart(12)}` +
              `${String(Math.round(r.perMs)).padStart(13)}${String(r.tier).padStart(10)}${(r.matchMs + ' ms').padStart(9)}${(r.jsMs + ' ms').padStart(9)}`);
}
const base = rows[0];
console.log('\n  what the app is DOING at each tier (the knobs, not the label):');
for (const r of rows) {
  console.log(`    ${r.rate}×  tier ${String(r.tier).padEnd(8)} pad ${r.dev.pad}  ring ${r.dev.ring}  ` +
              `detail +${r.dev.detail}  cap ${(r.dev.cap / 1e6).toFixed(0)} MB   ` +
              `→ map.detailShift=${r.obeys.detail}, ring planned=${r.obeys.ring}`);
}
console.log('\n  every sample, per throttle:');
for (const r of rows) console.log(`    ${r.rate}×  ${r.allSamples || '(none)'}`);
console.log('\n  relative to 1×:');
for (const r of rows.slice(1)) {
  console.log(`    ${r.rate}×  wasm ${(r.wasmMs / base.wasmMs).toFixed(2)}×   js ${(r.jsMs / base.jsMs).toFixed(2)}×` +
              `   deviceMemory ${r.deviceMemory === base.deviceMemory ? 'UNCHANGED' : 'changed'}` +
              `   cores ${r.cores === base.cores ? 'UNCHANGED' : 'changed'}` +
              `   heapLimit ${r.heapLimit === base.heapLimit ? 'UNCHANGED' : 'changed'}`);
}
console.log('');
