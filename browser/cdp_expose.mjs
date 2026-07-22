// Copyright (c) 2026 Jurjen Stellingwerff
// SPDX-License-Identifier: LGPL-3.0-or-later
//
// PLAN-PERF §0 step 9's observable: does JS actually RECEIVE the layout handle?
//
// `expose(1, layout)` is invisible from loft's side — expose_value's body is
// #[cfg(target_arch = "wasm32")], so it is a silent no-op anywhere but here, and a silent no-op is
// exactly what fooled an earlier probe of mine into a filed-and-retracted finding. So the assertion
// lives where the call actually lands: the host import in browser/store-kernel.mjs, which records
// __exposeCalls / __exposeArgs and counts handles in stats().exposed.
//
// Asserts, in order of what each would catch:
//   * called ONCE — not zero (never fired), not per-view (the load guard leaked)
//   * descriptor PARSES — the JSON crossed intact and is not the {__parseError} fallback
//   * the address is real — storeBase/rec nonzero (rec == 0 is expose_value's early return)
//   * the hash was PRE-FLATTENED — @PLN105 Phase 3's collect_keyed ran, so the descriptor is not a
//     bare keyed node JS cannot walk. This is the claim I got wrong twice; assert it, don't argue it.
//   usage: node browser/cdp_expose.mjs <devtools host:port> <app url>
const [dt, app] = process.argv.slice(2);
const list = await (await fetch(`http://${dt}/json/list`)).json();
const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
let id = 0; const pending = new Map(); const errs = [];
const call = (m, p) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  else if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
});
await new Promise((r) => ws.addEventListener('open', r));
await call('Runtime.enable'); await call('Page.enable');
const ev = async (x) => {
  const r = await call('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) return { __err: JSON.stringify(r.result.exceptionDetails).slice(0, 300) };
  return r.result?.result?.value;
};
await call('Page.navigate', { url: app });
let st = null;
for (let i = 0; i < 200; i++) {
  await new Promise((r) => setTimeout(r, 500));
  const s = await ev('window.__storeApp?JSON.stringify(window.__storeApp):""');
  if (s) { st = JSON.parse(s); if (st.ready) break; }
}
if (!st?.ready) { console.log('  FAIL: app never became ready', JSON.stringify(st), errs.slice(-2)); process.exit(1); }

const seen = await ev(`JSON.stringify({
  calls: globalThis.__exposeCalls || 0,
  args:  globalThis.__exposeArgs || null,
  desc:  (() => { const h = window.__storeKernel?.exposedValue?.(1); return h ? JSON.stringify(h.desc).slice(0, 400) : null; })(),
})`);
const r = JSON.parse(seen || '{}');
const a = r.args || {};
const fail = [];
if (r.calls !== 1) fail.push(`expose called ${r.calls}x, want exactly 1 (0 = never fired; >1 = the load guard leaked)`);
if (!r.desc) fail.push('no descriptor for tag 1 — the host never stored the handle');
else if (r.desc.includes('__parseError')) fail.push(`descriptor did not parse: ${r.desc}`);
if (a.storeBase === '0' || !a.storeBase) fail.push(`storeBase is ${a.storeBase} — not a real address`);
if (a.rec === '0' || !a.rec) fail.push(`rec is ${a.rec} — expose_value early-returns when rec == 0, so the value never crossed`);
console.log(`  calls=${r.calls} tag=${a.tag} storeBase=${a.storeBase} rec=${a.rec} pos=${a.pos} typeId=${a.typeId} descLen=${a.descLen}`);
console.log(`  desc: ${(r.desc || '(none)').slice(0, 200)}`);
if (fail.length) { console.log('FAIL — ' + fail.join('\n  FAIL — ')); process.exit(1); }
console.log('PASS — JS holds a live layout handle: descriptor parsed + address delivered');
