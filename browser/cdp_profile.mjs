// Copyright (c) 2026 Jurjen Stellingwerff
// SPDX-License-Identifier: LGPL-3.0-or-later
//
// Phase profiler for the standalone store app — the measurement PLAN-PERF's design rests on.
// Times each phase of `view` and `match` separately, so the bottleneck is attributed rather than
// assumed: wasm-side (store decode + serialize) vs JS-side (text parse) vs render.
//
// PHONE IS THE TARGET DEVICE, and a desktop profile flatters us — worse, it can flatter the phases
// UNEQUALLY, so the ranking itself may not survive. `rate` applies CDP CPU throttling (4–6x ≈ a
// mid-range phone) so the design is judged on the device it ships to.
//   node browser/cdp_profile.mjs <devtools host:port> <app url> [cpuThrottleRate]
const [dt, app, rateArg] = process.argv.slice(2);
const RATE = Number(rateArg || 1);
setTimeout(() => { console.log('  FAIL: hard timeout'); process.exit(3); }, 180000);

const list = await (await fetch(`http://${dt}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map(); const errs = [];
const call = (m, p) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  else if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
});
await new Promise((r) => ws.addEventListener('open', r));
await call('Runtime.enable'); await call('Page.enable');
if (RATE > 1) await call('Emulation.setCPUThrottlingRate', { rate: RATE });
const ev = async (x) => {
  const r = await call('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) return { __err: JSON.stringify(r.result.exceptionDetails).slice(0, 300) };
  return r.result?.result?.value;
};

await call('Page.navigate', { url: app });
// wait for the app's initial view to complete
let st = null;
for (let i = 0; i < 200; i++) {
  await new Promise((r) => setTimeout(r, 500));
  const s = await ev('window.__storeApp?JSON.stringify(window.__storeApp):""');
  if (s) { st = JSON.parse(s); if (st.ready) break; }
}
if (!st?.ready) { console.log('  FAIL: app never became ready', JSON.stringify(st), errs.slice(-2)); process.exit(1); }

// Re-run the view with the phases timed individually. Uses the app's own module bindings via the
// hooks it exports; falls back to re-invoking runKernel directly.
const probe = `(async () => {
  const K = window.__perfHooks;
  if (!K) return { __err: 'no __perfHooks — app not instrumented' };
  const out = { runs: [] };
  for (let i = 0; i < 3; i++) {
    const r = await K.timedView();
    out.runs.push(r);
  }
  out.decodeBoth = []; out.decodeRoads = [];
  if (K.timedDecodeBoth)  for (let i = 0; i < 3; i++) out.decodeBoth.push(await K.timedDecodeBoth());
  if (K.timedDecodeRoads) for (let i = 0; i < 3; i++) out.decodeRoads.push(await K.timedDecodeRoads());
  const SKETCH = [[52.2412299,6.8834496],[52.2694705,6.9164085],[52.3116272,6.9088554]];
  out.matchCold = []; out.matchWarm = [];
  for (let i = 0; i < 2; i++) out.matchCold.push(await K.matchColdFull(SKETCH));
  if (K.matchWarm) for (let i = 0; i < 2; i++) out.matchWarm.push(await K.matchWarm(SKETCH));
  out.block = [];
  if (K.frameBlocking) { out.block.push(await K.frameBlocking('view')); out.block.push(await K.frameBlocking('match')); }
  return out;
})()`;
const res = await ev(probe);
if (res?.__err) { console.log('  ERR:', res.__err); process.exit(1); }

const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const fmt = (n) => String(Math.round(n)).padStart(6);
console.log('\n########## CPU throttle: ' + RATE + 'x ' + (RATE > 1 ? '(≈ phone class)' : '(desktop)') + ' ##########');
if (res.decodeBoth?.length) {
  const db = med(res.decodeBoth.map((r) => r.kernel));
  const dr = med(res.decodeRoads.map((r) => r.kernel));
  console.log('\n=== STORE DECODE per kernel call (degenerate arg ⇒ command work ≈ 0), ms ===');
  console.log('  layout+roads (what `view` loads) ' + fmt(db));
  console.log('  roads only   (what `match` loads)' + fmt(dr));
  console.log('  ⇒ layout store alone            ' + fmt(db - dr) + '   (20MB, VIEW-ONLY — match never loads it)');
  globalThis.__db = db; globalThis.__dr = dr;
}
console.log('\n=== VIEW phases (median of ' + res.runs.length + ' runs, ms) ===');
for (const k of ['kernel', 'parse', 'render', 'total']) {
  console.log(`  ${k.padEnd(10)} ${fmt(med(res.runs.map((r) => r[k])))}`);
}
console.log('  text bytes  ' + fmt(med(res.runs.map((r) => r.bytes))) + '   lines ' + fmt(med(res.runs.map((r) => r.lines))));
console.log('\n=== MATCH phases (median, ms) — COLD FULL vs WARM (one point added) ===');
console.log('              cold_full   warm');
for (const k of ['kernel', 'parse', 'render', 'total']) {
  const c = med(res.matchCold.map((r) => r[k]));
  const w = res.matchWarm?.length ? med(res.matchWarm.map((r) => r[k])) : null;
  console.log(`  ${k.padEnd(10)} ${fmt(c)}  ${w === null ? '     -' : fmt(w)}`);
}
if (res.matchWarm?.length) {
  const c = med(res.matchCold.map((r) => r.kernel)), w = med(res.matchWarm.map((r) => r.kernel));
  console.log('  ratio warm/cold  ' + (w / c).toFixed(2) + 'x');
  console.log('  → warm ≈ cold means the app re-matches the WHOLE sketch when one point changed');
  console.log('    (PLAN-PERF §1). server.loft does this incrementally in 40-68ms. Steps 6-8 move it.');
}
if (globalThis.__db) {
  const db = globalThis.__db, dr = globalThis.__dr;
  const vk = med(res.runs.map((r) => r.kernel)), mk = med(res.matchCold.map((r) => r.kernel));
  console.log('\n=== ATTRIBUTION (each command minus the decode IT actually pays) ===');
  console.log('  view:  decode(both) ' + fmt(db) + ' + serialize ' + fmt(vk - db) + '  = kernel ' + fmt(vk));
  console.log('  match_cold_full: decode(roads)' + fmt(dr) + ' + compute ' + fmt(mk - dr) + '  = kernel ' + fmt(mk));
}
if (res.block?.length) {
  console.log('\n=== MAIN-THREAD BLOCKING (is the UI alive while the kernel runs?) ===');
  for (const b of res.block) {
    console.log('  ' + b.kind.padEnd(6) + ' call ' + fmt(b.total) + 'ms · frames landed ' + String(b.frames).padStart(4) +
                ' of ~' + String(b.expectedFrames).padStart(4) + ' expected · longest frozen gap ' + fmt(b.longestGap) + 'ms');
  }
  console.log('  (a responsive app lands ~all expected frames with ~16ms gaps;');
  console.log('   a blocked one lands almost none and shows one gap ≈ the whole call)');
}
console.log('');
process.exit(0);
