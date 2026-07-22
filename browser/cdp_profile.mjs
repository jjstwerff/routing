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
// Generous, and overridable: at CPU_THROTTLE=4 the probe does ~6 cold matches (~6 s each) plus six
// full views that now include the store read. 180 s used to be ample and stopped being so the moment
// step 13 moved the layout into JS — a hard timeout is a measurement input, not a constant.
setTimeout(() => { console.log('  FAIL: hard timeout'); process.exit(3); }, Number(process.env.PROFILE_TIMEOUT_MS || 600000));

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
const N = Number(process.env.PROFILE_RUNS || 6);
const probe = `(async () => {
  const K = window.__perfHooks;
  if (!K) return { __err: 'no __perfHooks — app not instrumented' };
  const out = { runs: [] };
  // C0: repeat the SAME command in ONE session. Comparing across different probe orders / commands /
  // session states is what produced the 2-3x "variance" — like-for-like repetition is ~1.1x.
  for (let i = 0; i < ${N}; i++) out.runs.push(await K.timedView());
  out.decodeBoth = []; out.decodeRoads = [];
  if (K.timedDecodeBoth)  for (let i = 0; i < 3; i++) out.decodeBoth.push(await K.timedDecodeBoth());
  if (K.timedDecodeRoads) for (let i = 0; i < 3; i++) out.decodeRoads.push(await K.timedDecodeRoads());
  // C0: reach the working-set plateau BEFORE measuring; report what the growth cost.
  out.warmView = K.warmup ? await K.warmup('view', 6) : null;
  out.warmMatch = K.warmup ? await K.warmup('match', 8) : null;
  const SKETCH = [[52.2412299,6.8834496],[52.2694705,6.9164085],[52.3116272,6.9088554]];
  out.matchCold = []; out.matchWarm = []; out.matchRepeat = [];
  if (K.matchTrueCold) for (let i = 0; i < ${N}; i++) out.matchCold.push(await K.matchTrueCold(SKETCH));
  out.matchColdStreamed = [];
  if (K.matchTrueColdStreamed) for (let i = 0; i < ${N}; i++) out.matchColdStreamed.push(await K.matchTrueColdStreamed(SKETCH));
  if (K.matchRepeat) for (let i = 0; i < ${N}; i++) out.matchRepeat.push(await K.matchRepeat(SKETCH));
  if (K.matchWarm) for (let i = 0; i < ${N}; i++) out.matchWarm.push(await K.matchWarm(SKETCH));
  out.matchExtend = [];
  if (K.matchExtend) for (let i = 0; i < ${N}; i++) out.matchExtend.push(await K.matchExtend(SKETCH));
  out.matchInsert = []; out.matchDelete = [];
  if (K.matchInsert) for (let i = 0; i < ${N}; i++) out.matchInsert.push(await K.matchInsert(SKETCH));
  if (K.matchDelete) for (let i = 0; i < ${N}; i++) out.matchDelete.push(await K.matchDelete(SKETCH));
  out.renderBudget = K.renderBudget ? await K.renderBudget(${N}) : null;
  out.stats = K.kernelStats ? K.kernelStats() : null;
  out.appFirstViewMs = window.__storeApp?.firstViewMs || null;
  out.stream = K.streamProgress ? await K.streamProgress() : null;
  out.streamN = [];
  if (K.streamProgressN) for (const n of [3, 40]) out.streamN.push(await K.streamProgressN(n));
  out.block = [];
  if (K.frameBlocking) {
    out.block.push(await K.frameBlocking('view'));
    out.block.push(await K.frameBlocking('match'));
    out.block.push(await K.frameBlocking('matchWarm'));
  }
  return out;
})()`;
const res = await ev(probe);
if (res?.__err) { console.log('  ERR:', res.__err); process.exit(1); }

const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const fmt = (n) => String(Math.round(n)).padStart(6);
// C0: a number without its spread is not a measurement. `x.y` is max/min — anything past ~1.3x means
// the runs are not like-for-like and the median is not comparable to anything.
const spread = (xs) => { const lo = Math.min(...xs), hi = Math.max(...xs); return lo > 0 ? (hi / lo).toFixed(1) + 'x' : '-'; };
const row = (name, xs) => console.log(`  ${name.padEnd(10)} ${fmt(med(xs))}   ${String(Math.round(Math.min(...xs))).padStart(5)}–${String(Math.round(Math.max(...xs))).padEnd(6)} ${spread(xs)}`);
console.log('\n########## CPU throttle: ' + RATE + 'x ' + (RATE > 1 ? '(≈ phone class)' : '(desktop)') + ' ##########');
if (res.decodeBoth?.length) {
  const db = med(res.decodeBoth.map((r) => r.kernel));
  const dr = med(res.decodeRoads.map((r) => r.kernel));
  console.log('\n=== degenerate-arg probes (ms) — NOTE: no longer a decode measurement ===');
  console.log('  empty-bbox view  ' + fmt(db) + '   = the full-region tile scan (1089 tiles, ring_hits over ~230k');
  console.log('                        features) emitting nothing — the session already holds the store.');
  console.log('  degenerate match ' + fmt(dr) + '   = a cached roads store + ~no compute.');
  console.log('  → the store load is now visible ONLY as cold-vs-warm below, not here.');
  globalThis.__db = db; globalThis.__dr = dr;
}
console.log('\n=== VIEW — same command x' + res.runs.length + ' in one session (ms) ===');
console.log('             median   min–max   spread');
for (const k of ['kernel', 'parse', 'storeRead', 'render', 'total']) row(k, res.runs.map((r) => r[k]));
if (res.appFirstViewMs) {
  const w = med(res.runs.map((r) => r.total));
  console.log('\n  app FIRST view (the only truly cold one — pays the session store load): ' + fmt(res.appFirstViewMs) + 'ms');
  console.log('  every later view (session reuses the store):                            ' + fmt(w) + 'ms');
  console.log('  → store load paid ONCE at startup: ' + fmt(res.appFirstViewMs - w) + 'ms never paid again');
}
console.log('  text bytes  ' + fmt(med(res.runs.map((r) => r.bytes))) + '   lines ' + fmt(med(res.runs.map((r) => r.lines))));
if (res.warmMatch) {
  console.log('\n=== C0 · WORKING-SET WARMUP (match) — the cost of growing wasm memory ===');
  console.log('   run     ms   wasmMB  grew?');
  for (const [i, r] of res.warmMatch.entries())
    console.log(`   ${String(i).padStart(3)} ${String(Math.round(r.ms)).padStart(6)}   ${String(r.wasmMB).padStart(6)}  ${r.grew ? 'yes' : 'no (plateau)'}`);
  console.log('   → a session\'s FIRST matches are the slowest: each memory.grow can copy the whole');
  console.log('     linear memory. Real user cost, not noise — measurement below starts after this.');
}
console.log('\n  raw match_cold   kernel per run: ' + res.matchCold.map((r) => Math.round(r.kernel)).join(', '));
console.log('  raw match_repeat kernel per run: ' + (res.matchRepeat || []).map((r) => Math.round(r.kernel)).join(', '));
console.log('  raw match_warm   kernel per run: ' + (res.matchWarm || []).map((r) => Math.round(r.kernel)).join(', '));
console.log('\n=== MATCH TRUE COLD (session dropped first — corridor + build_graph + full seed) — x' + res.matchCold.length + ' (ms) ===');
console.log('             median   min–max   spread');
for (const k of ['kernel', 'parse', 'render', 'total']) row(k, res.matchCold.map((r) => r[k]));
if (res.matchColdStreamed?.length) {
  // The app's REAL click path: the same cold match with the route drawing itself per stretch (§6b(2)).
  // Reported as a delta against MATCH TRUE COLD above, because the growing line's cost is only meaningful
  // like-for-like — and because a headline number that quietly absorbed it would explain nothing.
  console.log('\n=== MATCH TRUE COLD, STREAMED (the app\'s click path — the line grows) — x' + res.matchColdStreamed.length + ' (ms) ===');
  console.log('             median   min–max   spread');
  for (const k of ['kernel', 'parse', 'render', 'total']) row(k, res.matchColdStreamed.map((r) => r[k]));
  const s = med(res.matchColdStreamed.map((r) => r.total)), p = med(res.matchCold.map((r) => r.total));
  console.log('\n  growing line costs  ' + (s - p >= 0 ? '+' : '') + Math.round(s - p) + ' ms  (' + (s / p).toFixed(2) + 'x of the non-streaming path)');
  console.log('    → work is meant to be proportional to the ROUTE, not the map: applyStretch strokes a');
  console.log('      polyline per stretch, never a full render. A ratio climbing with sketch size means');
  console.log('      that stopped holding (PLAN-PERF §6b(2)).');
}
if (res.matchRepeat?.length) {
  console.log('\n=== MATCH REPEAT (identical sketch, live session — NOTHING changed; the floor) — x' + res.matchRepeat.length + ' (ms) ===');
  console.log('             median   min–max   spread');
  for (const k of ['kernel', 'total']) row(k, res.matchRepeat.map((r) => r[k]));
}
if (res.matchExtend?.length) {
  console.log('\n=== MATCH EXTEND (+1 point, ~500m — outside the corridor, cannot be warm) — x' + res.matchExtend.length + ' (ms) ===');
  console.log('             median   min–max   spread');
  for (const k of ['kernel', 'total']) row(k, res.matchExtend.map((r) => r[k]));
}
if (res.matchWarm?.length) {
  console.log('\n=== MATCH WARM (one point MOVED ~20m — inside the corridor) — x' + res.matchWarm.length + ' (ms) ===');
  console.log('             median   min–max   spread');
  for (const k of ['kernel', 'parse', 'render', 'total']) row(k, res.matchWarm.map((r) => r[k]));
}
// PLAN-EDIT §2 P5: the editor rests on insert and delete riding the SAME incremental path as a move
// rather than falling back to a cold rebuild. Reported beside warm and cold so the claim is re-checkable.
for (const [name, arr] of [['INSERT', res.matchInsert], ['DELETE', res.matchDelete]]) {
  if (!arr?.length) continue;
  console.log(`\n=== MATCH ${name} (one interior point ${name === 'INSERT' ? 'added' : 'removed'} — PLAN-EDIT E2/E4) — x${arr.length} (ms) ===`);
  console.log('             median   min–max   spread');
  for (const k of ['kernel', 'total']) row(k, arr.map((r) => r[k]));
}
if (res.matchCold?.length && res.matchInsert?.length && res.matchDelete?.length) {
  const c = med(res.matchCold.map((r) => r.kernel));
  const i = med(res.matchInsert.map((r) => r.kernel)), d = med(res.matchDelete.map((r) => r.kernel));
  console.log(`\n  P5: insert ${Math.round(i)}ms and delete ${Math.round(d)}ms vs cold ${Math.round(c)}ms ` +
              `— ${(i / c * 100).toFixed(0)}% / ${(d / c * 100).toFixed(0)}% of a cold match ` +
              `(${i < c * 0.6 && d < c * 0.6 ? 'both WARM — the incremental path covers them' : '⚠ NOT warm — re-open PLAN-EDIT §2 P5'})`);
}
if (res.matchWarm?.length && res.matchCold?.length) {
  const c = med(res.matchCold.map((r) => r.kernel)), w = med(res.matchWarm.map((r) => r.kernel));
  console.log('\n  ratio warm/TRUE-cold  ' + (w / c).toFixed(2) + 'x   (want ≪1: steps 7-8 reuse the graph and');
  console.log('    re-search only the edited window; native reference is 123ms vs 750ms ≈ 0.16x)');
  console.log('  → warm ≈ cold would mean the app re-matches the WHOLE sketch when one point changed.');
  if (res.matchRepeat?.length) {
    const rp = med(res.matchRepeat.map((r) => r.kernel));
    console.log('  ratio warm/repeat     ' + (w / rp).toFixed(2) + 'x   (EXPECTED to be >1 — repeat changes');
    console.log('    NOTHING, so it is the floor, not a baseline. Do not read this one as a regression.)');
  }
}
if (globalThis.__db) {
  const db = globalThis.__db, dr = globalThis.__dr;
  const vk = med(res.runs.map((r) => r.kernel)), mk = med(res.matchCold.map((r) => r.kernel));
  if (res.renderBudget) {
  // PLAN-PERF §6 R. The point of this block is to REFEREE steps 14 and 15 before either is written:
  // 14 hoists projection out of the frame, 15 caches rasters — and they are bets on different halves.
  const rb = res.renderBudget;
  console.log('\n=== RENDER BUDGET — where one frame goes (median of ' + (process.env.PROFILE_RUNS || 6) + ') ===');
  const rows = Object.entries(rb.layers).sort((a, b) => b[1] - a[1]);
  for (const [k, v] of rows) {
    const n = rb.counts[k] ?? '';
    console.log('  ' + k.padEnd(12) + String(Math.round(v)).padStart(5) + ' ms  ' + (v / rb.total * 100).toFixed(0).padStart(3) + '%   ' + (n === '' ? '' : n + ' drawn'));
  }
  console.log('  ' + 'TOTAL'.padEnd(12) + String(Math.round(rb.total)).padStart(5) + ' ms');
  console.log('\n  projection alone ' + Math.round(rb.projection) + ' ms over ' + rb.verts + ' vertices'
    + '  = ' + (rb.projection / rb.total * 100).toFixed(0) + '% of the frame');
  console.log('    → this is the CEILING on step 14 (pre-project into typed arrays): hoisting projection');
  console.log('      out of the frame cannot save more than projection costs. The remainder is');
  console.log('      rasterisation, which is step 15 (cache per-tile rasters, blit on pan).');
}
console.log('\n=== ATTRIBUTION (each command minus the decode IT actually pays) ===');
  console.log('  view:  decode(both) ' + fmt(db) + ' + serialize ' + fmt(vk - db) + '  = kernel ' + fmt(vk));
  console.log('  match_true_cold: decode(roads)' + fmt(dr) + ' + compute ' + fmt(mk - dr) + '  = kernel ' + fmt(mk));
}
if (res.stats) {
  const ok = res.stats.starts === 1;
  console.log('\n=== SESSION (PLAN-PERF step 5: loft owns the loop) ===');
  console.log('  loft_start entered ' + res.stats.starts + 'x for ' + res.stats.commands + ' commands  ' +
              (ok ? '✅ one session' : '❌ NOT a session — state cannot survive'));
  const sl = res.stats.storeLoads;
  console.log('  store fetches: ' + sl + ' for ' + res.stats.commands + ' commands  ' +
              (sl <= 2 ? '✅ each store loaded ONCE (step 6)' : '❌ ' + sl + ' loads — the session is re-decoding'));
  console.log('    (pre-step-6 this was 2 per command: every click re-decoded a 20MB image)');
  if (res.stats.wasmBytes) console.log('  wasm memory: ' + (res.stats.wasmBytes / 1048576).toFixed(1) + ' MB working set');
}
if (res.stream) {
  const s = res.stream;
  console.log('\n=== STEP 16 · does the route ARRIVE progressively? (COLD — session dropped first) ===');
  console.log('  stretches emitted : ' + s.stretches);
  console.log('  match total       : ' + Math.round(s.total) + 'ms');
  console.log('  frames landed     : ' + s.frames + ' of ~' + s.expectedFrames + ' expected');
  console.log('  longest frozen gap: ' + Math.round(s.longestGap) + 'ms   ← was ~4212ms (one un-interruptible block)');
}
if (res.streamN?.length) {
  console.log('\n=== STEP 16 · progressive arrival vs SKETCH DENSITY (both COLD — same entry state) ===');
  console.log('  more points = more stretches = more yield points, so the freeze should break up.');
  console.log('  points  stretches   total   frames landed / expected   longest frozen gap');
  for (const s of res.streamN)
    console.log('   ' + String(s.n).padStart(4) + '   ' + String(s.stretches).padStart(6) + '   ' +
                String(Math.round(s.total)).padStart(6) + 'ms      ' + String(s.frames).padStart(4) + ' / ' +
                String(s.expectedFrames).padEnd(5) + '         ' + Math.round(s.longestGap) + 'ms');
}
if (res.block?.length) {
  console.log('\n=== MAIN-THREAD BLOCKING (is the UI alive while the kernel runs?) ===');
  console.log('  match = COLD (session dropped) · matchWarm = one point moved · each states its entry');
  console.log('  state, because a cold rebuild and a warm edit block for wildly different times.');
  for (const b of res.block) {
    console.log('  ' + b.kind.padEnd(10) + ' call ' + fmt(b.total) + 'ms · frames landed ' + String(b.frames).padStart(4) +
                ' of ~' + String(b.expectedFrames).padStart(4) + ' expected · longest frozen gap ' + fmt(b.longestGap) + 'ms');
  }
  console.log('  (a responsive app lands ~all expected frames with ~16ms gaps;');
  console.log('   a blocked one lands almost none and shows one gap ≈ the whole call)');
}
console.log('');
process.exit(0);
